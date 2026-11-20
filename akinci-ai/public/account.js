// Hesap, giriş/kayıt, plan ve kota arayüzü.

const $ = (id) => document.getElementById(id);
const TL = new Intl.NumberFormat("tr-TR");

let account = null; // { user, plan, usage }
let plans = [];
let paymentReady = false;
let onLoginCb = () => {};

export async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Hata (${res.status})`), { status: res.status, code: data.code });
  return data;
}

// ---------- bildirim ----------
let toastTimer;
export function toast(text, kind = "ok") {
  const el = $("toast");
  el.textContent = text;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4500);
}

// ---------- hesap görünümü ----------
function quotaLabel(u) {
  return u.limit == null ? `${u.used} mesaj · sınırsız` : `${u.used} / ${u.limit}`;
}

function render() {
  const signedIn = Boolean(account);
  $("account").hidden = !signedIn;
  $("openPlansSm").hidden = !signedIn;
  if (!signedIn) return;

  const { user, plan, usage } = account;
  $("accName").textContent = user.name;
  for (const el of [$("accPlan"), $("openPlansSm")]) {
    el.textContent = plan.name;
    el.dataset.plan = plan.id;
  }
  $("quotaText").textContent = quotaLabel(usage);
  const pct = usage.limit == null ? 0 : Math.min(100, (usage.used / usage.limit) * 100);
  $("quotaFill").style.width = `${pct}%`;
  $("quotaFill").parentElement.classList.toggle("full", pct >= 100);
  $("openPlans").textContent = plan.id === "full" ? "Planım" : "Planı yükselt";

  const exp = plan.expiresAt ? `${new Date(plan.expiresAt).toLocaleDateString("tr-TR")} tarihine kadar` : "";
  $("accMobile").innerHTML = "";
  const head = document.createElement("div");
  head.className = "account-row";
  head.innerHTML = `<span class="account-name"></span><span class="badge" data-plan="${plan.id}">${plan.name}</span>`;
  head.querySelector(".account-name").textContent = user.email;
  const q = document.createElement("div");
  q.className = "quota-text";
  q.innerHTML = `<span>Bugün</span><span>${quotaLabel(usage)}</span>`;
  const out = document.createElement("button");
  out.className = "link";
  out.type = "button";
  out.textContent = "Çıkış yap";
  out.addEventListener("click", logout);
  $("accMobile").append(head, q);
  if (exp) {
    const e = document.createElement("div");
    e.className = "quota-text";
    e.innerHTML = `<span>Plan süresi</span><span>${exp}</span>`;
    $("accMobile").append(e);
  }
  $("accMobile").append(out);
  renderPlans();
}

export function updateQuota(q) {
  if (!account || !q) return;
  account.usage = q;
  render();
}

export const isSignedIn = () => Boolean(account);

// ---------- planlar ----------
function renderPlans() {
  const box = $("plans");
  box.innerHTML = "";
  const current = account?.plan.id ?? "free";
  for (const p of plans) {
    const card = document.createElement("div");
    card.className = "plan" + (p.id === "pro" ? " popular" : "");
    const quota = p.dailyMessages == null ? "Sınırsız mesaj" : `Günde ${p.dailyMessages} mesaj`;
    card.innerHTML = `
      <div class="plan-head"><span class="plan-name">${p.name}</span>${p.id === "pro" ? '<span class="plan-tag">Popüler</span>' : ""}</div>
      <div class="plan-price">${p.priceTry ? `${TL.format(p.priceTry)} TL<small> / ay</small>` : "Ücretsiz"}</div>
      <p class="plan-quota">${quota}</p>
      <ul>${p.features.map((f) => `<li>${f}</li>`).join("")}</ul>`;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn" + (p.id !== "free" ? " btn-primary" : "");
    if (p.id === current) {
      btn.textContent = p.id === "free" ? "Mevcut plan" : "Süreyi 30 gün uzat";
      btn.disabled = p.id === "free";
    } else if (p.id === "free") {
      btn.textContent = "Ücretsiz";
      btn.disabled = true;
    } else {
      btn.textContent = `${p.name}'ya geç`;
    }
    if (p.id !== "free" && !paymentReady) {
      btn.disabled = true;
      btn.textContent = "Ödeme yakında";
    }
    if (!btn.disabled) btn.addEventListener("click", () => checkout(p.id, btn));
    card.append(btn);
    box.append(card);
  }
}

async function checkout(planId, btn) {
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = "Yönlendiriliyor…";
  try {
    const { url } = await api("/api/checkout", { plan: planId });
    location.href = url;
  } catch (err) {
    toast(err.message, "err");
    btn.disabled = false;
    btn.textContent = old;
  }
}

export function showPlans(message) {
  $("plansMsg").hidden = !message;
  $("plansMsg").textContent = message ?? "";
  renderPlans();
  $("plansView").hidden = false;
  $("closePlans").focus();
}
function hidePlans() {
  $("plansView").hidden = true;
}

// ---------- giriş / kayıt ----------
let mode = "login";
function setMode(m) {
  mode = m;
  for (const t of document.querySelectorAll(".tab")) {
    const active = t.dataset.mode === m;
    t.classList.toggle("active", active);
    t.setAttribute("aria-selected", String(active));
  }
  $("nameField").hidden = m !== "register";
  $("authSubmit").textContent = m === "register" ? "Kayıt ol" : "Giriş yap";
  $("authForm").elements.password.autocomplete = m === "register" ? "new-password" : "current-password";
  $("authError").textContent = "";
}

export function showAuth() {
  account = null;
  render();
  $("authView").hidden = false;
  setTimeout(() => $("authForm").elements.email.focus(), 0);
}

async function submitAuth(e) {
  e.preventDefault();
  const f = $("authForm");
  const el = f.elements;
  const body = { email: el.email.value.trim(), password: el.password.value };
  if (mode === "register") body.name = el.name.value.trim();
  $("authSubmit").disabled = true;
  $("authError").textContent = "";
  try {
    account = await api(mode === "register" ? "/api/auth/register" : "/api/auth/login", body);
    f.reset();
    $("authView").hidden = true;
    render();
    toast(mode === "register" ? "Hoş geldin! Free planla başladın." : `Tekrar hoş geldin, ${account.user.name}.`);
    onLoginCb();
  } catch (err) {
    $("authError").textContent = err.message;
  } finally {
    $("authSubmit").disabled = false;
  }
}

async function logout() {
  await api("/api/auth/logout", {}).catch(() => {});
  hidePlans();
  showAuth();
}

export async function refreshAccount() {
  account = await api("/api/me");
  render();
  return account;
}

export async function initAccount({ onLogin }) {
  onLoginCb = onLogin;
  for (const t of document.querySelectorAll(".tab")) t.addEventListener("click", () => setMode(t.dataset.mode));
  $("authForm").addEventListener("submit", submitAuth);
  $("openPlans").addEventListener("click", () => showPlans());
  $("openPlansSm").addEventListener("click", () => showPlans());
  $("closePlans").addEventListener("click", hidePlans);
  $("plansView").addEventListener("click", (e) => { if (e.target === $("plansView")) hidePlans(); });
  $("logout").addEventListener("click", logout);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("plansView").hidden) hidePlans(); });

  const [info, planData] = await Promise.all([api("/api/info"), api("/api/plans")]);
  paymentReady = info.paymentReady;
  plans = planData.plans;
  $("meta").textContent = `Model: ${info.model}`;

  await refreshAccount();

  // iyzico dönüşü
  const params = new URLSearchParams(location.search);
  const result = params.get("odeme");
  if (result) {
    history.replaceState(null, "", location.pathname);
    if (result === "ok") {
      const p = plans.find((x) => x.id === params.get("plan"));
      toast(`Ödeme alındı. ${p ? p.name : "Yeni"} planın 30 gün boyunca aktif.`);
    } else {
      toast("Ödeme tamamlanamadı. Karttan para çekilmediyse tekrar deneyebilirsin.", "err");
    }
  }

  if (account) onLoginCb();
  else showAuth();
}
