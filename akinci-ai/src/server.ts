import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import Anthropic from "@anthropic-ai/sdk";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SYSTEM_PROMPT } from "./prompt.js";
import { PAID_PLANS, PLANS, isPlanId, todayKey } from "./plans.js";
import { effectivePlan, orders, sessions as dbSessions, usage, users, type UserRow } from "./db.js";
import { currentUser, endSession, hashPassword, rateLimit, requireUser, sameOrigin, startSession, verifyPassword } from "./auth.js";
import { iyzicoConfigured, initializeCheckout, verifyCheckout } from "./payments/iyzico.js";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const MODEL = process.env.AKINCI_MODEL ?? "claude-opus-5-5";
const PAYMENT_MODE = process.env.PAYMENT_MODE === "demo" ? "demo" : "iyzico";
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL ?? process.env.RENDER_EXTERNAL_URL)?.replace(/\/+$/, "");
const CHAT_TTL_MS = 6 * 60 * 60 * 1000;

// Site sahibi: bu e-postalar herkese açık kayıtla alınamaz; yalnızca OWNER_SIGNUP_CODE ile kaydolur ve süresiz Full alır.
const OWNER_EMAILS = new Set(
  (process.env.OWNER_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean),
);
const OWNER_SIGNUP_CODE = process.env.OWNER_SIGNUP_CODE ?? "";

function secretEquals(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

const client = new Anthropic();

// ---------- sohbet oturumları (bellekte) ----------
interface ChatSession {
  userId: number;
  messages: Anthropic.Beta.BetaMessageParam[];
  busy: boolean;
  touchedAt: number;
}
const chats = new Map<string, ChatSession>();

setInterval(() => {
  const cutoff = Date.now() - CHAT_TTL_MS;
  for (const [id, s] of chats) if (!s.busy && s.touchedAt < cutoff) chats.delete(id);
  dbSessions.purge();
}, 10 * 60 * 1000).unref();

/**
 * After a server-side fallback, model-internal blocks that precede the last
 * `fallback` block must not be echoed back; the fallback block itself stays
 * in place. Everything after it is kept as-is.
 */
function contentForHistory(content: Anthropic.Beta.BetaContentBlock[]): Anthropic.Beta.BetaContentBlockParam[] {
  let lastFallback = -1;
  content.forEach((b, i) => {
    if (b.type === "fallback") lastFallback = i;
  });
  return content.filter((b, i) => i >= lastFallback || b.type === "text" || b.type === "fallback") as
    Anthropic.Beta.BetaContentBlockParam[];
}

function accountView(user: UserRow) {
  const { plan, expiresAt } = effectivePlan(user);
  return {
    user: { email: user.email, name: user.name, role: user.role },
    plan: { id: plan.id, name: user.role === "owner" ? `${plan.name} · Sahip` : plan.name, expiresAt },
    usage: { used: usage.get(user.id, todayKey()), limit: plan.dailyMessages },
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------- uygulama ----------
const app = express();
if (process.env.TRUST_PROXY) app.set("trust proxy", process.env.TRUST_PROXY);
app.disable("x-powered-by");

const httpsOnly = process.env.COOKIE_SECURE === "true";
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        fontSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        manifestSrc: ["'self'"],
        workerSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        ...(httpsOnly ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    strictTransportSecurity: httpsOnly ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  }),
);

app.get("/healthz", (_req, res) => res.json({ ok: true }));

const here = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(here, "..", "public")));

const hljsDir = path.join(here, "..", "node_modules", "@highlightjs", "cdn-assets");
app.get("/vendor/highlight.min.js", (_req, res) => res.sendFile(path.join(hljsDir, "highlight.min.js")));
app.get("/vendor/hljs-theme.css", (_req, res) => res.sendFile(path.join(hljsDir, "styles", "github-dark.min.css")));

// iyzico geri dönüşü form-urlencoded POST'tur ve iyzico alan adından gelir; sameOrigin'den önce tanımlı.
const callbackLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  key: (req) => `cb:${req.ip}`,
  message: "Çok fazla istek.",
});
app.post("/api/payment/iyzico/callback", callbackLimiter, express.urlencoded({ extended: false, limit: "16kb" }), async (req, res) => {
  const token = String(req.body?.token ?? "");
  const order = token ? orders.byToken(token) : undefined;
  if (!order) {
    res.redirect(303, "/?odeme=hata");
    return;
  }
  if (order.status === "paid") {
    res.redirect(303, `/?odeme=ok&plan=${order.plan}`);
    return;
  }
  try {
    const result = await verifyCheckout(order, token);
    if (!result.ok) {
      console.warn(`[iyzico] sipariş ${order.id} başarısız: ${result.reason}`);
      orders.markFailed(order.id);
      res.redirect(303, "/?odeme=hata");
      return;
    }
    orders.fulfill(order, result.paymentId);
    res.redirect(303, `/?odeme=ok&plan=${order.plan}`);
  } catch (err) {
    console.error("[iyzico] doğrulama hatası:", err);
    res.redirect(303, "/?odeme=hata");
  }
});

app.use("/api", sameOrigin, express.json({ limit: "256kb" }));

app.get("/api/info", (_req, res) => {
  res.json({ model: MODEL, paymentMode: PAYMENT_MODE, paymentReady: PAYMENT_MODE === "demo" || iyzicoConfigured });
});

app.get("/api/plans", (_req, res) => {
  res.json({
    plans: Object.values(PLANS).map((p) => ({
      id: p.id,
      name: p.name,
      priceTry: p.priceTry,
      dailyMessages: p.dailyMessages,
      features: p.features,
    })),
  });
});

// ---------- hesap ----------
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  key: (req) => `auth:${req.ip}`,
  message: "Çok fazla deneme. 15 dakika sonra tekrar dene.",
});

app.post("/api/auth/register", authLimiter, async (req: Request, res: Response) => {
  const name = String(req.body?.name ?? "").trim().slice(0, 80);
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const password = String(req.body?.password ?? "");

  if (name.length < 2) return void res.status(400).json({ error: "Ad soyad gir." });
  if (!EMAIL_RE.test(email) || email.length > 254) return void res.status(400).json({ error: "Geçerli bir e-posta gir." });
  if (password.length < 8 || password.length > 200) return void res.status(400).json({ error: "Şifre en az 8 karakter olmalı." });
  if (users.byEmail(email)) return void res.status(409).json({ error: "Bu e-posta zaten kayıtlı." });

  let role: "user" | "owner" = "user";
  if (OWNER_EMAILS.has(email)) {
    const code = String(req.body?.ownerCode ?? "");
    if (!OWNER_SIGNUP_CODE) {
      return void res.status(403).json({ error: "Bu e-posta site sahibine ayrılmış. Sunucuda OWNER_SIGNUP_CODE ayarlanmalı." });
    }
    if (!code) {
      return void res.status(403).json({ error: "Bu hesap için sahip kodu gerekli.", code: "owner_code_required" });
    }
    if (!secretEquals(code, OWNER_SIGNUP_CODE)) {
      return void res.status(403).json({ error: "Sahip kodu hatalı.", code: "owner_code_required" });
    }
    role = "owner";
  }

  const user = users.create(email, name, await hashPassword(password), role);
  users.touchLogin(user.id);
  startSession(req, res, user.id);
  res.json(accountView(user));
});

const loginEmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  key: (req) => `login:${String(req.body?.email ?? "").trim().toLowerCase()}`,
  message: "Bu hesap için çok fazla hatalı deneme. 15 dakika sonra tekrar dene.",
});

app.post("/api/auth/login", authLimiter, loginEmailLimiter, async (req: Request, res: Response) => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const password = String(req.body?.password ?? "");
  const user = users.byEmail(email);
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    res.status(401).json({ error: "E-posta veya şifre hatalı." });
    return;
  }
  users.touchLogin(user.id);
  startSession(req, res, user.id);
  res.json(accountView(user));
});

app.post("/api/auth/password", requireUser, authLimiter, async (req: Request, res: Response) => {
  const user = req.user!;
  const current = String(req.body?.current ?? "");
  const next = String(req.body?.next ?? "");
  if (!(await verifyPassword(current, user.password_hash))) {
    return void res.status(401).json({ error: "Mevcut şifre hatalı." });
  }
  if (next.length < 8 || next.length > 200) return void res.status(400).json({ error: "Yeni şifre en az 8 karakter olmalı." });
  users.setPassword(user.id, await hashPassword(next));
  users.revokeSessions(user.id); // diğer cihazlardaki oturumlar kapanır
  startSession(req, res, user.id);
  res.json({ ok: true });
});

app.post("/api/auth/logout", (req, res) => {
  endSession(req, res);
  res.json({ ok: true });
});

app.get("/api/me", (req, res) => {
  const user = currentUser(req);
  res.json(user ? accountView(user) : null);
});

// ---------- abonelik ----------
app.post("/api/checkout", requireUser, async (req: Request, res: Response) => {
  const planId = req.body?.plan;
  if (!isPlanId(planId) || !PAID_PLANS.includes(planId)) {
    res.status(400).json({ error: "Geçersiz plan." });
    return;
  }
  const user = req.user!;
  if (user.role === "owner") return void res.status(400).json({ error: "Sahip hesabında Full plan zaten süresiz açık." });
  if (req.body?.accept !== true) {
    return void res.status(400).json({ error: "Mesafeli satış sözleşmesini onaylaman gerekiyor." });
  }
  const plan = PLANS[planId];
  const orderId = `AK${Date.now()}${randomUUID().slice(0, 8)}`;
  orders.create(orderId, user.id, plan.id, plan.priceTry);

  if (PAYMENT_MODE === "demo") {
    // Yalnızca geliştirme içindir: ödeme alınmadan plan açılır.
    orders.fulfill(orders.byId(orderId)!, "demo");
    res.json({ url: `/?odeme=ok&plan=${plan.id}` });
    return;
  }
  if (!iyzicoConfigured) {
    res.status(503).json({ error: "Ödeme sistemi henüz yapılandırılmadı." });
    return;
  }

  const base = PUBLIC_BASE_URL ?? `${req.protocol}://${req.get("host")}`;
  try {
    const { token, paymentPageUrl } = await initializeCheckout({
      order: orders.byId(orderId)!,
      user,
      ip: req.ip ?? "127.0.0.1",
      callbackUrl: `${base}/api/payment/iyzico/callback`,
    });
    orders.setToken(orderId, token);
    res.json({ url: paymentPageUrl });
  } catch (err) {
    console.error("[iyzico] başlatma hatası:", err);
    orders.markFailed(orderId);
    res.status(502).json({ error: "Ödeme sayfası açılamadı. Biraz sonra tekrar dene." });
  }
});

// ---------- sohbet ----------
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 12,
  key: (req) => `chat:${req.user?.id ?? req.ip}`,
  message: "Çok hızlı mesaj gönderiyorsun. Bir dakika bekle.",
});

app.post("/api/session", requireUser, (req, res) => {
  const id = randomUUID();
  chats.set(id, { userId: req.user!.id, messages: [], busy: false, touchedAt: Date.now() });
  res.json({ sessionId: id });
});

app.post("/api/reset", requireUser, (req, res) => {
  const chat = chats.get(String(req.body?.sessionId ?? ""));
  if (chat && chat.userId === req.user!.id && !chat.busy) chats.delete(String(req.body.sessionId));
  res.json({ ok: true });
});

app.post("/api/chat", requireUser, chatLimiter, async (req: Request, res: Response) => {
  const user = req.user!;
  const { plan } = effectivePlan(user);
  const chat = chats.get(String(req.body?.sessionId ?? ""));
  const text = String(req.body?.message ?? "").trim();

  if (!chat || chat.userId !== user.id) {
    res.status(404).json({ error: "Sohbet bulunamadı. Yeni sohbet başlat.", code: "no_session" });
    return;
  }
  if (!text) return void res.status(400).json({ error: "Mesaj boş olamaz." });
  if (text.length > plan.maxInputChars) {
    res.status(413).json({
      error: `${plan.name} planında mesaj en fazla ${plan.maxInputChars.toLocaleString("tr-TR")} karakter olabilir.`,
      code: "too_long",
    });
    return;
  }
  if (chat.busy) return void res.status(409).json({ error: "Önceki cevap henüz bitmedi." });

  const day = todayKey();
  if (!usage.consume(user.id, day, plan.dailyMessages)) {
    res.status(402).json({
      error: `${plan.name} planının günlük ${plan.dailyMessages} mesaj hakkı doldu.`,
      code: "quota_exceeded",
    });
    return;
  }

  chat.busy = true;
  chat.touchedAt = Date.now();
  chat.messages.push({ role: "user", content: text });

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (event: string, data: unknown) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: plan.maxTokens,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: chat.messages,
    output_config: { effort: plan.effort },
    cache_control: { type: "ephemeral" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  });

  let clientGone = false;
  res.on("close", () => {
    if (!res.writableFinished) {
      clientGone = true;
      stream.abort();
    }
  });

  const quota = () => ({ used: usage.get(user.id, day), limit: plan.dailyMessages });

  try {
    for await (const event of stream) {
      if (event.type === "content_block_start") {
        const kind = event.content_block.type;
        if (kind === "thinking" || kind === "redacted_thinking") send("phase", { phase: "thinking" });
        else if (kind === "text") send("phase", { phase: "writing" });
        else if (kind === "fallback") send("fallback", { to: event.content_block.to.model });
      } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        send("text", { text: event.delta.text });
      }
    }

    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") {
      chat.messages.pop();
      usage.refund(user.id, day);
      send("refusal", { category: final.stop_details?.category ?? null, quota: quota() });
    } else {
      chat.messages.push({ role: "assistant", content: contentForHistory(final.content) });
      send("done", { stopReason: final.stop_reason, quota: quota() });
    }
  } catch (err) {
    chat.messages.pop();
    if (!clientGone) {
      // Sağlayıcı kaynaklı hatada hak iade edilir; kullanıcının durdurduğu tur sayılır.
      usage.refund(user.id, day);
      console.error(err);
      send("error", { message: describeError(err), quota: quota() });
    }
  } finally {
    chat.busy = false;
    if (!res.writableEnded) res.end();
  }
});

// ---------- yasal sayfalar ----------
const SELLER: Record<string, string> = {
  SELLER_NAME: process.env.SELLER_NAME ?? "[Satıcı adı / unvanı]",
  SELLER_ADDRESS: process.env.SELLER_ADDRESS ?? "[Satıcı adresi]",
  SELLER_EMAIL: process.env.SELLER_EMAIL ?? "[İletişim e-postası]",
  SELLER_PHONE: process.env.SELLER_PHONE ?? "[Telefon]",
  SELLER_TAX: process.env.SELLER_TAX ?? "[Vergi dairesi / vergi no]",
  SITE_URL: PUBLIC_BASE_URL ?? "[Site adresi]",
};
const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const LEGAL_PAGES = new Set(["mesafeli-satis", "iade", "gizlilik", "iletisim"]);
const legalCache = new Map<string, string>();

app.get("/yasal/:page", (req, res, next) => {
  const page = String(req.params.page);
  if (!LEGAL_PAGES.has(page)) return next();
  let html = legalCache.get(page);
  if (!html) {
    const tpl = readFileSync(path.join(here, "..", "legal", `${page}.html`), "utf8");
    html = tpl.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => escapeHtml(SELLER[k] ?? ""));
    legalCache.set(page, html);
  }
  res.type("html").send(html);
});

app.use("/api", (_req, res) => res.status(404).json({ error: "Bulunamadı." }));

// Beklenmeyen hatalarda iç ayrıntı istemciye sızmaz.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = (err as { status?: number })?.status;
  if (status && status >= 400 && status < 500) {
    res.status(status).json({ error: "Geçersiz istek." });
    return;
  }
  console.error(err);
  res.status(500).json({ error: "Sunucu hatası." });
});

function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "Sunucunun API anahtarı geçersiz veya eksik.";
  if (err instanceof Anthropic.PermissionDeniedError) return "Bu modele erişim izni yok.";
  if (err instanceof Anthropic.RateLimitError) return "Hız sınırına takıldı. Biraz bekleyip tekrar dene.";
  if (err instanceof Anthropic.BadRequestError) return `Geçersiz istek: ${err.message}`;
  if (err instanceof Anthropic.InternalServerError) return "Sağlayıcı tarafında geçici hata. Tekrar dene.";
  if (err instanceof Anthropic.APIConnectionError) return "Sunucuya bağlanılamadı.";
  if (err instanceof Anthropic.APIError) return `API hatası (${err.status}): ${err.message}`;
  return "Beklenmeyen bir hata oluştu.";
}

app.listen(PORT, HOST, () => {
  console.log(`Akıncı AI hazır: http://localhost:${PORT}  (model: ${MODEL}, ödeme: ${PAYMENT_MODE})`);
  for (const nets of Object.values(networkInterfaces())) {
    for (const n of nets ?? []) {
      if (n.family === "IPv4" && !n.internal) console.log(`  Telefondan (aynı Wi-Fi): http://${n.address}:${PORT}`);
    }
  }
  for (const email of OWNER_EMAILS) {
    const u = users.byEmail(email);
    if (u && u.role !== "owner") console.warn(`  UYARI: ${email} sıradan kullanıcı olarak kayıtlı; sahip yetkisi verilmedi.`);
    if (!u && !OWNER_SIGNUP_CODE) console.warn(`  UYARI: ${email} sahip hesabı için OWNER_SIGNUP_CODE ayarlanmamış.`);
  }
  if (PAYMENT_MODE === "demo") console.warn("  UYARI: PAYMENT_MODE=demo — planlar ödeme alınmadan açılır. Canlıda kullanma.");
  else if (!iyzicoConfigured) console.warn("  UYARI: IYZICO_API_KEY / IYZICO_SECRET_KEY eksik — satın alma kapalı.");
});
