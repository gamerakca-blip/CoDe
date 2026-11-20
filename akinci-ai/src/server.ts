import express, { type Request, type Response } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
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
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL?.replace(/\/+$/, "");
const CHAT_TTL_MS = 6 * 60 * 60 * 1000;

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
    user: { email: user.email, name: user.name },
    plan: { id: plan.id, name: plan.name, expiresAt },
    usage: { used: usage.get(user.id, todayKey()), limit: plan.dailyMessages },
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------- uygulama ----------
const app = express();
if (process.env.TRUST_PROXY) app.set("trust proxy", process.env.TRUST_PROXY);
app.disable("x-powered-by");

const here = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(here, "..", "public")));

const hljsDir = path.join(here, "..", "node_modules", "@highlightjs", "cdn-assets");
app.get("/vendor/highlight.min.js", (_req, res) => res.sendFile(path.join(hljsDir, "highlight.min.js")));
app.get("/vendor/hljs-theme.css", (_req, res) => res.sendFile(path.join(hljsDir, "styles", "github-dark.min.css")));

// iyzico geri dönüşü form-urlencoded POST'tur ve iyzico alan adından gelir; sameOrigin'den önce tanımlı.
app.post("/api/payment/iyzico/callback", express.urlencoded({ extended: false, limit: "16kb" }), async (req, res) => {
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

  const user = users.create(email, name, await hashPassword(password));
  users.touchLogin(user.id);
  startSession(req, res, user.id);
  res.json(accountView(user));
});

app.post("/api/auth/login", authLimiter, async (req: Request, res: Response) => {
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
  if (PAYMENT_MODE === "demo") console.warn("  UYARI: PAYMENT_MODE=demo — planlar ödeme alınmadan açılır. Canlıda kullanma.");
  else if (!iyzicoConfigured) console.warn("  UYARI: IYZICO_API_KEY / IYZICO_SECRET_KEY eksik — satın alma kapalı.");
});
