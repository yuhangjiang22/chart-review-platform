# python/tests/test_registry.py
import json
import pytest
from chart_review_deepagents import registry


AZURE_ENV = {
    "AZURE_OPENAI_ENDPOINT": "https://x.openai.azure.com",
    "AZURE_OPENAI_API_KEY": "secret",
    "AZURE_OPENAI_DEPLOYMENT": "gpt-4o",
}


def test_synthesizes_azure_default_when_no_file(tmp_path):
    models, default = registry.list_models(env={**AZURE_ENV, "DEEPAGENTS_LLM_BACKEND": "azure"},
                                           models_path=tmp_path / "absent.json")
    assert default == "gpt-4o"
    assert models == [{"id": "gpt-4o", "backend": "azure",
                       "label": "azure · gpt-4o", "available": True}]


def test_azure_unavailable_when_key_missing(tmp_path):
    models, default = registry.list_models(
        env={"AZURE_OPENAI_ENDPOINT": "https://x", "AZURE_OPENAI_DEPLOYMENT": "gpt-4o",
             "DEEPAGENTS_LLM_BACKEND": "azure"},
        models_path=tmp_path / "absent.json")
    assert default is None
    assert models[0]["available"] is False


def test_reads_file_and_picks_marked_default(tmp_path):
    p = tmp_path / "models.json"
    p.write_text(json.dumps({
        "gpt-4o": {"backend": "azure", "deployment": "gpt-4o"},
        "llama": {"backend": "vllm", "base_url": "http://h:8000/v1",
                  "model": "meta/Llama", "default": True},
    }))
    models, default = registry.list_models(env=AZURE_ENV, models_path=p)
    assert default == "llama"
    ids = {m["id"] for m in models}
    assert ids == {"gpt-4o", "llama"}
    assert next(m for m in models if m["id"] == "llama")["label"] == "vllm · meta/Llama"


def test_resolve_azure_reads_env_values(tmp_path):
    p = tmp_path / "models.json"
    p.write_text(json.dumps({"gpt-4o": {"backend": "azure", "deployment": "gpt-4o"}}))
    conn = registry.resolve("gpt-4o", env=AZURE_ENV, models_path=p)
    assert conn == {"backend": "azure", "azure_endpoint": "https://x.openai.azure.com",
                    "api_key": "secret", "api_version": "2024-10-21",
                    "azure_deployment": "gpt-4o"}


def test_resolve_vllm_defaults_api_key_empty(tmp_path):
    p = tmp_path / "models.json"
    p.write_text(json.dumps({"llama": {"backend": "vllm", "base_url": "http://h:8000/v1",
                                       "model": "meta/Llama"}}))
    conn = registry.resolve("llama", env={}, models_path=p)
    assert conn == {"backend": "vllm", "base_url": "http://h:8000/v1",
                    "api_key": "EMPTY", "model": "meta/Llama"}


def test_resolve_unknown_key_raises(tmp_path):
    p = tmp_path / "models.json"
    p.write_text(json.dumps({"gpt-4o": {"backend": "azure", "deployment": "gpt-4o"}}))
    with pytest.raises(ValueError, match="unknown model"):
        registry.resolve("nope", env=AZURE_ENV, models_path=p)


def test_resolve_azure_missing_env_raises_valueerror(tmp_path):
    import json
    p = tmp_path / "models.json"
    p.write_text(json.dumps({"gpt-4o": {"backend": "azure", "deployment": "gpt-4o"}}))
    with pytest.raises(ValueError, match="AZURE_OPENAI_API_KEY"):
        registry.resolve("gpt-4o", env={"AZURE_OPENAI_ENDPOINT": "https://x"}, models_path=p)


def test_malformed_models_json_raises_valueerror(tmp_path):
    p = tmp_path / "models.json"
    p.write_text("{ not valid json ")
    with pytest.raises(ValueError, match="malformed models.json"):
        registry.list_models(env={}, models_path=p)


def test_synthesizes_vllm_default_when_no_file(tmp_path):
    models, default = registry.list_models(
        env={"DEEPAGENTS_LLM_BACKEND": "vllm", "VLLM_BASE_URL": "http://h:8000/v1",
             "VLLM_MODEL": "meta/Llama"},
        models_path=tmp_path / "absent.json")
    assert default == "meta/Llama"
    assert models == [{"id": "meta/Llama", "backend": "vllm",
                       "label": "vllm · meta/Llama", "available": True}]
