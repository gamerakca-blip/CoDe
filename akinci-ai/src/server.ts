import express, { type Request, type Response } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

const PORT = Number(process.env.PORT ?? 3000);
const MODEL = process.env.AKINCI_MODEL ?? "claude-opus-5-5";
const EFFORT = (process.env.AKINCI_EFFORT ?? "medium") as Effort;
const MAX_MESSAGE_CHARS = 32_000;
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;

const SYSTEM_PROMPT = `Sen Akıncı AI'sın: hızlı, net ve güvenilir bir yapay zeka asistanısın.
- Kullanıcı hangi dilde yazıyorsa o dilde cevap ver; varsayılan dil Türkçe.
- Doğrudan cevaba gir. Gereksiz giriş ve kapanış cümlesi kurma.
- Emin olmadığın bilgide bunu açıkça söyle, uydurma.
- Kod, liste ve başlıklar için Markdown kullan; kod bloklarında dil etiketi belirt.`;

const client = new Anthropic();

interface Session {
  messages: Anthropic.Beta.BetaMessageParam[];
  busy: boolean;
  touchedAt: number;
}

const sessions = new Map<string, Session>();

function getSession(id: string): Session {
  let session = sessions.get(id);
  if (!session) {
    session = { messages: [], busy: false, touchedAt: Date.now() };
    sessions.set(id, session);
  }
  session.touchedAt = Date.now();
  return session;
}

setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, s] of sessions) {
    if (!s.busy && s.touchedAt < cutoff) sessions.delete(id);
  }
}, 10 * 60 * 1000).unref();

/**
 * After a server-side fallback, model-internal blocks that precede the last
 * `fallback` block must not be echoed back; the fallback block itself stays
 * in place. Everything after it is kept as-is.
 */
function contentForHistory(
  content: Anthropic.Beta.BetaContentBlock[],
): Anthropic.Beta.BetaContentBlockParam[] {
  let lastFallback = -1;
  content.forEach((b, i) => {
    if (b.type === "fallback") lastFallback = i;
  });
  return content.filter((b, i) => {
    if (i >= lastFallback) return true;
    return b.type === "text" || b.type === "fallback";
  }) as Anthropic.Beta.BetaContentBlockParam[];
}

const app = express();
app.use(express.json({ limit: "256kb" }));

const here = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(here, "..", "public")));

app.get("/api/info", (_req: Request, res: Response) => {
  res.json({ model: MODEL, effort: EFFORT });
});

app.post("/api/session", (_req: Request, res: Response) => {
  const id = randomUUID();
  getSession(id);
  res.json({ sessionId: id });
});

app.post("/api/reset", (req: Request, res: Response) => {
  const id = String(req.body?.sessionId ?? "");
  const s = sessions.get(id);
  if (s && !s.busy) s.messages = [];
  res.json({ ok: true });
});

app.post("/api/chat", async (req: Request, res: Response) => {
  const sessionId = String(req.body?.sessionId ?? "");
  const text = String(req.body?.message ?? "").trim();

  if (!sessionId || !text) {
    res.status(400).json({ error: "sessionId ve message gerekli." });
    return;
  }
  if (text.length > MAX_MESSAGE_CHARS) {
    res.status(413).json({ error: `Mesaj ${MAX_MESSAGE_CHARS} karakteri aşamaz.` });
    return;
  }

  const session = getSession(sessionId);
  if (session.busy) {
    res.status(409).json({ error: "Önceki cevap henüz bitmedi." });
    return;
  }
  session.busy = true;
  session.messages.push({ role: "user", content: text });

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
    max_tokens: 64000,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: session.messages,
    output_config: { effort: EFFORT },
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
      // Whole fallback chain declined: drop the turn so the conversation stays valid.
      session.messages.pop();
      send("refusal", { category: final.stop_details?.category ?? null });
    } else {
      session.messages.push({ role: "assistant", content: contentForHistory(final.content) });
      send("done", { stopReason: final.stop_reason, model: final.model, usage: final.usage });
    }
  } catch (err) {
    session.messages.pop();
    if (!clientGone) {
      console.error(err);
      send("error", { message: describeError(err) });
    }
  } finally {
    session.busy = false;
    if (!res.writableEnded) res.end();
  }
});

function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "API anahtarı geçersiz veya eksik (ANTHROPIC_API_KEY).";
  if (err instanceof Anthropic.PermissionDeniedError) return "Bu modele erişim izni yok.";
  if (err instanceof Anthropic.RateLimitError) return "Hız sınırına takıldı. Biraz bekleyip tekrar dene.";
  if (err instanceof Anthropic.BadRequestError) return `Geçersiz istek: ${err.message}`;
  if (err instanceof Anthropic.InternalServerError) return "Sağlayıcı tarafında geçici hata. Tekrar dene.";
  if (err instanceof Anthropic.APIConnectionError) return "Sunucuya bağlanılamadı.";
  if (err instanceof Anthropic.APIError) return `API hatası (${err.status}): ${err.message}`;
  return "Beklenmeyen bir hata oluştu.";
}

app.listen(PORT, () => {
  console.log(`Akıncı AI hazır: http://localhost:${PORT}  (model: ${MODEL}, effort: ${EFFORT})`);
});
