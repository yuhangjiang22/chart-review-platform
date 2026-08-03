from chart_review_deepagents.plugins import load_python_plugins


def test_loads_and_binds(tmp_path):
    tools = load_python_plugins(["chart_review_plugins._demo"], bind={"data_dir": str(tmp_path)})
    assert len(tools) == 1
    assert tools[0].__name__ == "demo_lab"  # name preserved for the LLM tool schema
    assert tools[0]() == {"data_dir": str(tmp_path), "ok": True}  # data_dir bound


def test_bind_is_forced_over_llm_args(tmp_path):
    # The agent must not be able to override the bound run context (which patient/dir).
    tools = load_python_plugins(["chart_review_plugins._demo"], bind={"data_dir": str(tmp_path)})
    assert tools[0](data_dir="/agent/picked/wrong")["data_dir"] == str(tmp_path)


def test_bind_ignores_params_the_tool_does_not_declare():
    # person_id is not a param of demo_lab -> must be dropped (no TypeError).
    tools = load_python_plugins(["chart_review_plugins._demo"], bind={"data_dir": "/x", "person_id": 9001})
    assert tools[0]()["data_dir"] == "/x"


def test_empty_is_noop():
    assert load_python_plugins([], bind={"data_dir": "x"}) == []
    assert load_python_plugins(None) == []
