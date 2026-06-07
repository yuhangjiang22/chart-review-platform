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
import sys
import traceback

from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain_mcp_adapters.tools import load_mcp_tools
from deepagents import create_deep_agent

from .models import make_model
from .events import messages_to_events, emit


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
        tools = await load_mcp_tools(session)
        agent = create_deep_agent(
            model=make_model(spec.get("model")),
            tools=tools,
            system_prompt=spec.get("system_prompt", ""),
        )
        seen = 0
        last_text = ""
        config = {"recursion_limit": int(spec.get("max_turns", 60)) * 2 + 10}
        async for chunk in agent.astream(
            {"messages": [{"role": "user", "content": spec["prompt"]}]},
            stream_mode="values",
            config=config,
        ):
            msgs = chunk.get("messages", [])
            # stream_mode="values" yields the full message list each step;
            # only emit the newly-appended tail.
            for ev in messages_to_events(msgs[seen:]):
                if ev["type"] == "text":
                    last_text = ev["text"]
                emit(ev)
            seen = len(msgs)
    emit({"type": "result", "result": last_text})


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
