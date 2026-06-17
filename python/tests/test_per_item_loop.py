"""Unit tests for the per-item scoring loop (`_score_items`) without a real LLM.

A fake agent supplies a scripted `astream` async-generator yielding
{"messages": [...]} chunks. We assert the loop:
  (1) records the REAL answer the agent wrote (incl. 0) in `prior`;
  (2) retries up to max_attempts when a field is never written, and records None.
"""
import asyncio

from langchain_core.messages import AIMessage
from chart_review_deepagents.__main__ import _score_items


def _write(field_id, answer):
    """An AIMessage with a set_field_assessment tool call for one field."""
    return AIMessage(content="", tool_calls=[
        {"name": "set_field_assessment",
         "args": {"field_id": field_id, "answer": answer}, "id": "tc"},
    ])


def _noop():
    """An AIMessage that writes nothing (e.g. only searched the notes)."""
    return AIMessage(content="thinking…", tool_calls=[
        {"name": "search_notes", "args": {"keyword": "ANA"}, "id": "tc"},
    ])


class FakeAgent:
    """astream yields the next scripted chunk-list per conversation (per attempt).

    `scripts` is a list — one entry per `_stream_once` call — each a list of
    chunks; each chunk is a dict like {"messages": [<AIMessage>, ...]}.
    """
    def __init__(self, scripts):
        self._scripts = list(scripts)
        self.calls = 0

    def astream(self, _inputs, **_kwargs):
        chunks = self._scripts[self.calls]
        self.calls += 1

        async def gen():
            for chunk in chunks:
                yield chunk

        return gen()


ENTRY1 = {"field_id": "item_1_time_to_onset", "item_number": 1,
          "skill_file": "/chart-review-rucam/references/scoring/item-1.md",
          "keywords": ["onset"]}
ENTRY5 = {"field_id": "item_5_exclusion", "item_number": 5,
          "skill_file": "/chart-review-rucam/references/scoring/item-5-exclusion.md",
          "keywords": ["ANA"]}


def test_written_on_attempt_one_records_real_answer():
    # Item written on the first attempt with answer 0 (a valid, falsy score).
    agent = FakeAgent([[{"messages": [_write("item_1_time_to_onset", 0)]}]])
    prior, final_msgs = asyncio.run(_score_items(agent, [ENTRY1], max_attempts=2, config={}))
    assert agent.calls == 1                       # no retry needed
    assert prior == [{"item_number": 1, "field_id": "item_1_time_to_onset", "answer": 0}]
    assert final_msgs                             # messages were collected


def test_never_written_retries_then_records_none():
    # Both attempts write nothing -> retry to max_attempts, answer is None.
    agent = FakeAgent([
        [{"messages": [_noop()]}],
        [{"messages": [_noop()]}],
    ])
    prior, _ = asyncio.run(_score_items(agent, [ENTRY5], max_attempts=2, config={}))
    assert agent.calls == 2                       # retried up to max_attempts
    assert prior == [{"item_number": 5, "field_id": "item_5_exclusion", "answer": None}]


def test_retry_succeeds_on_second_attempt():
    # First attempt fails, second writes a real score; only 2 calls (stops early).
    agent = FakeAgent([
        [{"messages": [_noop()]}],
        [{"messages": [_write("item_5_exclusion", -2)]}],
    ])
    prior, _ = asyncio.run(_score_items(agent, [ENTRY5], max_attempts=3, config={}))
    assert agent.calls == 2
    assert prior == [{"item_number": 5, "field_id": "item_5_exclusion", "answer": -2}]


def test_prior_threads_real_score_into_next_item():
    # Two items: item 1 writes 2, then item 5 writes -3. The prior list must
    # carry the actual scores (so item 5's prompt sees item 1's real answer).
    agent = FakeAgent([
        [{"messages": [_write("item_1_time_to_onset", 2)]}],
        [{"messages": [_write("item_5_exclusion", -3)]}],
    ])
    prior, _ = asyncio.run(_score_items(agent, [ENTRY1, ENTRY5], max_attempts=2, config={}))
    assert prior == [
        {"item_number": 1, "field_id": "item_1_time_to_onset", "answer": 2},
        {"item_number": 5, "field_id": "item_5_exclusion", "answer": -3},
    ]
