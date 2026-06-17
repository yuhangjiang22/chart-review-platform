# chart_review_deepagents/__main__.py
# Usage: python -m chart_review_deepagents <runspec.json>
#
# Run spec shape (written by DeepAgentsProvider):
#   { "prompt": str, "system_prompt": str, "max_turns": int, "model": str|None,
#     "mcp": { "command": str, "args": [str], "env": {str:str}, "type": "stdio" } }
#
# Emits AgentEvent JSONL on stdout (one event per line). All diagnostics
# go to stderr — stdout is reserved for the event stream.
import asyncio
import json
import os
import sys
import traceback

from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain_mcp_adapters.tools import load_mcp_tools
from langchain_core.tools import ToolException
from deepagents import create_deep_agent

from .models import make_model
from .events import messages_to_events, emit
from .plugins import load_python_plugins


def _recoverable(tools):
    """Wrap each MCP tool so a tool-side failure (faithfulness-gate rejection,
    `incomplete_review`, etc.) is returned to the model as a normal observation
    instead of raising out of the agent loop and crashing the whole run.

    langchain-mcp-adapters raises `ToolException` whenever the MCP server marks
    a result `isError`. The default agent loop lets that propagate, so a single
    bad quote or a stray `set_review_status` aborts the patient. Returning the
    error text instead lets the model self-correct (re-quote, commit the missing
    field) — exactly what the faithfulness gate is designed to drive."""
    for tool in tools:
        orig = tool.coroutine

        async def safe(*args, _orig=orig, _tool=tool, **kwargs):
            try:
                return await _orig(*args, **kwargs)
            except ToolException as e:
                msg = (
                    f"TOOL_ERROR: {e}\n"
                    "This is a recoverable error, not a stop signal. Read the "
                    "message, fix the cause (copy the quote verbatim from the "
                    "note, or commit the missing field), and call the tool "
                    "again. Do not call `set_review_status`."
                )
                # langchain-mcp-adapters loads MCP tools with
                # response_format='content_and_artifact', so the coroutine MUST
                # return a (content, artifact) two-tuple — returning a bare str
                # raises ValueError and crashes the run. Match the tool's format.
                if getattr(_tool, "response_format", None) == "content_and_artifact":
                    return msg, {"error": str(e)}
                return msg

        tool.coroutine = safe
    return tools


async def run(spec: dict) -> None:
    mcp = spec["mcp"]
    mcp_env = mcp.get("env", {})
    conn = {
        "command": mcp["command"],
        "args": mcp["args"],
        "env": mcp_env,
        "transport": "stdio",
    }
    # Run the stdio MCP server from the platform root so `npx tsx` resolves
    # the repo-local tsx binary (the sidecar's own cwd is python/, which has
    # no node_modules). CHART_REVIEW_PLATFORM_ROOT is carried in the env the
    # TS provider passes through.
    platform_root = mcp_env.get("CHART_REVIEW_PLATFORM_ROOT")
    if platform_root:
        conn["cwd"] = platform_root
    client = MultiServerMCPClient({"chart_review_state": conn})
    # Hold ONE MCP session open for the entire agent run. get_tools() runs
    # each tool call in a fresh server process (stateless), which breaks the
    # stateful review_state.json accumulation the chart_review_state server
    # relies on — set_field_assessment writes wouldn't accumulate. A single
    # persistent session keeps one server process alive across all tool calls.
    async with client.session("chart_review_state") as session:
        tools = _recoverable(await load_mcp_tools(session))
        # Append task-specific read/compute plugin tools (e.g. RUCAM's) selected
        # by the task's tool profile. The MCP tools (writes + note faithfulness)
        # remain the primary surface; plugins are read/compute only.
        plugin_bind = {"data_dir": spec.get("data_dir", "data"), **(spec.get("plugin_bind") or {})}
        plugin_tools = load_python_plugins(spec.get("python_plugins", []), plugin_bind)
        if plugin_tools:
            print(
                f"[plugins] loaded {len(plugin_tools)} plugin tool(s): "
                f"{', '.join(t.__name__ for t in plugin_tools)}",
                file=sys.stderr,
            )
        tools = tools + plugin_tools
        # Per-item mode uses short, single-item conversations that stay well under
        # Azure's 128 tool_calls cap, so allow parallel tool-call batching (far
        # fewer turns -> fewer context re-sends -> much cheaper). The note-heavy
        # single-call path keeps serial to avoid the 128 overflow.
        agent_kwargs = dict(
            model=make_model(spec.get("model"),
                             serial_tool_calls=not bool(spec.get("per_item"))),
            tools=tools,
            system_prompt=spec.get("system_prompt", ""),
        )
        # Load task skills when the run requests them (e.g. RUCAM's per-item
        # scoring methodology). deepagents skills need a FilesystemBackend; we
        # root it at .claude/skills (NOT the platform root) so the skill read_file
        # can reach skill files only — patient notes stay behind the MCP
        # faithfulness gate, never readable through this backend.
        skills = spec.get("skills") or []
        if skills:
            from deepagents.backends.filesystem import FilesystemBackend
            skills_root = os.path.join(
                os.environ.get("CHART_REVIEW_PLATFORM_ROOT", "."), ".claude", "skills"
            )
            agent_kwargs["backend"] = FilesystemBackend(root_dir=skills_root, virtual_mode=True)
            agent_kwargs["skills"] = skills
            print(f"[skills] loaded: {', '.join(skills)} (root {skills_root})", file=sys.stderr)
        agent = create_deep_agent(**agent_kwargs)
        config = {"recursion_limit": int(spec.get("max_turns", 90)) * 2 + 10}

        per_item = spec.get("per_item")
        if per_item:
            # RUCAM-style per-item scoring: drive ONE conversation per rubric
            # item, retrying an item until its field is written (or max attempts
            # exhausted). `prior` carries the real scores of already-scored items
            # into each subsequent item's task prompt.
            max_attempts = int(spec.get("per_item_max_attempts", 2))
            prior, final_msgs = await _score_items(agent, per_item, max_attempts, config)
            last_text = "per-item scoring complete"
        else:
            # Immediate activity marker. astream(stream_mode="values") yields
            # nothing until the first super-step (model call) completes — ~5-15s
            # of apparent silence during which the live agent-log shows "waiting
            # for agent activity". Emit a start line up front so the reviewer sees
            # the agent is alive the instant it launches. Display-only: this flows
            # to the transcript/audit log, not to the draft (which comes from the
            # MCP review_state) or the run's success/error tally.
            emit({"type": "text", "text": "Agent started — reading the chart and rubric…"})
            final_msgs, last_text = await _stream_once(agent, spec["prompt"], config)
    _log_usage(spec, final_msgs)
    emit({"type": "result", "result": last_text})


async def _score_items(agent, per_item, max_attempts: int, config: dict):
    """Drive ONE conversation per rubric item, retrying an item until its field
    is written (or max_attempts exhausted). Threads the REAL score the agent
    wrote for each item into the `prior` context passed to later items.

    Returns (prior, final_msgs):
      - prior: list of {item_number, field_id, answer} — answer is the actual
        score the agent wrote (may be 0, a valid score), or None if never written.
      - final_msgs: concatenation of every attempt's message list (for usage log).
    """
    from .rucam_prompts import build_item_task_prompt
    from .messages_util import field_answers

    prior = []
    final_msgs = []
    for entry in per_item:
        fid = entry["field_id"]
        wrote = False
        answer = None
        for attempt in range(1, max_attempts + 1):
            emit({"type": "text",
                  "text": f"Scoring item {entry['item_number']} ({fid}), attempt {attempt}…"})
            msgs, _last_text = await _stream_once(agent, build_item_task_prompt(entry, prior), config)
            final_msgs += msgs
            answers = field_answers(msgs)
            # Membership, NOT truthiness — a score of 0 is a valid write.
            if fid in answers:
                wrote = True
                answer = answers.get(fid)
                break
        if not wrote:
            emit({"type": "text", "text": f"WARNING: {fid} not written after {max_attempts} attempts"})
        prior.append({"item_number": entry["item_number"], "field_id": fid, "answer": answer})
    return prior, final_msgs


async def _stream_once(agent, user_content: str, config: dict):
    """Run one agent conversation; emit new events as they arrive; return (final_msgs, last_text)."""
    seen = 0
    final_msgs = []
    last_text = ""
    async for chunk in agent.astream(
        {"messages": [{"role": "user", "content": user_content}]},
        stream_mode="values", config=config,
    ):
        msgs = chunk.get("messages", [])
        final_msgs = msgs
        for ev in messages_to_events(msgs[seen:]):
            if ev["type"] == "text":
                last_text = ev["text"]
            emit(ev)
        seen = len(msgs)
    return final_msgs, last_text


def _log_usage(spec: dict, msgs) -> None:
    """Append this run's token usage to DEEPAGENTS_USAGE_LOG (one JSON line per
    patient). Lets a batch tally real input/output tokens for cost accounting —
    the transcript only logs tool calls, and vLLM reports $0. No-op when the
    env var is unset."""
    log_path = os.environ.get("DEEPAGENTS_USAGE_LOG")
    if not log_path:
        return
    inp = out = tot = cached = reasoning = 0
    from langchain_core.messages import AIMessage
    for m in msgs:
        if isinstance(m, AIMessage):
            u = getattr(m, "usage_metadata", None) or {}
            inp += int(u.get("input_tokens", 0) or 0)
            out += int(u.get("output_tokens", 0) or 0)
            tot += int(u.get("total_tokens", 0) or 0)
            # cost-relevant splits: cached input bills far cheaper; reasoning
            # tokens (gpt-5.x) bill as output. Present in usage_metadata details.
            cached += int((u.get("input_token_details") or {}).get("cache_read", 0) or 0)
            reasoning += int((u.get("output_token_details") or {}).get("reasoning", 0) or 0)
    rec = {"model": spec.get("model"), "input_tokens": inp,
           "cached_input_tokens": cached, "output_tokens": out,
           "reasoning_tokens": reasoning, "total_tokens": tot or (inp + out)}
    try:
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec) + "\n")
    except OSError as e:
        print(f"[usage] could not write {log_path}: {e}", file=sys.stderr)


def main() -> None:
    if len(sys.argv) < 2:
        print("usage: python -m chart_review_deepagents <runspec.json>", file=sys.stderr)
        raise SystemExit(2)
    with open(sys.argv[1], "r", encoding="utf-8") as f:
        spec = json.load(f)
    try:
        asyncio.run(run(spec))
    except BaseException as e:  # includes (Base)ExceptionGroup from TaskGroups
        traceback.print_exc()
        emit({"type": "error", "error": _format_exc(e)})
        raise SystemExit(1)


def _format_exc(e: BaseException) -> str:
    """Flatten ExceptionGroups so the emitted error names the real cause
    instead of the opaque 'unhandled errors in a TaskGroup (1 sub-exception)'."""
    excs = getattr(e, "exceptions", None)
    if excs:
        return " | ".join(_format_exc(sub) for sub in excs)
    return f"{type(e).__name__}: {e}"


if __name__ == "__main__":
    main()
