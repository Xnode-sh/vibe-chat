import http from "node:http";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PORT = 4180;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");

const AGENT = path.join(ROOT, ".opencode", "agent", "chat-vibe.md");
const OC_MODEL = process.env.VIBE_OC_MODEL || "openrouter/poolside/laguna-s-2.1:free";

const NPM = path.join(process.env.APPDATA, "npm", "node_modules");
const CLAUDE_BIN = path.join(NPM, "@anthropic-ai", "claude-code", "bin", "claude.exe");
const OPENCODE_BIN = path.join(NPM, "opencode-ai", "bin", "opencode.exe");
const SYSTEM_NOTE =
  "Ты ведёшь один общий чат. Отвечай коротко, по-русски, без воды. " +
  "История диалога ниже.";

// ---------- helpers ----------
const history = []; // {role, who, text}
const last = (n) =>
  history.slice(-n).map((m) => `${m.who === "user" ? "Пользователь" : m.who}: ${m.text}`).join("\n");

function buildPrompt(msg, turns = 12) {
  const ctx = last(turns);
  return `${SYSTEM_NOTE}\n\nИСТОРИЯ ЧАТА:\n${ctx}\n\nПользователь: ${msg}\nОтвет:`;
}

function run(cmd, args, cwd, timeoutMs = 180000) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      shell: false,
      env: { ...process.env, NO_COLOR: "1" },
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out: out.trim(), err: err.trim() });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out: "", err: e.message });
    });
    child.stdin.end();
  });
}

// ---------- backends (read-only by construction) ----------
async function askClaude(prompt) {
  const r = await run(
    CLAUDE_BIN,
    ["-p", prompt, "--tools", "Read", "--permission-mode", "plan", "--output-format", "text"],
    ROOT
  );
  if (r.code !== 0) return { ok: false, text: r.err || `exit ${r.code}` };
  return { ok: true, text: r.out };
}

async function askOpencode(prompt) {
  const r = await run(
    OPENCODE_BIN,
    ["run", prompt, "--agent", "chat-vibe", "-m", OC_MODEL, "--format", "default"],
    ROOT
  );
  if (r.code !== 0) return { ok: false, text: r.err || `exit ${r.code}` };
  return { ok: true, text: r.out };
}

// ---------- http ----------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

function json(res, obj) {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === "GET") {
    const file = url.pathname === "/" ? "/index.html" : url.pathname;
    try {
      const data = await readFile(path.join(PUBLIC, file));
      const ext = path.extname(file);
      res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
      res.end(data);
    } catch {
      res.writeHead(404).end("not found");
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/chat") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      let msg = "";
      let mode = "both";
      try {
        const j = JSON.parse(body);
        msg = (j.message || "").trim();
        mode = ["claude", "opencode", "both"].includes(j.mode) ? j.mode : "both";
      } catch {
        return json(res, { error: "bad json" });
      }
      if (!msg) return json(res, { error: "empty message" });

      history.push({ role: "user", who: "Пользователь", text: msg });
      const prompt = buildPrompt(msg);

      const tasks = [];
      if (mode === "claude" || mode === "both") tasks.push(askClaude(prompt).then((r) => ({ who: "claude", ...r })));
      if (mode === "opencode" || mode === "both") tasks.push(askOpencode(prompt).then((r) => ({ who: "opencode", ...r })));

      const answers = await Promise.all(tasks);
      for (const a of answers) history.push({ role: "assistant", who: a.who, text: a.text });
      return json(res, { answers });
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/reset") {
    history.length = 0;
    return json(res, { ok: true });
  }

  res.writeHead(404).end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`vibe-chat → http://127.0.0.1:${PORT}`);
});
