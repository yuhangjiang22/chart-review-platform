from chart_review_deepagents.plugins import load_python_plugins


def test_loads_and_binds(tmp_path):
    tools = load_python_plugins(["chart_review_plugins._demo"], data_dir=str(tmp_path))
    assert len(tools) == 1
    # function name preserved so deepagents builds the tool schema from it
    assert tools[0].__name__ == "demo_lab"
    # data_dir pre-bound
    assert tools[0]() == {"data_dir": str(tmp_path), "ok": True}


def test_empty_is_noop():
    assert load_python_plugins([], data_dir="x") == []
    assert load_python_plugins(None, data_dir="x") == []
