import pytest


def test_make_model_resolves_registry_key(monkeypatch, tmp_path):
    import json
    from chart_review_deepagents import models as models_mod
    p = tmp_path / "models.json"
    p.write_text(json.dumps({"llama": {"backend": "vllm", "base_url": "http://h:8000/v1",
                                       "model": "meta/Llama"}}))
    monkeypatch.setattr("chart_review_deepagents.registry._DEFAULT_MODELS_PATH", p)
    captured = {}

    class FakeChat:
        def __init__(self, **kw):
            captured.update(kw)

    monkeypatch.setattr("langchain_openai.ChatOpenAI", FakeChat)
    models_mod.make_model("llama")
    assert captured["base_url"] == "http://h:8000/v1"
    assert captured["model"] == "meta/Llama"
    assert captured["api_key"] == "EMPTY"


def test_make_model_unknown_key_raises(monkeypatch, tmp_path):
    import json
    from chart_review_deepagents import models as models_mod
    p = tmp_path / "models.json"
    p.write_text(json.dumps({"llama": {"backend": "vllm", "base_url": "http://h:8000/v1",
                                       "model": "meta/Llama"}}))
    monkeypatch.setattr("chart_review_deepagents.registry._DEFAULT_MODELS_PATH", p)
    with pytest.raises(ValueError, match="unknown model"):
        models_mod.make_model("nope")


def test_make_model_default_key_uses_synthesized_entry(monkeypatch, tmp_path):
    import json
    from chart_review_deepagents import models as models_mod
    monkeypatch.setattr("chart_review_deepagents.registry._DEFAULT_MODELS_PATH",
                        tmp_path / "absent.json")
    monkeypatch.setenv("DEEPAGENTS_LLM_BACKEND", "azure")
    monkeypatch.setenv("AZURE_OPENAI_ENDPOINT", "https://x")
    monkeypatch.setenv("AZURE_OPENAI_API_KEY", "secret")
    monkeypatch.setenv("AZURE_OPENAI_DEPLOYMENT", "gpt-4o")
    captured = {}

    class FakeAzure:
        def __init__(self, **kw):
            captured.update(kw)

    monkeypatch.setattr("langchain_openai.AzureChatOpenAI", FakeAzure)
    models_mod.make_model()  # no key → default
    assert captured["azure_deployment"] == "gpt-4o"
