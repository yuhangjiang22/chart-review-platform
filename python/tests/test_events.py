from langchain_core.messages import AIMessage, ToolMessage
from chart_review_deepagents.events import messages_to_events


def test_ai_text_and_tool_call():
    msg = AIMessage(
        content="hello",
        tool_calls=[{"name": "read_note", "args": {"note_id": "n1"}, "id": "tc1"}],
    )
    events = list(messages_to_events([msg]))
    assert {"type": "text", "text": "hello"} in events
    assert any(
        e["type"] == "tool_use"
        and e["tool_name"] == "read_note"
        and e["tool_use_id"] == "tc1"
        for e in events
    )


def test_tool_message():
    msg = ToolMessage(content="note body", tool_call_id="tc1")
    events = list(messages_to_events([msg]))
    assert events == [
        {"type": "tool_result", "tool_use_id": "tc1", "output": "note body"}
    ]
