from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from chart_review_deepagents.messages_util import fields_written, field_answers, set_field_committed

def test_detects_set_field_assessment_field_ids():
    msgs = [
        HumanMessage(content="score item 5"),
        AIMessage(content="", tool_calls=[
            {"name": "set_field_assessment", "args": {"field_id": "item_5_exclusion", "answer": -2}, "id": "1"},
        ]),
    ]
    assert fields_written(msgs) == {"item_5_exclusion"}

def test_field_answers_returns_the_real_score():
    msgs = [
        HumanMessage(content="score item 5"),
        AIMessage(content="", tool_calls=[
            {"name": "set_field_assessment", "args": {"field_id": "item_5_exclusion", "answer": -2}, "id": "1"},
        ]),
    ]
    assert field_answers(msgs) == {"item_5_exclusion": -2}

def test_field_answers_keeps_a_zero_answer():
    # answer can legitimately be 0 — it must NOT be dropped as falsy.
    msgs = [AIMessage(content="", tool_calls=[
        {"name": "set_field_assessment", "args": {"field_id": "item_1_time_to_onset", "answer": 0}, "id": "1"},
    ])]
    answers = field_answers(msgs)
    assert answers == {"item_1_time_to_onset": 0}
    assert "item_1_time_to_onset" in answers  # membership, not truthiness

def test_ignores_other_tools_and_empty():
    msgs = [AIMessage(content="", tool_calls=[{"name": "search_notes", "args": {"keyword": "ANA"}, "id": "2"}])]
    assert fields_written(msgs) == set()
    assert fields_written([]) == set()


def test_set_field_committed_keys_off_the_result_not_the_call():
    # The tool CALL alone (no result) is NOT committed — breaking here would
    # cancel the graph before the MCP write runs, losing the score.
    call_only = [AIMessage(content="", tool_calls=[
        {"name": "set_field_assessment", "args": {"field_id": "x", "answer": 1}, "id": "1"}])]
    assert set_field_committed(call_only) is False
    # The tool RESULT (ToolMessage) means the write executed -> committed.
    committed = call_only + [ToolMessage(content='{"ok":true}', tool_call_id="1", name="set_field_assessment")]
    assert set_field_committed(committed) is True


def test_set_field_committed_false_on_error_or_other_tool():
    err = [ToolMessage(content="boom", tool_call_id="1", name="set_field_assessment", status="error")]
    assert set_field_committed(err) is False
    other = [ToolMessage(content="hits", tool_call_id="2", name="search_notes")]
    assert set_field_committed(other) is False
    assert set_field_committed([]) is False


def test_set_field_committed_false_on_rejected_write_returned_as_content():
    # A rejected write comes back as a non-error ToolMessage whose CONTENT is a
    # TOOL_ERROR (recoverable) — it must NOT count as committed, or the field is
    # silently dropped. This is the real bug the incomplete 4/7 draft exposed.
    rejected = [ToolMessage(
        content="TOOL_ERROR: omop/structured evidence requires table and row_id",
        tool_call_id="1", name="set_field_assessment")]
    assert set_field_committed(rejected) is False
    ok = [ToolMessage(content='{"ok":true,"action_type":"set_field_assessment"}',
                      tool_call_id="1", name="set_field_assessment")]
    assert set_field_committed(ok) is True
