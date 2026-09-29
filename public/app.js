const chat = document.getElementById("chat");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");
const modeLabel = document.getElementById("modeLabel");
const resetBtn = document.getElementById("reset");

let mode = "both";
const MODE_NAMES = { claude: "claude code", opencode: "opencode", both: "оба 2 в 1" };

marked.setOptions({ breaks: true, highlight(code, lang) {
  try {
    if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
    return hljs.highlightAuto(code).value;
  } catch { return code; }
}});

document.querySelectorAll(".agent").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".agent").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    mode = btn.dataset.mode;
    modeLabel.textContent = MODE_NAMES[mode];
  });
});

resetBtn.addEventListener("click", async () => {
  await fetch("/api/reset", { method: "POST" });
  location.reload();
});

input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 180) + "px";
});

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
sendBtn.addEventListener("click", send);

function clearWelcome() {
  const w = chat.querySelector(".welcome");
  if (w) w.remove();
}

function addMsg(who, html, cls) {
  clearWelcome();
  const el = document.createElement("div");
  el.className = `msg ${cls}`;
  const av = document.createElement("div");
  av.className = "avatar";
  av.textContent = cls === "user" ? "Я" : who === "claude" ? "C" : "O";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (cls !== "user") {
    const w = document.createElement("span");
    w.className = "who";
    w.textContent = who === "claude" ? "Claude Code" : "opencode";
    bubble.appendChild(w);
  }
  const body = document.createElement("div");
  body.className = "body";
  bubble.appendChild(body);
  el.append(av, bubble);
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
  return body;
}

async function typeInto(el, text) {
  el.innerHTML = "";
  const tokens = text.match(/```[\s\S]*?```|`[^`]+`|.{1,3}/g) || [text];
  let acc = "";
  for (const t of tokens) {
    acc += t;
    el.innerHTML = marked.parse(acc);
    el.querySelectorAll("pre code").forEach((b) => hljs.highlightElement(b));
    chat.scrollTop = chat.scrollHeight;
    await new Promise((r) => setTimeout(r, t.length > 10 ? 8 : 16));
  }
}

async function send() {
  const msg = input.value.trim();
  if (!msg || sendBtn.disabled) return;
  input.value = "";
  input.style.height = "auto";
  sendBtn.disabled = true;

  addMsg("", escapeHtml(msg).replace(/\n/g, "<br>"), "user");

  const needs = mode === "both" ? ["claude", "opencode"] : [mode];
  const bodies = needs.map((w) => addMsg(w, "", w));
  bodies.forEach((b) => (b.innerHTML = `<span class="typing"><i></i><i></i><i></i></span>`));

  try {
    const r = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: msg, mode }),
    });
    const data = await r.json();
    if (data.error) throw new Error(data.error);

    for (const a of data.answers) {
      const i = needs.indexOf(a.who);
      const body = bodies[i];
      if (!a.ok) {
        body.innerHTML = `<div class="err">⚠ ${escapeHtml(a.text)}</div>`;
      } else {
        await typeInto(body, a.text);
      }
    }
  } catch (e) {
    bodies.forEach((b) => (b.innerHTML = `<div class="err">⚠ ${escapeHtml(e.message)}</div>`));
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
