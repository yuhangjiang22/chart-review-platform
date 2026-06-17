"""Helpers for inspecting an agent run's message list."""
from typing import Iterable, Set
from langchain_core.messages import AIMessage


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
