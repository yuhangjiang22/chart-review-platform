"""Core module: run_agent / run_agent_async / AgentResult.

Two entry points:

* `run_agent_async` — coroutine, this is the primary interface. Use it from
  any async context (FastAPI route, asyncio task, pytest-asyncio test).
* `run_agent` — sync wrapper around `run_agent_async`. Internally just
  `asyncio.run(run_agent_async(...))`. Convenient for CLI / scripts; raises
  `RuntimeError` if invoked from inside a running event loop (don't nest).

Earlier this module probed for a running loop and bridged to a thread pool to
avoid `asyncio.run()`-from-inside-async errors. That hack relied on SDK
internals not changing loop policy and broke under `nest_asyncio`. Async-first
is cleaner: callers in async contexts pick the coroutine directly.
"""

import asyncio
import fnmatch
import logging
import random
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from claude_agent_sdk import query, ClaudeAgentOptions
from claude_agent_sdk.types import (
    AssistantMessage,
    HookMatcher,
    ResultMessage,
    SystemMessage,
)

from .providers import resolve_model, resolve_provider_env

logger = logging.getLogger("claude_agent_framework")


# --- Error classification for retry --------------------------------------
# Provider error strings vary (Anthropic uses HTTP-style messages, Azure uses
# AzureError, OpenAI uses RateLimitError text), so we string-match instead of
# pinning to specific exception types. The SDK wraps everything as
# `ProcessError` / `ClaudeSDKError` since errors come from the spawned CLI
# subprocess — the original exception type is lost in the message.
_RETRIABLE_PATTERNS = (
    "429", "500", "502", "503", "504",
    "rate limit", "rate_limit", "ratelimit",
    "timeout", "timed out",
    "connection reset", "connection refused",
    "service unavailable", "temporarily unavailable",
    "overloaded",
)
_FATAL_PATTERNS = (
    "401", "unauthorized", "invalid api key", "invalid_api_key",
    "context_length_exceeded", "context length", "maximum context length",
    "exceeds the maximum",
)


def _make_bash_allowlist_hook(allowed_patterns: list[str]) -> HookMatcher:
    """Build a `PreToolUse` hook that vetoes Bash commands outside an fnmatch
    allow-list.

    Patterns use fnmatch syntax — typically a literal command prefix followed
    by ``*`` to swallow the rest, e.g.::

        "python3 .claude/skills/bso-ad/scripts/write_ner.py *"

    Implemented as a `PreToolUse` hook (not `can_use_tool`) because the SDK
    docstring is explicit: ``can_use_tool`` is **bypassed** under
    ``permission_mode="bypassPermissions"``, while `PreToolUse` hooks fire
    for every tool call regardless of permission mode.

    Cheap defence against prompt-injected exfil (``curl …``, ``env | base64``)
    when the input domain isn't trusted (clinical notes, ingested PubMed
    abstracts, etc.). Pair with `disallowed_tools=["Edit", "Write"]` for full
    coverage.
    """

    async def gate(
        input_data: dict[str, Any],
        tool_use_id: str | None,
        context: dict[str, Any],
    ) -> dict[str, Any]:
        cmd = (input_data.get("tool_input") or {}).get("command", "")
        for pat in allowed_patterns:
            if fnmatch.fnmatchcase(cmd, pat):
                return {
                    "hookSpecificOutput": {
                        "hookEventName": "PreToolUse",
                        "permissionDecision": "allow",
                    }
                }
        preview = cmd if len(cmd) <= 240 else cmd[:240] + "…"
        return {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": (
                    "Bash command rejected by allow-list. The runner restricts "
                    "Bash to a fixed pattern set to limit the prompt-injection "
                    "blast radius. Got:\n"
                    f"  {preview}\n"
                    f"Allowed patterns: {allowed_patterns}"
                ),
            }
        }

    # matcher="Bash" tells the SDK to fire this hook only for the Bash tool.
    return HookMatcher(matcher="Bash", hooks=[gate])


def _classify_error(exc: BaseException) -> str:
    """Return 'retriable', 'fatal', or 'unknown'.

    'fatal' takes precedence over 'retriable' — if a 401 message also
    happens to contain '500', we still want to fail fast.
    """
    msg = str(exc).lower()
    if any(p in msg for p in _FATAL_PATTERNS):
        return "fatal"
    if any(p in msg for p in _RETRIABLE_PATTERNS):
        return "retriable"
    return "unknown"


@dataclass
class AgentResult:
    """Result returned by run_agent()."""

    result: str = ""
    cost_usd: float = 0.0
    turns: int = 0
    duration_ms: int = 0
    session_id: str = ""
    is_error: bool = False
    thinking: list[str] = field(default_factory=list)
    usage: dict | None = None  # input/output/cache_creation/cache_read tokens, when SDK reports them


async def run_agent_async(
    prompt: str,
    *,
    cwd: str | Path | None = None,
    model: str | None = None,
    max_turns: int = 200,
    max_budget_usd: float = 5.0,
    max_thinking_tokens: int | None = None,
    env: dict[str, str] | None = None,
    permission_mode: str = "bypassPermissions",
    setting_sources: list[str] | None = None,
    mcp_servers: dict | str | Path | None = None,
    disallowed_tools: list[str] | None = None,
    allow_web: bool = False,
    allow_edit: bool = False,
    allow_ask_user: bool = False,
    allow_read: bool = True,
    allowed_bash_patterns: list[str] | None = None,
    on_assistant_text: Callable[[str], None] | None = None,
    on_thinking: Callable[[str], None] | None = None,
    on_tool_use: Callable[[str, dict], None] | None = None,
    on_stderr: Callable[[str], None] | None = None,
    max_attempts: int = 3,
    retry_initial_delay: float = 2.0,
    retry_max_delay: float = 30.0,
) -> AgentResult:
    """Run a Claude agent session and return the result. Async-first interface.

    Skills are discovered automatically by the Agent SDK from .claude/skills/
    under cwd when setting_sources includes "project". No explicit skill
    registration is needed — the agent matches skills based on prompt content.

    Args:
        prompt: The task prompt to send to the agent.
        cwd: Working directory for the agent. Should contain .claude/skills/
             for skill auto-discovery.
        model: Claude model to use. Defaults to env var CLAUDE_MODEL or claude-sonnet-4-6.
        max_turns: Maximum number of agent turns.
        max_budget_usd: Cost cap per session in USD.
        max_thinking_tokens: Max tokens for extended thinking. None = SDK default.
        env: Extra environment variables to pass to the agent subprocess.
        permission_mode: Agent permission mode (default: bypassPermissions).
        setting_sources: Where to load .claude/ settings from (default: ["project"]).
        on_assistant_text: Callback for each assistant text block.
        on_thinking: Callback for each thinking block.
        on_tool_use: Callback for each tool use (tool_name, input_dict).
        on_stderr: Callback for agent subprocess stderr lines.
        max_attempts: Total attempts before giving up. Set to 1 to disable retry.
        retry_initial_delay: Seconds to wait before the first retry. Doubles each
            attempt (with jitter), capped at retry_max_delay.
        retry_max_delay: Cap on retry sleep. Default 30s avoids indefinite hang
            on a fully-broken provider.

    Returns:
        AgentResult with the agent's text output, cost, thinking, and metadata.
    """
    resolved_cwd = str(Path(cwd).resolve()) if cwd else None
    resolved_model = model or resolve_model()

    # Build environment: provider credentials + user env
    agent_env = resolve_provider_env(model=resolved_model)
    if env:
        agent_env.update(env)

    # Stderr handler
    def _on_stderr(line: str):
        line = line.rstrip()
        if line:
            if on_stderr:
                on_stderr(line)
            else:
                logger.warning("Agent stderr: %s", line)

    options_kwargs = dict(
        model=resolved_model,
        permission_mode=permission_mode,
        cwd=resolved_cwd,
        env=agent_env,
        max_turns=max_turns,
        max_budget_usd=max_budget_usd,
        setting_sources=setting_sources or ["project"],
        stderr=_on_stderr,
    )
    if mcp_servers is not None:
        options_kwargs["mcp_servers"] = mcp_servers
    blocked = list(disallowed_tools or [])
    if not allow_web:
        for t in ("WebSearch", "WebFetch"):
            if t not in blocked:
                blocked.append(t)
    # Edit / Write are off by default. Most agentic workflows here generate
    # output through dedicated CLI scripts (write_ner.py, write_audit.py)
    # invoked via Bash — letting the model touch arbitrary files in-place
    # invites silent data corruption and broadens the prompt-injection blast
    # radius. Callers that genuinely need free-form file editing must opt in
    # via `allow_edit=True`.
    if not allow_edit:
        for t in ("Edit", "Write"):
            if t not in blocked:
                blocked.append(t)
    # AskUserQuestion is the Claude Code CLI's built-in HITL prompt tool.
    # In headless / batch runs there is no human at the TTY — if the agent
    # invokes it, it hangs / aborts silently with no .json output.
    # Off by default; opt in via allow_ask_user=True for interactive sessions.
    if not allow_ask_user:
        if "AskUserQuestion" not in blocked:
            blocked.append("AskUserQuestion")
    # Read is on by default (most workflows legitimately read source files /
    # config / data). Turn it off for runners where every byte of input is
    # already inlined in the prompt and any agent-initiated Read is wasted
    # token re-injection — e.g. NER, where the source-text sidecar is read
    # by the `locate_in_source` MCP tool internally, not by the agent.
    if not allow_read:
        if "Read" not in blocked:
            blocked.append("Read")
    if blocked:
        options_kwargs["disallowed_tools"] = blocked
    if allowed_bash_patterns:
        options_kwargs["hooks"] = {
            "PreToolUse": [_make_bash_allowlist_hook(list(allowed_bash_patterns))]
        }
    options = ClaudeAgentOptions(**options_kwargs)
    if max_thinking_tokens is not None:
        options.max_thinking_tokens = max_thinking_tokens

    return await _run_agent_async(
        prompt, options, on_assistant_text, on_thinking, on_tool_use,
        max_attempts=max_attempts,
        retry_initial_delay=retry_initial_delay,
        retry_max_delay=retry_max_delay,
    )


def run_agent(prompt: str, **kwargs) -> AgentResult:
    """Sync wrapper around `run_agent_async`. Use from CLI / sync scripts.

    Raises RuntimeError if called from inside a running event loop — in that
    case, await `run_agent_async` directly instead.
    """
    return asyncio.run(run_agent_async(prompt, **kwargs))


async def _run_agent_async(
    prompt: str,
    options: ClaudeAgentOptions,
    on_assistant_text: Callable[[str], None] | None,
    on_thinking: Callable[[str], None] | None,
    on_tool_use: Callable[[str, dict], None] | None,
    *,
    max_attempts: int = 3,
    retry_initial_delay: float = 2.0,
    retry_max_delay: float = 30.0,
) -> AgentResult:
    """Internal async implementation of the agent message loop with retry.

    Retry policy: only retry transient API errors (429 / 5xx / rate-limit /
    timeout) AND only when no message has flowed yet. Once any AssistantMessage
    has been received we'd be double-billing on retry, so we accept the
    partial-progress result as-is. Auth (401) and context-overflow errors
    fail fast without retry.
    """
    logger.info(
        "Starting agent: model=%s, max_turns=%d, budget=$%.2f",
        options.model, options.max_turns, options.max_budget_usd,
    )

    last_exc: BaseException | None = None

    for attempt in range(max_attempts):
        cost = 0.0
        turns = 0
        result_text = ""
        is_error = False
        duration_ms = 0
        session_id = ""
        thinking_blocks: list[str] = []
        usage: dict | None = None
        received_any = False

        if attempt > 0:
            logger.info("Retry attempt %d/%d", attempt + 1, max_attempts)

        try:
            async for message in query(prompt=prompt, options=options):
                received_any = True
                if isinstance(message, AssistantMessage):
                    for block in message.content:
                        # Thinking block (extended thinking / chain-of-thought)
                        if hasattr(block, "thinking") and block.thinking:
                            thinking_blocks.append(block.thinking)
                            if on_thinking:
                                on_thinking(block.thinking)
                            logger.info("Thinking: %s", block.thinking[:500])
                        # Text block
                        elif hasattr(block, "text") and block.text:
                            if on_assistant_text:
                                on_assistant_text(block.text)
                            logger.debug("Assistant: %s", block.text[:200])
                        # Tool use block
                        elif hasattr(block, "name"):
                            tool_input = getattr(block, "input", {}) or {}
                            if on_tool_use:
                                on_tool_use(block.name, tool_input)
                            detail = (
                                tool_input.get("command")
                                or tool_input.get("file_path")
                                or tool_input.get("pattern")
                                or tool_input.get("skill")
                                or str(tool_input)[:200]
                            )
                            logger.info("Tool use: %s → %s", block.name, detail)
                elif isinstance(message, SystemMessage):
                    logger.debug(
                        "System: subtype=%s data=%s",
                        message.subtype, str(message.data)[:200],
                    )
                elif isinstance(message, ResultMessage):
                    cost = message.total_cost_usd or 0.0
                    turns = message.num_turns
                    is_error = message.is_error
                    result_text = message.result or ""
                    duration_ms = message.duration_ms
                    session_id = getattr(message, "session_id", "")
                    raw_usage = getattr(message, "usage", None)
                    if raw_usage is not None:
                        if hasattr(raw_usage, "model_dump"):
                            usage = raw_usage.model_dump()
                        elif isinstance(raw_usage, dict):
                            usage = dict(raw_usage)
                        else:
                            # Fallback: capture every public attribute so any new
                            # SDK fields (service_tier / iterations / speed /
                            # inference_geo / server_tool_use, etc.) survive.
                            try:
                                usage = {
                                    k: v for k, v in vars(raw_usage).items()
                                    if not k.startswith("_")
                                }
                            except TypeError:
                                usage = {}
                    logger.info(
                        "Agent finished: turns=%d, cost=$%.4f, is_error=%s, duration=%dms",
                        turns, cost, is_error, duration_ms,
                    )
        except Exception as e:
            cls = _classify_error(e)
            should_retry = (
                cls == "retriable"
                and not received_any
                and attempt < max_attempts - 1
            )
            if should_retry:
                delay = min(retry_initial_delay * (2 ** attempt), retry_max_delay)
                jitter = delay * 0.25 * random.random()
                wait = delay + jitter
                logger.warning(
                    "Transient error (attempt %d/%d), retrying in %.1fs: %s",
                    attempt + 1, max_attempts, wait, e,
                )
                last_exc = e
                await asyncio.sleep(wait)
                continue
            logger.exception(
                "Agent exception after %d turns, cost=$%.4f (classification=%s, attempts=%d)",
                turns, cost, cls, attempt + 1,
            )
            return AgentResult(
                result=str(e),
                cost_usd=cost,
                turns=turns,
                is_error=True,
                thinking=thinking_blocks,
                usage=usage,
            )

        return AgentResult(
            result=result_text,
            cost_usd=cost,
            turns=turns,
            duration_ms=duration_ms,
            session_id=session_id,
            is_error=is_error,
            thinking=thinking_blocks,
            usage=usage,
        )

    # Defensive — only reachable if the retry loop falls through without
    # returning, which shouldn't happen.
    return AgentResult(
        result=str(last_exc) if last_exc else "max_attempts exhausted",
        is_error=True,
    )
