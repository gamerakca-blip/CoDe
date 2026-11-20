import { createMascots, STATUS_TEXT } from "./mascot.js";
import { renderMarkdown } from "./markdown.js";

const SLEEP_AFTER_MS = 30_000;

const $ = (id) => document.getElementById(id);
const chat = $("chat");
const list = $("messages");
const empty = $("empty");
const form = $("composer");
const input = $("input");
const sendBtn = $("send");
const stopBtn = $("stop");

const AVATAR = `<svg class="avatar" viewBox="4 0 14 16" shape-rendering="crispEdges" aria-hidden="true">
  <rect x="8" y="1" width="6" height="1" fill="#d0262d"/><rect x="7" y="2" width="8" height="4" fill="#d0262d"/>
  <rect x="11.5" y="1" width="1" height="1.6" fill="#0a0c12"/><rect x="12" y="2.6" width="1.5" height="1.6" fill="#0a0c12"/>
  <rect x="5" y="6" width="11" height="1" fill="#0b6bff"/><rect x="5" y="7" width="12" height="7" fill="#0b6bff"/>
  <rect x="6" y="14" width="10" height="1" fill="#0b6bff"/>
  <rect x="8" y="10.5" width="1.5" height="1" fill="#0a0c12"/><rect x="12.5" y="10.5" width="1.5" height="1" fill="#0a0c12"/>
</svg>`;

let sessionId = null;
let busy = false;
let controller = null;
let sleepTimer = null;

const mascot = createMascots(".mascot", (state) => {
  $("status").textContent = STATUS_TEXT[state];
  $("statusSm").textContent = STATUS_TEXT[state];
});
mascot.set("coffee");

// ---------- boşta kalınca uyu ----------
function armSleep() {
  clearTimeout(sleepTimer);
  sleepTimer = setTimeout(() => { if (!busy) mascot.set("sleep"); }, SLEEP_AFTER_MS);
}
function activity() {
  if (busy) return;
  if (mascot.get() === "sleep") mascot.set("coffee");
  armSleep();
}
for (const ev of ["pointermove", "pointerdown", "keydown", "wheel", "touchstart", "focus"]) {
  window.addEventListener(ev, activity, { passive: true });
}
armSleep();

// ---------- oturum ----------
async function newSession() {
  const res = await fetch("/api/session", { method: "POST" });
  sessionId = (await res.json()).sessionId;
}

async function resetChat() {
  if (busy) controller?.abort();
  if (sessionId) {
    await fetch("/api/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    }).catch(() => {});
  }
  await newSession();
  list.innerHTML = "";
  empty.hidden = false;
  input.focus();
}
$("newChat").addEventListener("click", resetChat);
$("newChatSm").addEventListener("click", resetChat);

// ---------- mesajlar ----------
function scrollDown() {
  const nearBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 160;
  if (nearBottom) chat.scrollTop = chat.scrollHeight;
}

function addUser(text) {
  const li = document.createElement("li");
  li.className = "msg msg-user";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;
  li.append(bubble);
  list.append(li);
  chat.scrollTop = chat.scrollHeight;
}

function addAssistant() {
  const li = document.createElement("li");
  li.className = "msg msg-ai";
  li.innerHTML = `${AVATAR}<div class="col"><div class="body cursor"></div></div>`;
  list.append(li);
  chat.scrollTop = chat.scrollHeight;
  return { li, body: li.querySelector(".body") };
}

function note(li, text, isError = false) {
  const p = document.createElement("p");
  p.className = "msg-note" + (isError ? " err" : "");
  p.textContent = text;
  li.querySelector(".col").append(p);
}

list.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-copy]");
  if (!btn) return;
  const code = btn.closest(".codeblock").querySelector("code").textContent;
  try {
    await navigator.clipboard.writeText(code);
    btn.textContent = "Kopyalandı";
  } catch {
    btn.textContent = "Kopyalanamadı";
  }
  setTimeout(() => (btn.textContent = "Kopyala"), 1500);
});

// ---------- SSE okuma ----------
async function* readSSE(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = "message";
      let data = "";
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (data) yield { event, data: JSON.parse(data) };
    }
  }
}

// ---------- gönderme ----------
function setBusy(value) {
  busy = value;
  sendBtn.hidden = value;
  stopBtn.hidden = !value;
  if (!value) {
    mascot.set("coffee");
    armSleep();
  } else {
    clearTimeout(sleepTimer);
  }
}

async function send(text) {
  if (busy || !text.trim()) return;
  if (!sessionId) await newSession();

  empty.hidden = true;
  addUser(text);
  input.value = "";
  autosize();

  const { li, body } = addAssistant();
  let raw = "";
  let frame = 0;
  const paint = () => {
    frame = 0;
    body.innerHTML = renderMarkdown(raw);
    scrollDown();
  };

  setBusy(true);
  mascot.set("thinking");
  controller = new AbortController();

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, message: text }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Sunucu hatası (${res.status})`);
    }

    for await (const { event, data } of readSSE(res)) {
      if (event === "phase") {
        mascot.set(data.phase === "writing" ? "writing" : "thinking");
      } else if (event === "text") {
        if (mascot.get() !== "writing") mascot.set("writing");
        raw += data.text;
        if (!frame) frame = requestAnimationFrame(paint);
      } else if (event === "fallback") {
        note(li, `Yedek modele geçildi: ${data.to}`);
      } else if (event === "refusal") {
        note(li, "Bu istek güvenlik nedeniyle yanıtlanamadı. Soruyu farklı ifade etmeyi dene.", true);
      } else if (event === "done") {
        if (data.stopReason === "max_tokens") note(li, "Cevap uzunluk sınırına ulaştı ve kesildi.");
      } else if (event === "error") {
        note(li, data.message, true);
      }
    }
  } catch (err) {
    if (err.name === "AbortError") note(li, "Durduruldu. Bu tur sohbet geçmişine eklenmedi.");
    else note(li, err.message || "Bağlantı hatası.", true);
  } finally {
    if (frame) cancelAnimationFrame(frame);
    paint();
    body.classList.remove("cursor");
    if (!raw) body.remove();
    controller = null;
    setBusy(false);
    input.focus();
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  send(input.value);
});
stopBtn.addEventListener("click", () => controller?.abort());

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    form.requestSubmit();
  }
});

function autosize() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 200) + "px";
}
input.addEventListener("input", autosize);

for (const chip of document.querySelectorAll(".chip")) {
  chip.addEventListener("click", () => send(chip.textContent));
}

fetch("/api/info").then((r) => r.json()).then((i) => ($("meta").textContent = `Model: ${i.model}`)).catch(() => {});
newSession().catch(() => {});
input.focus();
