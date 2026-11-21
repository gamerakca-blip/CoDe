import { ApiError, GoogleGenAI, type Content } from "@google/genai";
import { SYSTEM_PROMPT } from "../prompt.js";
import type { Provider } from "./types.js";

const BLOCKED_FINISH = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION", "IMAGE_SAFETY"]);

export function createGeminiProvider(): Provider {
  const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    ...(process.env.GEMINI_BASE_URL ? { httpOptions: { baseUrl: process.env.GEMINI_BASE_URL } } : {}),
  });
  const model = process.env.GEMINI_MODEL ?? "gemini-3.8-flash";

  return {
    id: "gemini",
    model,
    newHistory: (): Content[] => [],

    async runTurn({ history, text, plan, send, signal }) {
      const contents = history as Content[];
      const userMsg: Content = { role: "user", parts: [{ text }] };

      send("phase", { phase: "thinking" });
      const stream = await ai.models.generateContentStream({
        model,
        contents: [...contents, userMsg],
        config: {
          systemInstruction: SYSTEM_PROMPT,
          maxOutputTokens: plan.maxTokens,
          abortSignal: signal,
        },
      });

      let answer = "";
      let finish: string | undefined;
      let blocked: string | undefined;
      for await (const chunk of stream) {
        if (chunk.promptFeedback?.blockReason) blocked = String(chunk.promptFeedback.blockReason);
        const cand = chunk.candidates?.[0];
        if (cand?.finishReason) finish = String(cand.finishReason);
        const t = chunk.text;
        if (t) {
          if (!answer) send("phase", { phase: "writing" });
          answer += t;
          send("text", { text: t });
        }
      }

      if (blocked || (finish && BLOCKED_FINISH.has(finish))) {
        return { kind: "refusal", category: (blocked ?? finish ?? "").toLowerCase() || null };
      }
      contents.push(userMsg, { role: "model", parts: [{ text: answer }] });
      return { kind: "done", stopReason: finish === "MAX_TOKENS" ? "max_tokens" : "end_turn" };
    },

    describeError(err) {
      if (!(err instanceof ApiError)) return null;
      if (err.status === 400 && /api key/i.test(err.message)) return "Sunucunun Gemini API anahtarı geçersiz.";
      if (err.status === 401 || err.status === 403) return "Gemini API anahtarı geçersiz veya bu modele erişimi yok.";
      if (err.status === 404) return `Gemini modeli bulunamadı (${model}). GEMINI_MODEL ayarını kontrol et.`;
      if (err.status === 429) return "Gemini ücretsiz kullanım sınırına ulaşıldı. Biraz bekleyip tekrar dene.";
      if (err.status >= 500) return "Gemini tarafında geçici hata. Tekrar dene.";
      return `Gemini hatası (${err.status}): ${err.message}`;
    },
  };
}
