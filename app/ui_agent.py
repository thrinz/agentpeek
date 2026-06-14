"""UI-mode sessions: background Claude Agent SDK chats.

Each UI session owns an AgentRunner — a long-lived ClaudeSDKClient that keeps
running independently of any connected browser (the "always-on" model). The
runner pulls user prompts off a queue, streams the agent's messages to every
connected WebSocket, and persists a transcript so reconnecting browsers (and
restarts) see history. The agent's own conversation persists via the SDK
session id, which we store for `resume=`.

Registry (names, cwd, group, sdk session id) → ~/.config/agentpeek/ui_sessions.json
Transcripts → ~/.config/agentpeek/ui_transcripts/<name>.json
"""

import asyncio
import json
import time
from pathlib import Path

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ClaudeSDKClient,
    ResultMessage,
    StreamEvent,
    SystemMessage,
    TextBlock,
    ThinkingBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)

CONFIG_DIR = Path.home() / ".config" / "agentpeek"
REGISTRY_FILE = CONFIG_DIR / "ui_sessions.json"
TRANSCRIPT_DIR = CONFIG_DIR / "ui_transcripts"

# Friendly model aliases → ids; UI picker sends the alias.
MODELS = {
    "opus": "claude-opus-4-8",
    "sonnet": "claude-sonnet-4-6",
    "haiku": "claude-haiku-4-5",
}
DEFAULT_MODEL = "opus"

# Web UI has no interactive permission prompts, so the agent runs autonomously
# in its working directory (same trust model as a terminal Claude Code session).
PERMISSION_MODE = "bypassPermissions"

# Suspend an idle agent (free its `claude` subprocess) after this long with no
# connected browsers and nothing running; it resumes on the next message.
IDLE_SECONDS = 30 * 60


def resolve_model(alias: str | None) -> str:
    return MODELS.get(alias or DEFAULT_MODEL, MODELS[DEFAULT_MODEL])


def _tool_result_text(block) -> str:
    content = getattr(block, "content", None)
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict):
                parts.append(item.get("text", "") or "")
            else:
                parts.append(getattr(item, "text", "") or str(item))
        return "\n".join(p for p in parts if p)
    return "" if content is None else str(content)


class AgentRunner:
    def __init__(self, manager, name, cwd, session_id=None, group="General", model="opus"):
        self.manager = manager
        self.name = name
        self.cwd = cwd
        self.group = group
        self.session_id = session_id
        self.model = model
        self.client = None
        self.queue: asyncio.Queue = asyncio.Queue()
        self.transcript: list = []
        self.clients: set = set()
        self.busy = False
        self.task = None
        self.last_active = time.time()

    # --- lifecycle -------------------------------------------------------

    def ensure_task(self):
        if self.task is None or self.task.done():
            self.task = asyncio.create_task(self._run())

    async def _ensure_client(self):
        if self.client is not None:
            return
        opts = ClaudeAgentOptions(
            cwd=self.cwd,
            permission_mode=PERMISSION_MODE,
            model=resolve_model(self.model),
            resume=self.session_id,
            system_prompt={"type": "preset", "preset": "claude_code"},
            include_partial_messages=True,  # token-level streaming
        )
        self.client = ClaudeSDKClient(options=opts)
        await self.client.connect()

    async def _run(self):
        try:
            await self._ensure_client()
        except Exception as e:  # connection / auth failure
            await self._emit({"role": "error", "text": f"Could not start the agent: {e}"})
            await self._status()
            return
        while True:
            prompt = await self.queue.get()
            if prompt is None:  # shutdown sentinel
                return
            self.busy = True
            await self._status()
            try:
                await self.client.query(prompt)
                async for msg in self.client.receive_response():
                    await self._handle(msg)
            except Exception as e:
                await self._emit({"role": "error", "text": str(e)})
            self.busy = False
            await self._status()

    async def _handle(self, msg):
        if isinstance(msg, StreamEvent):
            ev = msg.event or {}
            if ev.get("type") == "content_block_delta":
                delta = ev.get("delta") or {}
                if delta.get("type") == "text_delta" and delta.get("text"):
                    # ephemeral: streamed live, not persisted (the AssistantMessage commits it)
                    await self._broadcast({"type": "delta", "text": delta["text"]})
            return
        if isinstance(msg, AssistantMessage):
            self._note_session(getattr(msg, "session_id", None))
            for b in msg.content:
                if isinstance(b, TextBlock):
                    if b.text.strip():
                        await self._emit({"role": "assistant", "text": b.text})
                elif isinstance(b, ThinkingBlock):
                    text = getattr(b, "thinking", "") or getattr(b, "text", "")
                    if text:
                        await self._emit({"role": "thinking", "text": text})
                elif isinstance(b, ToolUseBlock):
                    await self._emit({"role": "tool_use", "name": b.name, "input": b.input})
        elif isinstance(msg, UserMessage):
            for b in getattr(msg, "content", None) or []:
                if isinstance(b, ToolResultBlock):
                    await self._emit({"role": "tool_result", "text": _tool_result_text(b)})
        elif isinstance(msg, ResultMessage):
            self._note_session(getattr(msg, "session_id", None))
            await self._emit({
                "role": "result", "subtype": msg.subtype,
                "is_error": bool(msg.is_error), "cost": msg.total_cost_usd,
            })
        elif isinstance(msg, SystemMessage):
            self._note_session((getattr(msg, "data", None) or {}).get("session_id"))
        # RateLimitEvent / StreamEvent ignored for v1

    def _note_session(self, sid):
        if sid and sid != self.session_id:
            self.session_id = sid
            self.manager.note_session(self.name, sid)

    # --- io --------------------------------------------------------------

    async def _emit(self, event):
        self.last_active = time.time()
        self.transcript.append(event)
        self.manager.persist_transcript(self.name, self.transcript)
        await self._broadcast({"type": "event", "event": event})

    async def _broadcast(self, msg):
        dead = []
        for ws in list(self.clients):
            try:
                await ws.send_json(msg)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)

    async def _status(self):
        await self._broadcast({
            "type": "status", "busy": self.busy,
            "queued": self.queue.qsize(), "model": self.model,
        })

    # --- public ----------------------------------------------------------

    async def enqueue(self, text):
        self.last_active = time.time()
        self.ensure_task()
        await self._emit({"role": "user", "text": text})
        await self.queue.put(text)
        await self._status()

    async def interrupt(self):
        if self.client and self.busy:
            try:
                await self.client.interrupt()
            except Exception:
                pass

    async def set_model(self, alias):
        if alias not in MODELS or alias == self.model:
            return
        self.model = alias
        self.manager.note_model(self.name, alias)
        if self.client:
            try:
                await self.client.set_model(resolve_model(alias))
            except Exception:
                pass

    async def add_ws(self, ws):
        self.last_active = time.time()
        self.clients.add(ws)
        await ws.send_json({"type": "history", "events": self.transcript})
        await ws.send_json({
            "type": "status", "busy": self.busy,
            "queued": self.queue.qsize(), "model": self.model,
        })

    def remove_ws(self, ws):
        self.clients.discard(ws)

    async def suspend(self):
        """Free the agent subprocess while idle; transcript + session id are kept,
        and the next message reconnects with resume=session_id."""
        if self.task:
            self.task.cancel()
            self.task = None
        if self.client:
            try:
                await self.client.disconnect()
            except Exception:
                pass
            self.client = None
        self.busy = False

    async def shutdown(self):
        await self.queue.put(None)
        if self.client:
            try:
                await self.client.disconnect()
            except Exception:
                pass
        if self.task:
            self.task.cancel()


class UIManager:
    def __init__(self):
        self.runners: dict = {}
        self.registry: dict = {}
        self._load_registry()

    # --- persistence -----------------------------------------------------

    def _load_registry(self):
        try:
            self.registry = json.loads(REGISTRY_FILE.read_text())
        except (OSError, json.JSONDecodeError):
            self.registry = {}

    def _persist_registry(self):
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        REGISTRY_FILE.write_text(json.dumps(self.registry, indent=2) + "\n")

    def _tpath(self, name) -> Path:
        return TRANSCRIPT_DIR / f"{name}.json"

    def persist_transcript(self, name, transcript):
        TRANSCRIPT_DIR.mkdir(parents=True, exist_ok=True)
        self._tpath(name).write_text(json.dumps(transcript))

    def _load_transcript(self, name):
        try:
            return json.loads(self._tpath(name).read_text())
        except (OSError, json.JSONDecodeError):
            return []

    def note_session(self, name, sid):
        if name in self.registry:
            self.registry[name]["session_id"] = sid
            self._persist_registry()

    def note_model(self, name, alias):
        if name in self.registry:
            self.registry[name]["model"] = alias
            self._persist_registry()

    # --- registry ops ----------------------------------------------------

    def exists(self, name) -> bool:
        return name in self.registry

    def list(self) -> list:
        out = []
        for name, meta in self.registry.items():
            r = self.runners.get(name)
            out.append({
                "name": name,
                "group": meta.get("group", "General"),
                "kind": "ui",
                "cwd": meta.get("cwd"),
                "model": meta.get("model", DEFAULT_MODEL),
                "busy": bool(r and r.busy),
                "foreground": "thinking" if (r and r.busy) else None,
                "created": meta.get("created", 0),
                "attached": False,
                "attach_command": "",
            })
        return out

    def create(self, name, group, cwd, model=DEFAULT_MODEL):
        self.registry[name] = {
            "group": group, "cwd": str(cwd), "model": model,
            "session_id": None, "created": int(time.time()),
        }
        self._persist_registry()

    def get_runner(self, name):
        if name not in self.registry:
            return None
        r = self.runners.get(name)
        if r is None:
            meta = self.registry[name]
            r = AgentRunner(self, name, meta["cwd"], meta.get("session_id"),
                            meta.get("group", "General"), meta.get("model", DEFAULT_MODEL))
            r.transcript = self._load_transcript(name)
            self.runners[name] = r
        return r

    # --- idle sweeper ----------------------------------------------------

    def start_sweeper(self):
        asyncio.create_task(self._sweep())

    async def _sweep(self):
        while True:
            await asyncio.sleep(60)
            now = time.time()
            for r in list(self.runners.values()):
                if (not r.clients and not r.busy and r.client is not None
                        and now - r.last_active > IDLE_SECONDS):
                    await r.suspend()

    def rename(self, old, new):
        if old not in self.registry:
            return
        self.registry[new] = self.registry.pop(old)
        runner = self.runners.pop(old, None)
        if runner:
            runner.name = new
            self.runners[new] = runner
        tp = self._tpath(old)
        if tp.exists():
            tp.rename(self._tpath(new))
        self._persist_registry()

    async def kill(self, name):
        runner = self.runners.pop(name, None)
        if runner:
            await runner.shutdown()
        self.registry.pop(name, None)
        self._persist_registry()
        try:
            self._tpath(name).unlink()
        except OSError:
            pass


manager = UIManager()
