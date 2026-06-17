from langchain_core.messages import AIMessage, HumanMessage
from chart_review_deepagents.messages_util import fields_written

def test_detects_set_field_assessment_field_ids():
    msgs = [
        HumanMessage(content="score item 5"),
        AIMessage(content="", tool_calls=[
            {"name": "set_field_assessment", "args": {"field_id": "item_5_exclusion", "answer": -2}, "id": "1"},
        ]),
    ]
    assert fields_written(msgs) == {"item_5_exclusion"}

def test_ignores_other_tools_and_empty():
    msgs = [AIMessage(content="", tool_calls=[{"name": "search_notes", "args": {"keyword": "ANA"}, "id": "2"}])]
    assert fields_written(msgs) == set()
    assert fields_written([]) == set()
