"""Helpers for inspecting an agent run's message list."""
import re
from typing import Iterable, Optional, Set
from langchain_core.messages import AIMessage, ToolMessage

# Trailing "Score: X" marker the per-item prompt asks the agent to end its
# rationale with (e.g. "Score: -2"). Mirrors agent_v2/prompts.py + the
# sync_score_from_reasoning validator in agent_v2/output_schema.py.
_SCORE_MARKER = re.compile(r"\bscore[:\s=]+([+-]?\d+)", re.IGNORECASE)


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
            if getattr(m, "status", "success") == "error":
                continue
            # A successful write returns {"ok":true,...}; a rejected one comes back
            # as "TOOL_ERROR: ..." (recoverable). Only the former is a real commit —
            # keying off the call (or any result) would treat a rejected write as
            # done, leaving the field silently unscored.
            content = str(getattr(m, "content", "") or "").replace(" ", "").lower()
            if '"ok":true' in content:
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


def last_field_call_args(msgs, fid: str) -> dict:
    """The args of the LAST set_field_assessment call for `fid` (last-write-wins,
    matching field_answers). Returns {} if the field was never written. Used by
    the per-item loop to recover the committed rationale + evidence for score
    reconciliation / re-commit."""
    out: dict = {}
    for m in msgs:
        if isinstance(m, AIMessage):
            for tc in (getattr(m, "tool_calls", None) or []):
                if tc.get("name") == "set_field_assessment":
                    args = tc.get("args") or {}
                    if args.get("field_id") == fid:
                        out = args
    return out


def parse_stated_score(text: Optional[str]) -> Optional[int]:
    """Extract the LAST "Score: X" integer the agent stated in free text (its
    rationale), or None if absent. Ports agent_v2's sync_score_from_reasoning
    regex so concur can reconcile a drifted structured answer against the prose
    conclusion the agent actually reasoned to."""
    if not text:
        return None
    matches = _SCORE_MARKER.findall(text)
    return int(matches[-1]) if matches else None
