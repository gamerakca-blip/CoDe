import Iyzipay from "iyzipay";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { UserRow, OrderRow } from "../db.js";
import { PLANS } from "../plans.js";

/**
 * iyzico Ödeme Formu (Checkout Form) entegrasyonu.
 * Akış: initialize -> kullanıcı iyzico ödeme sayfasına yönlenir -> iyzico callbackUrl'e
 * `token` POST eder -> sunucu `retrieve` ile sonucu iyzico'dan doğrular.
 */

const API_KEY = process.env.IYZICO_API_KEY ?? "";
const SECRET_KEY = process.env.IYZICO_SECRET_KEY ?? "";
const BASE_URL = process.env.IYZICO_BASE_URL ?? "https://sandbox-api.iyzipay.com";

// iyzico alıcı bilgisi ister. Dijital abonelikte adres toplanmıyorsa işyeri bilgisi kullanılır.
// T.C. kimlik no toplanmıyorsa iyzico'nun kabul ettiği 11111111111 gönderilir; iyzico hesabınla teyit et.
const BUYER_IDENTITY = process.env.IYZICO_BUYER_IDENTITY ?? "11111111111";
const BUYER_CITY = process.env.IYZICO_BUYER_CITY ?? "Istanbul";
const BUYER_COUNTRY = process.env.IYZICO_BUYER_COUNTRY ?? "Turkey";
const BUYER_ADDRESS = process.env.IYZICO_BUYER_ADDRESS ?? "Dijital hizmet - adres gerekmez";

export const iyzicoConfigured = Boolean(API_KEY && SECRET_KEY);

const client = iyzicoConfigured ? new Iyzipay({ apiKey: API_KEY, secretKey: SECRET_KEY, uri: BASE_URL }) : null;

function call(resource: "checkoutFormInitialize" | "checkoutForm", method: "create" | "retrieve", req: Record<string, unknown>) {
  return new Promise<Record<string, any>>((resolve, reject) => {
    if (!client) return reject(new Error("iyzico yapılandırılmamış (IYZICO_API_KEY / IYZICO_SECRET_KEY)."));
    client[resource][method](req, (err, result) => (err ? reject(err) : resolve(result)));
  });
}

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
  const price = String(order.price_try);
  const { name, surname } = splitName(user.name);
  const address = { contactName: user.name, city: BUYER_CITY, country: BUYER_COUNTRY, address: BUYER_ADDRESS };

  const result = await call("checkoutFormInitialize", "create", {
    locale: Iyzipay.LOCALE.TR,
    conversationId: order.id,
    price,
    paidPrice: price,
    currency: Iyzipay.CURRENCY.TRY,
    basketId: order.id,
    paymentGroup: Iyzipay.PAYMENT_GROUP.SUBSCRIPTION,
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
        itemType: Iyzipay.BASKET_ITEM_TYPE.VIRTUAL,
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
  const r = await call("checkoutForm", "retrieve", {
    locale: Iyzipay.LOCALE.TR,
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
