import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { NextFunction, Request, Response } from "express";
import { sessions, type UserRow } from "./db.js";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

const COOKIE = "akinci_sid";
const SESSION_DAYS = 30;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, saltB64, keyB64] = stored.split("$");
  if (algo !== "scrypt" || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, "base64");
  const actual = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length);
  return timingSafeEqual(expected, actual);
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

function cookieAttrs(req: Request, maxAgeSec: number): string {
  const secure = process.env.COOKIE_SECURE === "true" || req.secure;
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? "; Secure" : ""}`;
}

export function startSession(req: Request, res: Response, userId: number): void {
  const token = randomBytes(32).toString("base64url");
  sessions.create(hashToken(token), userId, Date.now() + SESSION_DAYS * 86_400_000);
  res.setHeader("Set-Cookie", `${COOKIE}=${token}; ${cookieAttrs(req, SESSION_DAYS * 86_400)}`);
}

export function endSession(req: Request, res: Response): void {
  const token = readCookie(req, COOKIE);
  if (token) sessions.delete(hashToken(token));
  res.setHeader("Set-Cookie", `${COOKIE}=; ${cookieAttrs(req, 0)}`);
}

export function currentUser(req: Request): UserRow | undefined {
  const token = readCookie(req, COOKIE);
  return token ? sessions.user(hashToken(token)) : undefined;
}

declare module "express-serve-static-core" {
  interface Request {
    user?: UserRow;
  }
}

export function requireUser(req: Request, res: Response, next: NextFunction): void {
  const user = currentUser(req);
  if (!user) {
    res.status(401).json({ error: "Giriş yapman gerekiyor.", code: "auth_required" });
    return;
  }
  req.user = user;
  next();
}

/** Basit bellek içi sabit pencere hız sınırlayıcı. */
export function rateLimit(opts: { windowMs: number; max: number; key: (req: Request) => string; message: string }) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, opts.windowMs).unref();

  return (req: Request, res: Response, next: NextFunction) => {
    const k = opts.key(req);
    const now = Date.now();
    const entry = hits.get(k);
    if (!entry || entry.resetAt <= now) {
      hits.set(k, { count: 1, resetAt: now + opts.windowMs });
      return next();
    }
    if (++entry.count > opts.max) {
      res.setHeader("Retry-After", Math.ceil((entry.resetAt - now) / 1000));
      res.status(429).json({ error: opts.message });
      return;
    }
    next();
  };
}

/** Başka siteden gelen POST isteklerini reddeder (CSRF'e karşı ek katman). */
export function sameOrigin(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (req.method === "POST" && origin) {
    let ok = false;
    try {
      ok = new URL(origin).host === req.headers.host;
    } catch {}
    if (!ok) {
      res.status(403).json({ error: "Geçersiz kaynak." });
      return;
    }
  }
  next();
}
