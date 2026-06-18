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
    CLINotFoundError,
    ResultMessage,
    StreamEvent,
    SystemMessage,
    TextBlock,
    ThinkingBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
    create_sdk_mcp_server,
    tool,
)

from . import claude_auth

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

# The built-in AskUserQuestion can't be answered in a headless SDK run (it
# auto-resolves to a default), so we disable it and expose our own in-process
# tool. Its handler blocks until the browser submits answers via the websocket,
# then returns them as the tool result — the faithful terminal behaviour. The
# system-prompt nudge points the agent at it instead of the built-in.
ASK_TOOL = "ask_user"
ASK_SERVER = "ask"
ASK_QUALIFIED = f"mcp__{ASK_SERVER}__{ASK_TOOL}"
ASK_PROMPT_APPEND = (
    "When you need the user to make a choice, do NOT use AskUserQuestion (it is "
    f"disabled here). Call the `{ASK_QUALIFIED}` tool instead — it renders an "
    "interactive picker in the web UI and returns the user's selections."
)
ASK_SCHEMA = {
    "type": "object",
    "properties": {
        "questions": {
            "type": "array",
            "description": "One or more questions to ask the user at once.",
            "items": {
                "type": "object",
                "properties": {
                    "question": {"type": "string",
                                 "description": "The full question text."},
                    "header": {"type": "string",
                               "description": "Short tab label (max ~12 chars)."},
                    "multiSelect": {"type": "boolean",
                                    "description": "Allow multiple selections."},
                    "options": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "label": {"type": "string"},
                                "description": {"type": "string"},
                            },
                            "required": ["label"],
                        },
                    },
                },
                "required": ["question", "header", "options"],
            },
        }
    },
    "required": ["questions"],
}


def _format_ask_result(questions: list, answers: list) -> str:
    """Render the user's submitted answers as the tool result the agent reads."""
    lines = ["The user answered:"]
    for i, q in enumerate(questions):
        header = q.get("header") or q.get("question") or f"Q{i + 1}"
        picked = answers[i] if i < len(answers) else []
        if isinstance(picked, str):
            picked = [picked]
        lines.append(f"- {header}: {', '.join(picked) if picked else '(no answer)'}")
    return "\n".join(lines)

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
        # In-flight ask_user calls: id -> (Future, questions). The future is
        # resolved by the websocket when the browser submits answers.
        self.pending_asks: dict = {}
        self._ask_seq = 0
        # tool_use ids for ask_user calls, so we can hide the raw tool_use /
        # tool_result events (the ask / ask_answered cards stand in for them).
        self._ask_tool_use_ids: set = set()

    # --- lifecycle -------------------------------------------------------

    def ensure_task(self):
        if self.task is None or self.task.done():
            self.task = asyncio.create_task(self._run())

    async def _ensure_client(self):
        if self.client is not None:
            return
        # On Bedrock/Vertex the opus/sonnet/haiku aliases don't resolve — let
        # Claude Code use the model configured in its env (ANTHROPIC_MODEL).
        model = None if claude_auth.backend() else resolve_model(self.model)
        ask_server = create_sdk_mcp_server(
            name=ASK_SERVER, tools=[self._build_ask_tool()])
        opts = ClaudeAgentOptions(
            cwd=self.cwd,
            permission_mode=PERMISSION_MODE,
            model=model,
            resume=self.session_id,
            system_prompt={"type": "preset", "preset": "claude_code",
                           "append": ASK_PROMPT_APPEND},
            mcp_servers={ASK_SERVER: ask_server},
            allowed_tools=[ASK_QUALIFIED],
            disallowed_tools=["AskUserQuestion"],
            include_partial_messages=True,  # token-level streaming
        )
        self.client = ClaudeSDKClient(options=opts)
        await self.client.connect()

    async def _run(self):
        try:
            await self._ensure_client()
        except CLINotFoundError:
            await self._emit({"role": "error", "text":
                "Claude Code (the 'claude' CLI) isn't installed on the host, so UI "
                "mode can't start. Install it (see the Claude Code docs) and retry."})
            await self._status()
            return
        except Exception as e:  # connection / auth failure
            # The chip can read "connected" just because a credentials file exists,
            # yet the real `claude` start can still fail (expired token, not logged
            # in, root without IS_SANDBOX). Surface the actual reason + how to fix.
            stderr = (getattr(e, "stderr", "") or "").strip()
            exit_code = getattr(e, "exit_code", None)
            msg = ("Couldn't start Claude — you may need to sign in. Open the "
                   "Claude connection (the chip at the bottom of the sidebar) and "
                   "sign in, or run 'claude' once in a terminal to log in.")
            details = "; ".join(p for p in [
                f"claude exited {exit_code}" if exit_code is not None else "",
                stderr,
            ] if p)
            if details:
                msg += f"\n\nDetails: {details}"
            await self._emit({"role": "error", "text": msg})
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
                    # Our ask_user tool is represented by the ask/ask_answered
                    # cards, so don't also dump its raw tool_use JSON.
                    if b.name == ASK_QUALIFIED:
                        self._ask_tool_use_ids.add(b.id)
                        continue
                    await self._emit({"role": "tool_use", "name": b.name, "input": b.input})
        elif isinstance(msg, UserMessage):
            for b in getattr(msg, "content", None) or []:
                if isinstance(b, ToolResultBlock):
                    if getattr(b, "tool_use_id", None) in self._ask_tool_use_ids:
                        self._ask_tool_use_ids.discard(b.tool_use_id)
                        continue
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

    # --- interactive ask_user -------------------------------------------

    def _build_ask_tool(self):
        @tool(ASK_TOOL,
              "Ask the user one or more multiple-choice questions and wait for "
              "their answer. Renders an interactive picker in the web UI.",
              ASK_SCHEMA)
        async def ask_user(args):
            questions = args.get("questions") or []
            if not questions:
                return {"content": [{"type": "text",
                                     "text": "No questions provided."}],
                        "is_error": True}
            self._ask_seq += 1
            qid = f"{self.name}:{self._ask_seq}"
            fut = asyncio.get_event_loop().create_future()
            self.pending_asks[qid] = (fut, questions)
            # Persist + broadcast so reconnecting browsers see the open card.
            await self._emit({"role": "ask", "id": qid, "questions": questions})
            try:
                answers = await fut
            except asyncio.CancelledError:
                self.pending_asks.pop(qid, None)
                raise
            finally:
                self.pending_asks.pop(qid, None)
            await self._emit({"role": "ask_answered", "id": qid,
                              "answers": answers})
            return {"content": [{"type": "text",
                                 "text": _format_ask_result(questions, answers)}]}
        return ask_user

    def resolve_ask(self, qid, answers):
        """Called from the websocket when the browser submits answers."""
        entry = self.pending_asks.get(qid)
        if not entry:
            return False
        fut, _questions = entry
        if not fut.done():
            fut.set_result(answers)
        return True

    def _cancel_pending_asks(self):
        for fut, _q in self.pending_asks.values():
            if not fut.done():
                fut.cancel()
        self.pending_asks.clear()

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
        self._cancel_pending_asks()
        if self.client and self.busy:
            try:
                await self.client.interrupt()
            except Exception:
                pass

    async def set_model(self, alias):
        if claude_auth.backend():  # cloud backend pins its own model via env
            return
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
        self._cancel_pending_asks()
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
        self._cancel_pending_asks()
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

    def set_group(self, name, group):
        if name not in self.registry:
            return
        self.registry[name]["group"] = group
        r = self.runners.get(name)
        if r:
            r.group = group
        self._persist_registry()

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
