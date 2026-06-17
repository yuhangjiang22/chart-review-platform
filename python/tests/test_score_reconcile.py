"""Unit tests for the score-reconciliation helpers (port of agent_v2's
sync_score_from_reasoning): parse_stated_score + last_field_call_args."""
from langchain_core.messages import AIMessage, ToolMessage
from chart_review_deepagents.messages_util import (
    parse_stated_score,
    last_field_call_args,
)


# ── parse_stated_score ──────────────────────────────────────────────────────

def test_parse_stated_score_basic():
    assert parse_stated_score("…onset 30 days. Score: 2") == 2


def test_parse_stated_score_negative_and_signed():
    assert parse_stated_score("competing cause present. Score: -2") == -2
    assert parse_stated_score("Score = +3 after doubling") == 3


def test_parse_stated_score_takes_last_marker():
    # An item may discuss a hypothetical score before stating its final one.
    txt = "If alone, score 3; with co-drug the Score: 1"
    assert parse_stated_score(txt) == 1


def test_parse_stated_score_absent_or_empty():
    assert parse_stated_score("no marker here") is None
    assert parse_stated_score("") is None
    assert parse_stated_score(None) is None


def test_parse_stated_score_ignores_unrelated_numbers():
    # "5-90 days" must not be read as a score; only the Score: marker counts.
    assert parse_stated_score("onset within 5-90 days window. Score: 2") == 2


# ── last_field_call_args ────────────────────────────────────────────────────

def _call(fid, answer, rationale=None, evidence=None):
    args = {"field_id": fid, "answer": answer}
    if rationale is not None:
        args["rationale"] = rationale
    if evidence is not None:
        args["evidence"] = evidence
    return AIMessage(content="", tool_calls=[
        {"name": "set_field_assessment", "args": args, "id": "tc"}])


def test_last_field_call_args_returns_full_args():
    ev = [{"source": "computed"}]
    msgs = [_call("item_1_time_to_onset", 2, rationale="onset 30d. Score: 2", evidence=ev)]
    args = last_field_call_args(msgs, "item_1_time_to_onset")
    assert args["answer"] == 2
    assert args["rationale"] == "onset 30d. Score: 2"
    assert args["evidence"] == ev


def test_last_field_call_args_last_write_wins():
    msgs = [
        _call("item_5_exclusion", 1, rationale="first try. Score: 1"),
        _call("item_5_exclusion", -2, rationale="reconsidered. Score: -2"),
    ]
    args = last_field_call_args(msgs, "item_5_exclusion")
    assert args["answer"] == -2 and "Score: -2" in args["rationale"]


def test_last_field_call_args_missing_field():
    msgs = [_call("item_1_time_to_onset", 2)]
    assert last_field_call_args(msgs, "item_5_exclusion") == {}
