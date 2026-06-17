"""Helpers for inspecting an agent run's message list."""
from typing import Iterable, Set
from langchain_core.messages import AIMessage, ToolMessage


def set_field_committed(msgs: Iterable) -> bool:
    """True once a set_field_assessment TOOL RESULT (ToolMessage) is present and
    not an error — i.e. the write actually EXECUTED.

    Used for stop-on-score convergence: a per-item conversation can stop the
    moment its field is committed (mirrors agent_v2's structured-output stop,
    preventing the agent from continuing to search/re-score). We key off the
    RESULT, not the AIMessage tool_call, because breaking on the call would
    cancel the graph before the MCP write runs — losing the score."""
    for m in msgs:
        if isinstance(m, ToolMessage) and getattr(m, "name", None) == "set_field_assessment":
            if getattr(m, "status", "success") != "error":
                return True
    return False


def fields_written(msgs: Iterable) -> Set[str]:
    """field_ids the agent wrote via set_field_assessment in this conversation.
    Used by the per-item loop to decide success vs retry."""
    out: Set[str] = set()
    for m in msgs:
        if isinstance(m, AIMessage):
            for tc in (getattr(m, "tool_calls", None) or []):
                if tc.get("name") == "set_field_assessment":
                    fid = (tc.get("args") or {}).get("field_id")
                    if fid:
                        out.add(fid)
    return out


def field_answers(msgs) -> dict:
    """{field_id: answer} the agent wrote via set_field_assessment (last write wins)."""
    out = {}
    for m in msgs:
        if isinstance(m, AIMessage):
            for tc in (getattr(m, "tool_calls", None) or []):
                if tc.get("name") == "set_field_assessment":
                    args = tc.get("args") or {}
                    fid = args.get("field_id")
                    if fid:
                        out[fid] = args.get("answer")
    return out
