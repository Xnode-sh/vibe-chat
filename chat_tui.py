import asyncio
import os
import sys
import re
from pathlib import Path

from textual.app import App, ComposeResult
from textual.containers import VerticalScroll, Center
from textual.widgets import Footer, Header, Input, Markdown, Static

ROOT = Path(__file__).resolve().parent
NPM = Path(os.environ.get("APPDATA", "")) / "npm" / "node_modules"
CLAUDE_BIN = str(NPM / "@anthropic-ai" / "claude-code" / "bin" / "claude.exe")
OPENCODE_BIN = str(NPM / "opencode-ai" / "bin" / "opencode.exe")
OC_MODEL = os.environ.get("VIBE_OC_MODEL", "openrouter/poolside/laguna-s-2.1:free")

MODE_NAMES = {"c": "Claude Code", "o": "opencode", "b": "Claude + opencode"}

CLAUDE_LABEL = "# 🟠 Claude Code\n\n"
OPENCODE_LABEL = "# 🟣 opencode\n\n"

history: list[tuple[str, str]] = []


def build_context(message: str) -> str:
    ctx = "\n".join(f"Пользователь: {t}" if w == "u" else f"{MODE_NAMES[a]}: {t}"
                    for a, t in history[-12:])
    return (
        "Ты ведёшь общий чат вместе с другим агентом. Отвечай коротко, по-русски, "
        "без воды. Продолжай общий поток.\n\n"
        f"ИСТОРИЯ ЧАТА:\n{ctx}\n\n"
        f"Пользователь: {message}\nОтвет:"
    )


def strip_md(text: str) -> str:
    text = re.sub(r"^\s*[>\-*] ", "", text).strip()
    text = re.sub(r"^[#{1,6}]\s*", "", text).strip()
    return text.strip()


async def ask(cmd: str, args: list[str]) -> str:
    proc = await asyncio.create_subprocess_exec(
        cmd, *args,
        cwd=str(ROOT),
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env={**os.environ, "NO_COLOR": "1"},
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=180)
    except asyncio.TimeoutError:
        proc.kill()
        return "⚠ таймаут"
    if proc.returncode != 0:
        msg = err.decode("utf-8", "replace").strip() or f"exit {proc.returncode}"
        return f"⚠ {strip_md(msg)}"
    return out.decode("utf-8", "replace").strip()


class VibeChat(App):
    TITLE = "vibe-chat"
    SUB_TITLE = "Claude Code + opencode · 2 в 1"
    CSS = """
    Screen { background: #0a0a10; }

    #chat { padding: 1 2; }
    .user-msg {
        margin: 1 0 1 40;
        padding: 0 1;
        background: #2a3a6b 30%;
        border: round #7c9bff 60%;
        border-left: thick #7c9bff;
    }
    .claude-msg {
        margin: 1 40 0 0;
        padding: 0 2;
        border-left: thick #e8734a 90%;
    }
    .opencode-msg {
        margin: 1 40 0 0;
        padding: 0 2;
        border-left: thick #9d6bff 90%;
    }
    .meta { color: #8b8ba3; margin-bottom: 1; }
    .meta.c { color: #e8734a; text-style: bold; }
    .meta.o { color: #9d6bff; text-style: bold; }

    #status { color: #6f7cca; text-align: center; margin: 0 0 1 0; }

    #inputdock {
        dock: bottom;
        padding: 0 1 1 1;
        background: #0a0a10;
    }
    Input { border: round #9d6bff 50%; }
    Input:focus { border: round #9d6bff; }
    """

    BINDINGS = [
        ("ctrl+c", "mode('c')", "Claude"),
        ("ctrl+o", "mode('o')", "opencode"),
        ("ctrl+b", "mode('b')", "Оба"),
        ("ctrl+l", "clear", "Очистить"),
    ]

    def __init__(self):
        super().__init__()
        self.mode = "b"
        self.busy = False

    def compose(self) -> ComposeResult:
        yield Header(show_clock=True)
        yield VerticalScroll(id="chat")
        with Center(id="statusdock"):
            from textual.widgets import Static
            yield Static("", id="status")
        yield Input(placeholder="> введи вопрос…  (Ctrl+C — Claude, Ctrl+O — opencode, Ctrl+B — оба, Enter — отправить)", id="input")
        yield Footer()

    def set_meta(self) -> None:
        self.title = f"vibe-chat · {MODE_NAMES[self.mode]}"

    def on_mount(self) -> None:
        self.set_meta()
        self.query_one("#input", Input).focus()

    def action_clear(self) -> None:
        history.clear()
        for w in list(self.query(".claude-msg, .opencode-msg, .user-msg")):
            w.remove()

    def action_mode(self, m: str) -> None:
        if not self.busy:
            self.mode = m
            self.set_meta()

    async def append_user(self, text: str) -> None:
        chat = self.query_one("#chat", VerticalScroll)
        chat.mount_all([Static(f"[b][#7c9bff]ты[/][/]\n{text}", classes="user-msg")])
        chat.scroll_end(animate=False)

    def spawn_bubble(self, who: str) -> tuple[Markdown]:
        chat = self.query_one("#chat", VerticalScroll)
        meta = Static("Claude Code ⟁" if who == "c" else "opencode ⟁", classes=f"meta {who}")
        md = Markdown("", classes=f"{'claude-msg' if who == 'c' else 'opencode-msg'}")
        chat.mount_all([meta, md])
        chat.scroll_end(animate=False)
        return md

    def refresh_bubble(self, md: Markdown, text: str, label: str) -> None:
        md.update(f"{label}{text}")
        self.query_one("#chat", VerticalScroll).scroll_end(animate=False)

    def kick(self, msg: str) -> None:
        self.query_one("#chat", VerticalScroll).scroll_end(animate=True)

    async def on_input_submitted(self, event: Input.Submitted) -> None:
        msg = event.value.strip()
        if not msg or self.busy:
            return
        self.busy = True
        self.query_one("#input", Input).value = ""
        self.set_meta() if self.mode else None
        self.query_one("#status").update("✦ думаю…")
        history.append(("u", msg))
        await self.append_user(msg)

        prompt = build_context(msg)
        tasks = []
        if self.mode in ("c", "b"):
            tasks.append(("c", ask(CLAUDE_BIN, ["-p", prompt, "--tools", "Read",
                                               "--permission-mode", "plan",
                                               "--output-format", "text"])))
        if self.mode in ("o", "b"):
            tasks.append(("o", ask(OPENCODE_BIN, ["run", prompt, "--agent", "chat-vibe",
                                                  "-m", OC_MODEL, "--format", "default"])))

        for who, coro in tasks:
            text = await coro  # sequential: Claude first, then opencode
            history.append(("a", text))
            md = self.spawn_bubble(who)
            label = CLAUDE_LABEL if who == "c" else OPENCODE_LABEL
            shown = ""
            for chunk in [text[i:i + 5] for i in range(0, len(text), 5)]:
                shown += chunk
                self.refresh_bubble(md, shown, label)
                await asyncio.sleep(0.004)
            self.query_one("#chat", VerticalScroll).scroll_end(animate=False)

        self.query_one("#status").update("")
        self.kick("")
        self.busy = False
        self.query_one("#input", Input).focus()


if __name__ == "__main__":
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    VibeChat().run()