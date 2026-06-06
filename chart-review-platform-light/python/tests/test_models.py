import pytest
from chart_review_deepagents.models import make_model


def test_unknown_backend_raises(monkeypatch):
    monkeypatch.setenv("DEEPAGENTS_LLM_BACKEND", "nope")
    with pytest.raises(SystemExit):
        make_model()


def test_vllm_requires_base_url(monkeypatch):
    monkeypatch.setenv("DEEPAGENTS_LLM_BACKEND", "vllm")
    monkeypatch.delenv("VLLM_BASE_URL", raising=False)
    with pytest.raises(KeyError):
        make_model()
