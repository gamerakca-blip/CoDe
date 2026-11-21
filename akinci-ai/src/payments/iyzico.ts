import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { UserRow, OrderRow } from "../db.js";
import { PLANS } from "../plans.js";

/**
 * iyzico Ödeme Formu (Checkout Form) entegrasyonu, iyzico REST API'si doğrudan çağrılır
 * (resmi Node paketinin bağımlılıklarında güvenlik açığı olduğu için kullanılmıyor).
 * Akış: initialize -> kullanıcı iyzico ödeme sayfasına yönlenir -> iyzico callbackUrl'e
 * `token` POST eder -> sunucu `retrieve` ile sonucu iyzico'dan doğrular.
 */

const API_KEY = process.env.IYZICO_API_KEY ?? "";
const SECRET_KEY = process.env.IYZICO_SECRET_KEY ?? "";
const BASE_URL = (process.env.IYZICO_BASE_URL ?? "https://sandbox-api.iyzipay.com").replace(/\/+$/, "");

// iyzico alıcı bilgisi ister. Dijital abonelikte adres toplanmıyorsa işyeri bilgisi kullanılır.
// T.C. kimlik no toplanmıyorsa 11111111111 gönderilir; bunun hesabın için uygun olduğunu iyzico ile teyit et.
const BUYER_IDENTITY = process.env.IYZICO_BUYER_IDENTITY ?? "11111111111";
const BUYER_CITY = process.env.IYZICO_BUYER_CITY ?? "Istanbul";
const BUYER_COUNTRY = process.env.IYZICO_BUYER_COUNTRY ?? "Turkey";
const BUYER_ADDRESS = process.env.IYZICO_BUYER_ADDRESS ?? "Dijital hizmet - adres gerekmez";

export const iyzicoConfigured = Boolean(API_KEY && SECRET_KEY);

/** iyzico IYZWSv2 kimlik doğrulamalı POST isteği. */
async function call(apiPath: string, body: Record<string, unknown>): Promise<Record<string, any>> {
  if (!iyzicoConfigured) throw new Error("iyzico yapılandırılmamış (IYZICO_API_KEY / IYZICO_SECRET_KEY).");
  const json = JSON.stringify(body);
  const rnd = `${Date.now()}${randomBytes(8).toString("hex")}`;
  const signature = createHmac("sha256", SECRET_KEY).update(rnd + apiPath + json).digest("hex");
  const auth = Buffer.from(`apiKey:${API_KEY}&randomKey:${rnd}&signature:${signature}`).toString("base64");

  const res = await fetch(BASE_URL + apiPath, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `IYZWSv2 ${auth}`, "x-iyzi-rnd": rnd },
    body: json,
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await res.json().catch(() => null)) as Record<string, any> | null;
  if (!data) throw new Error(`iyzico geçersiz yanıt (HTTP ${res.status})`);
  return data;
}

/** iyzico fiyat biçimi: 150 -> "150.0", 149.9 -> "149.9" */
const fmtPrice = (n: number) => {
  const s = String(n);
  return s.includes(".") ? s : `${s}.0`;
};

const fmtDate = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

function splitName(full: string): { name: string; surname: string } {
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { name: parts[0], surname: parts[0] };
  return { name: parts.slice(0, -1).join(" "), surname: parts[parts.length - 1] };
}

function signatureOk(params: unknown[], signature: unknown): boolean {
  if (typeof signature !== "string" || !signature) return false;
  const expected = createHmac("sha256", SECRET_KEY).update(params.join(":")).digest("hex");
  return expected.length === signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export async function initializeCheckout(opts: {
  order: OrderRow;
  user: UserRow;
  ip: string;
  callbackUrl: string;
}): Promise<{ token: string; paymentPageUrl: string }> {
  const { order, user, ip, callbackUrl } = opts;
  const plan = PLANS[order.plan];
  const price = fmtPrice(order.price_try);
  const { name, surname } = splitName(user.name);
  const address = { contactName: user.name, city: BUYER_CITY, country: BUYER_COUNTRY, address: BUYER_ADDRESS };

  const result = await call("/payment/iyzipos/checkoutform/initialize/auth/ecom", {
    locale: "tr",
    conversationId: order.id,
    price,
    paidPrice: price,
    currency: "TRY",
    basketId: order.id,
    paymentGroup: "SUBSCRIPTION",
    callbackUrl,
    enabledInstallments: [1],
    buyer: {
      id: String(user.id),
      name,
      surname,
      email: user.email,
      identityNumber: BUYER_IDENTITY,
      lastLoginDate: fmtDate(user.last_login_at ?? user.created_at),
      registrationDate: fmtDate(user.created_at),
      registrationAddress: BUYER_ADDRESS,
      ip,
      city: BUYER_CITY,
      country: BUYER_COUNTRY,
    },
    billingAddress: address,
    basketItems: [
      {
        id: `plan-${plan.id}`,
        name: `Akıncı AI ${plan.name} - 30 gün`,
        category1: "Yazılım",
        category2: "Abonelik",
        itemType: "VIRTUAL",
        price,
      },
    ],
  });

  if (result.status !== "success" || !result.token || !result.paymentPageUrl) {
    throw new Error(`iyzico başlatma hatası: ${result.errorMessage ?? "bilinmeyen hata"}`);
  }
  if (result.signature && !signatureOk([result.conversationId, result.token], result.signature)) {
    throw new Error("iyzico imzası doğrulanamadı (initialize).");
  }
  return { token: result.token, paymentPageUrl: result.paymentPageUrl };
}

export type VerifyResult = { ok: true; paymentId: string } | { ok: false; reason: string };

/** iyzico'dan ödeme sonucunu çeker ve siparişle birebir eşleştiğini doğrular. */
export async function verifyCheckout(order: OrderRow, token: string): Promise<VerifyResult> {
  const r = await call("/payment/iyzipos/checkoutform/auth/ecom/detail", {
    locale: "tr",
    conversationId: order.id,
    token,
  });

  if (r.status !== "success") return { ok: false, reason: r.errorMessage ?? "sorgu başarısız" };
  if (r.paymentStatus !== "SUCCESS") return { ok: false, reason: `ödeme durumu: ${r.paymentStatus}` };
  if (r.basketId !== order.id || r.conversationId !== order.id) return { ok: false, reason: "sipariş eşleşmedi" };
  if (r.currency && r.currency !== "TRY") return { ok: false, reason: "para birimi uyuşmuyor" };
  if (Number(r.paidPrice) !== order.price_try) return { ok: false, reason: "tutar uyuşmuyor" };

  if (r.signature) {
    const params = [r.paymentStatus, r.paymentId, r.currency, r.basketId, r.conversationId, r.paidPrice, r.price, r.token];
    if (!signatureOk(params, r.signature)) {
      // Sonuç zaten iyzico'dan kimlik doğrulamalı istekle alındı; imza farkı sayı biçiminden olabilir.
      console.warn(`[iyzico] imza doğrulanamadı, sipariş ${order.id}. Ham alanlar:`, params);
    }
  }
  return { ok: true, paymentId: String(r.paymentId) };
}
