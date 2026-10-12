import inspect

from chart_review_deepagents.plugins import load_python_plugins


def _by_name(tools):
    return {t.__name__: t for t in tools}


def test_loads_and_binds(tmp_path):
    tools = load_python_plugins(["chart_review_plugins._demo"], bind={"data_dir": str(tmp_path)})
    assert len(tools) == 2
    assert _by_name(tools).keys() == {"demo_lab", "demo_patient"}  # names preserved for the LLM tool schema
    assert _by_name(tools)["demo_lab"]() == {"data_dir": str(tmp_path), "ok": True}  # data_dir bound


def test_bind_is_forced_over_llm_args(tmp_path):
    # The agent must not be able to override the bound run context (which patient/dir).
    tools = load_python_plugins(["chart_review_plugins._demo"], bind={"data_dir": str(tmp_path)})
    assert _by_name(tools)["demo_lab"](data_dir="/agent/picked/wrong")["data_dir"] == str(tmp_path)


def test_bind_ignores_params_the_tool_does_not_declare():
    # person_id is not a param of demo_lab -> must be dropped (no TypeError).
    tools = load_python_plugins(["chart_review_plugins._demo"], bind={"data_dir": "/x", "person_id": 9001})
    assert _by_name(tools)["demo_lab"]()["data_dir"] == "/x"


def test_bound_params_are_hidden_from_the_schema():
    # The prompts tell the agent these tools are already bound and to pass no
    # arguments. If a bound param stays in the signature deepagents builds the
    # schema from, that empty call is rejected by validation (person_id: Field
    # required) before the binding wrapper ever runs — which is what the
    # 2026-10-12 Qwen RUCAM runs hit on 6 of 7 patients.
    tools = load_python_plugins(["chart_review_plugins._demo"],
                                bind={"data_dir": "/x", "person_id": 9001})
    fn = _by_name(tools)["demo_patient"]
    params = inspect.signature(fn).parameters        # follows __wrapped__ unless hidden
    assert "person_id" not in params and "data_dir" not in params
    assert "keyword" in params                       # unbound params still exposed
    assert "person_id" not in fn.__annotations__     # nor via get_type_hints
    assert fn() == {"person_id": 9001, "keyword": "", "data_dir": "/x", "ok": True}


def test_unbound_tool_keeps_its_full_signature():
    # No bind -> nothing to hide; the schema must still carry every param.
    tools = load_python_plugins(["chart_review_plugins._demo"])
    params = inspect.signature(_by_name(tools)["demo_patient"]).parameters
    assert set(params) == {"person_id", "keyword", "data_dir"}


def test_empty_is_noop():
    assert load_python_plugins([], bind={"data_dir": "x"}) == []
    assert load_python_plugins(None) == []
