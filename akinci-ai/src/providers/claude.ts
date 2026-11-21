import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT } from "../prompt.js";
import type { Provider } from "./types.js";

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

export function createClaudeProvider(): Provider {
  const client = new Anthropic();
  const model = process.env.AKINCI_MODEL ?? "claude-opus-5-5";

  return {
    id: "claude",
    model,
    newHistory: (): Anthropic.Beta.BetaMessageParam[] => [],

    async runTurn({ history, text, plan, send, signal }) {
      const messages = history as Anthropic.Beta.BetaMessageParam[];
      const userMsg: Anthropic.Beta.BetaMessageParam = { role: "user", content: text };

      const stream = client.beta.messages.stream(
        {
          model,
          max_tokens: plan.maxTokens,
          system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
          messages: [...messages, userMsg],
          output_config: { effort: plan.effort },
          cache_control: { type: "ephemeral" },
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        },
        { signal },
      );

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
        return { kind: "refusal", category: final.stop_details?.category ?? null };
      }
      messages.push(userMsg, { role: "assistant", content: contentForHistory(final.content) });
      return { kind: "done", stopReason: final.stop_reason };
    },

    describeError(err) {
      if (err instanceof Anthropic.AuthenticationError) return "Sunucunun Claude API anahtarı geçersiz veya eksik.";
      if (err instanceof Anthropic.PermissionDeniedError) return "Bu modele erişim izni yok.";
      if (err instanceof Anthropic.RateLimitError) return "Hız sınırına takıldı. Biraz bekleyip tekrar dene.";
      if (err instanceof Anthropic.BadRequestError) return `Geçersiz istek: ${err.message}`;
      if (err instanceof Anthropic.InternalServerError) return "Sağlayıcı tarafında geçici hata. Tekrar dene.";
      if (err instanceof Anthropic.APIConnectionError) return "Yapay zeka sunucusuna bağlanılamadı.";
      if (err instanceof Anthropic.APIError) return `API hatası (${err.status}): ${err.message}`;
      return null;
    },
  };
}
