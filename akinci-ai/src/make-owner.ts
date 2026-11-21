// Kullanım: npm run make-owner -- ornek@eposta.com
// Zaten kayıtlı bir hesabı site sahibi yapar (Full plan, süresiz). Sunucuya erişimi olan çalıştırabilir.
import { db, users } from "./db.js";

const email = (process.argv[2] ?? "").trim().toLowerCase();
if (!email) {
  console.error("Kullanım: npm run make-owner -- ornek@eposta.com");
  process.exit(1);
}
const user = users.byEmail(email);
if (!user) {
  console.error(`${email} ile kayıtlı hesap yok. Önce siteden kayıt ol.`);
  process.exit(1);
}
db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(user.id);
console.log(`${email} artık site sahibi (Full, süresiz).`);
