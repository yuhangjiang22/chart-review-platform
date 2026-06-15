# chart_review_deepagents/events.py
import sys
import json
from langchain_core.messages import AIMessage, ToolMessage


def messages_to_events(messages):
    """Yield AgentEvent dicts for a list of LangChain messages.
    Mirrors packages/agent-provider's AgentEvent taxonomy."""
    for m in messages:
        if isinstance(m, AIMessage):
            text = m.content if isinstance(m.content, str) else _stringify(m.content)
            if text:
                yield {"type": "text", "text": text}
            for tc in (m.tool_calls or []):
                yield {
                    "type": "tool_use",
                    "tool_name": tc.get("name", "unknown"),
                    "tool_input": tc.get("args", {}),
                    "tool_use_id": tc.get("id"),
                }
        elif isinstance(m, ToolMessage):
            yield {
                "type": "tool_result",
                "tool_use_id": m.tool_call_id,
                "output": m.content if isinstance(m.content, str) else _stringify(m.content),
            }


def _stringify(content):
    # content can be a list of blocks for some providers
    try:
        return "".join(
            b.get("text", "") if isinstance(b, dict) else str(b) for b in content
        )
    except TypeError:
        return str(content)


def emit(event: dict):
    sys.stdout.write(json.dumps(event) + "\n")
    sys.stdout.flush()
