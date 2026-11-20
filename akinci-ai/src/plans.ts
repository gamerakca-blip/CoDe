export type PlanId = "free" | "pro" | "full";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface Plan {
  id: PlanId;
  name: string;
  /** Aylık fiyat (TL). */
  priceTry: number;
  /** Günlük mesaj hakkı; null = sınırsız. */
  dailyMessages: number | null;
  effort: Effort;
  maxTokens: number;
  maxInputChars: number;
  features: string[];
}

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: "free",
    name: "Free",
    priceTry: 0,
    dailyMessages: 50,
    effort: "low",
    maxTokens: 8_000,
    maxInputChars: 4_000,
    features: ["Günde 50 mesaj", "Hızlı, kısa cevaplar", "Mesaj başına 4.000 karakter"],
  },
  pro: {
    id: "pro",
    name: "Pro",
    priceTry: 150,
    dailyMessages: 150,
    effort: "high",
    maxTokens: 64_000,
    maxInputChars: 32_000,
    features: ["Günde 150 mesaj", "Yüksek düşünme seviyesi", "Uzun kod ve cevaplar", "Mesaj başına 32.000 karakter"],
  },
  full: {
    id: "full",
    name: "Full",
    priceTry: 300,
    dailyMessages: null,
    effort: "max",
    maxTokens: 64_000,
    maxInputChars: 32_000,
    features: ["Sınırsız mesaj", "En yüksek düşünme seviyesi", "Uzun kod ve cevaplar", "Mesaj başına 32.000 karakter"],
  },
};

export const PAID_PLANS: PlanId[] = ["pro", "full"];
export const SUBSCRIPTION_DAYS = 30;

export function isPlanId(v: unknown): v is PlanId {
  return v === "free" || v === "pro" || v === "full";
}

/** Günlük kota için İstanbul saatine göre gün anahtarı (YYYY-MM-DD). */
export function todayKey(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Istanbul" }).format(now);
}
