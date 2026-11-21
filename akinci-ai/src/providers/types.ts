import type { Plan } from "../plans.js";

export type SendFn = (event: string, data: unknown) => void;

export type TurnResult =
  | { kind: "done"; stopReason: string | null }
  | { kind: "refusal"; category: string | null };

export interface Provider {
  id: "claude" | "gemini";
  model: string;
  /** Yeni boş sohbet geçmişi. */
  newHistory(): unknown;
  /**
   * Bir turu akışla çalıştırır. Geçmişe kullanıcı ve asistan mesajını yalnızca başarılı turda ekler;
   * ret, hata veya iptalde geçmiş değişmez.
   */
  runTurn(opts: { history: any; text: string; plan: Plan; send: SendFn; signal: AbortSignal }): Promise<TurnResult>;
  /** Sağlayıcı hatasını kullanıcıya gösterilecek Türkçe metne çevirir; tanımıyorsa null. */
  describeError(err: unknown): string | null;
}
