# chart_review_deepagents/__main__.py
# Usage: python -m chart_review_deepagents <runspec.json>
#
# Run spec shape (written by DeepAgentsProvider):
#   { "prompt": str, "system_prompt": str, "max_turns": int,
#     "mcp": { "command": str, "args": [str], "env": {str:str}, "type": "stdio" } }
#
# Emits AgentEvent JSONL on stdout (one event per line). All diagnostics
# go to stderr — stdout is reserved for the event stream.
import asyncio
import json
import sys
import traceback

from langchain_mcp_adapters.client import MultiServerMCPClient
from deepagents import create_deep_agent

from .models import make_model
from .events import messages_to_events, emit


async def run(spec: dict) -> None:
    mcp = spec["mcp"]
    client = MultiServerMCPClient(
        {
            "chart_review_state": {
                "command": mcp["command"],
                "args": mcp["args"],
                "env": mcp.get("env", {}),
                "transport": "stdio",
            }
        }
    )
    tools = await client.get_tools()
    agent = create_deep_agent(
        model=make_model(),
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
    except Exception as e:  # surface any failure as an AgentEvent error
        traceback.print_exc()
        emit({"type": "error", "error": f"{type(e).__name__}: {e}"})
        raise SystemExit(1)


if __name__ == "__main__":
    main()
