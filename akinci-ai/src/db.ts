import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { PLANS, SUBSCRIPTION_DAYS, type Plan, type PlanId } from "./plans.js";

const DB_PATH = process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "akinci.db");
mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    plan TEXT NOT NULL DEFAULT 'free',
    plan_expires_at INTEGER,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS usage (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
  );

  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan TEXT NOT NULL,
    price_try INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    provider_token TEXT,
    payment_id TEXT,
    created_at INTEGER NOT NULL,
    paid_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS orders_token ON orders(provider_token);
`);

// Eski veritabanları için: rol kolonu (user | owner)
const userCols = db.prepare("PRAGMA table_info(users)").all() as { name: string }[];
if (!userCols.some((c) => c.name === "role")) {
  db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
}

export interface UserRow {
  id: number;
  email: string;
  name: string;
  password_hash: string;
  role: "user" | "owner";
  plan: PlanId;
  plan_expires_at: number | null;
  created_at: number;
  last_login_at: number | null;
}

export interface OrderRow {
  id: string;
  user_id: number;
  plan: PlanId;
  price_try: number;
  status: "pending" | "paid" | "failed";
  provider_token: string | null;
  payment_id: string | null;
  created_at: number;
  paid_at: number | null;
}

const q = {
  userByEmail: db.prepare("SELECT * FROM users WHERE email = ?"),
  userById: db.prepare("SELECT * FROM users WHERE id = ?"),
  insertUser: db.prepare(
    "INSERT INTO users (email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?) RETURNING *",
  ),
  setPassword: db.prepare("UPDATE users SET password_hash = ? WHERE id = ?"),
  deleteUserSessions: db.prepare("DELETE FROM sessions WHERE user_id = ?"),
  touchLogin: db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?"),
  setPlan: db.prepare("UPDATE users SET plan = ?, plan_expires_at = ? WHERE id = ?"),

  insertSession: db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)"),
  sessionUser: db.prepare(
    "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?",
  ),
  deleteSession: db.prepare("DELETE FROM sessions WHERE token_hash = ?"),
  purgeSessions: db.prepare("DELETE FROM sessions WHERE expires_at <= ?"),

  usage: db.prepare("SELECT count FROM usage WHERE user_id = ? AND day = ?"),
  consume: db.prepare(`
    INSERT INTO usage (user_id, day, count) VALUES (?, ?, 1)
    ON CONFLICT (user_id, day) DO UPDATE SET count = count + 1 WHERE count < ?
  `),
  refund: db.prepare("UPDATE usage SET count = count - 1 WHERE user_id = ? AND day = ? AND count > 0"),

  insertOrder: db.prepare(
    "INSERT INTO orders (id, user_id, plan, price_try, created_at) VALUES (?, ?, ?, ?, ?)",
  ),
  setOrderToken: db.prepare("UPDATE orders SET provider_token = ? WHERE id = ?"),
  orderByToken: db.prepare("SELECT * FROM orders WHERE provider_token = ?"),
  orderById: db.prepare("SELECT * FROM orders WHERE id = ?"),
  markPaid: db.prepare(
    "UPDATE orders SET status = 'paid', payment_id = ?, paid_at = ? WHERE id = ? AND status = 'pending'",
  ),
  markFailed: db.prepare("UPDATE orders SET status = 'failed' WHERE id = ? AND status = 'pending'"),
};

export const users = {
  byEmail: (email: string) => q.userByEmail.get(email) as UserRow | undefined,
  byId: (id: number) => q.userById.get(id) as UserRow | undefined,
  create: (email: string, name: string, passwordHash: string, role: "user" | "owner" = "user") =>
    q.insertUser.get(email, name, passwordHash, role, Date.now()) as unknown as UserRow,
  setPassword: (id: number, hash: string) => q.setPassword.run(hash, id),
  revokeSessions: (id: number) => q.deleteUserSessions.run(id),
  touchLogin: (id: number) => q.touchLogin.run(Date.now(), id),
};

export const sessions = {
  create: (tokenHash: string, userId: number, expiresAt: number) => q.insertSession.run(tokenHash, userId, expiresAt),
  user: (tokenHash: string) => q.sessionUser.get(tokenHash, Date.now()) as UserRow | undefined,
  delete: (tokenHash: string) => q.deleteSession.run(tokenHash),
  purge: () => q.purgeSessions.run(Date.now()),
};

/** Süresi dolmuş ücretli plan Free'ye düşer. */
export function effectivePlan(user: UserRow, now = Date.now()): { plan: Plan; expiresAt: number | null } {
  // Site sahibi her zaman Full planı süresiz kullanır.
  if (user.role === "owner") return { plan: PLANS.full, expiresAt: null };
  if (user.plan !== "free" && user.plan_expires_at && user.plan_expires_at > now) {
    return { plan: PLANS[user.plan], expiresAt: user.plan_expires_at };
  }
  return { plan: PLANS.free, expiresAt: null };
}

export const usage = {
  get: (userId: number, day: string) => ((q.usage.get(userId, day) as { count: number } | undefined)?.count ?? 0),
  /** Kota varsa bir hak düşer; kota doluysa false döner. */
  consume(userId: number, day: string, limit: number | null): boolean {
    const cap = limit ?? Number.MAX_SAFE_INTEGER;
    if (cap <= 0) return false;
    return Number(q.consume.run(userId, day, cap).changes) === 1;
  },
  refund: (userId: number, day: string) => q.refund.run(userId, day),
};

export const orders = {
  create: (id: string, userId: number, plan: PlanId, priceTry: number) =>
    q.insertOrder.run(id, userId, plan, priceTry, Date.now()),
  setToken: (id: string, token: string) => q.setOrderToken.run(token, id),
  byToken: (token: string) => q.orderByToken.get(token) as OrderRow | undefined,
  byId: (id: string) => q.orderById.get(id) as OrderRow | undefined,
  markFailed: (id: string) => q.markFailed.run(id),

  /**
   * Siparişi bir kez ödenmiş sayar ve kullanıcının planını 30 gün açar/uzatır.
   * Aynı plan hâlâ aktifse süre kalan sürenin üstüne eklenir. İkinci çağrı etkisizdir.
   */
  fulfill(order: OrderRow, paymentId: string): boolean {
    db.exec("BEGIN IMMEDIATE");
    try {
      const changed = Number(q.markPaid.run(paymentId, Date.now(), order.id).changes) === 1;
      if (changed) {
        const user = users.byId(order.user_id);
        if (!user) throw new Error("Sipariş sahibi bulunamadı");
        const now = Date.now();
        const base =
          user.plan === order.plan && user.plan_expires_at && user.plan_expires_at > now ? user.plan_expires_at : now;
        q.setPlan.run(order.plan, base + SUBSCRIPTION_DAYS * 24 * 60 * 60 * 1000, user.id);
      }
      db.exec("COMMIT");
      return changed;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  },
};
