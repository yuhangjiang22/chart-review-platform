"""Unit tests for the per-LLM-call retry wrapper (chart_review_deepagents.llm_retry).

Covers the transient-504 signature that killed a real 23-minute-in adherence
run (`ValueError: {'message': 'A Timeout Occurred', 'code': 504}`), plus the
general transient set (timeouts, 5xx, 429), the structure-first ValueError
match (langchain_openai raises the RAW error dict as exc.args[0], not a
formatted string), the Retry-After clamp, and the non-transient/exhaustion
paths that must preserve the loud-fail contract.

The async wrapper (call_with_retry) sleeps with asyncio.sleep; the sync
wrapper (call_with_retry_sync) sleeps with time.sleep. Both are monkeypatched
so no test does any real waiting."""
import asyncio
import inspect

import pytest

from chart_review_deepagents.llm_retry import (
    call_with_retry,
    call_with_retry_sync,
    RETRY_AFTER_CAP_SECONDS,
    RETRY_MAX_ATTEMPTS,
)


class _FakeAPIStatusError(Exception):
    """Stand-in for openai.APIStatusError / RateLimitError / InternalServerError
    — real classes require a constructed httpx.Response; tests only need the
    `status_code` (and optionally `response.headers`) attribute llm_retry reads."""

    def __init__(self, message, status_code, response=None):
        super().__init__(message)
        self.status_code = status_code
        self.response = response


class _FakeHeaders(dict):
    def get(self, key, default=None):  # case-insensitive-ish enough for the test
        return super().get(key.lower(), super().get(key, default))


class _FakeResponse:
    def __init__(self, headers=None):
        self.headers = _FakeHeaders(headers or {})


def _async_sleep_calls(monkeypatch):
    """Patch asyncio.sleep (the async wrapper's sleep) and record calls."""
    calls = []

    async def fake_sleep(s):
        calls.append(s)

    monkeypatch.setattr("chart_review_deepagents.llm_retry.asyncio.sleep", fake_sleep)
    return calls


def _sync_sleep_calls(monkeypatch):
    """Patch time.sleep (the sync wrapper's sleep) and record calls."""
    calls = []
    monkeypatch.setattr("chart_review_deepagents.llm_retry.time.sleep", lambda s: calls.append(s))
    return calls


# ── async path (call_with_retry) — the one actually exercised by _agenerate ──

def test_transient_504_value_error_succeeds_on_attempt_2(monkeypatch):
    sleeps = _async_sleep_calls(monkeypatch)
    calls = {"n": 0}

    async def flaky(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            raise ValueError({"message": "A Timeout Occurred", "code": 504})
        return "ok"

    result = asyncio.run(call_with_retry(flaky, "x", y=1))
    assert result == "ok"
    assert calls["n"] == 2
    assert len(sleeps) == 1  # exactly one retry sleep


def test_exhaustion_reraises_original_exception_unchanged(monkeypatch):
    sleeps = _async_sleep_calls(monkeypatch)
    calls = {"n": 0}
    original = ValueError({"message": "A Timeout Occurred", "code": 504})

    async def always_fails(*args, **kwargs):
        calls["n"] += 1
        raise original

    with pytest.raises(ValueError) as exc_info:
        asyncio.run(call_with_retry(always_fails))

    assert exc_info.value is original  # same object — message/type unchanged
    assert calls["n"] == RETRY_MAX_ATTEMPTS
    assert len(sleeps) == RETRY_MAX_ATTEMPTS - 1  # sleeps between attempts only


def test_non_transient_error_is_not_retried(monkeypatch):
    sleeps = _async_sleep_calls(monkeypatch)
    calls = {"n": 0}

    async def bad_prompt(*args, **kwargs):
        calls["n"] += 1
        raise ValueError("bad prompt")

    with pytest.raises(ValueError, match="bad prompt"):
        asyncio.run(call_with_retry(bad_prompt))

    assert calls["n"] == 1  # no retry attempted
    assert sleeps == []


def test_429_is_retried(monkeypatch):
    sleeps = _async_sleep_calls(monkeypatch)
    calls = {"n": 0}

    async def rate_limited(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            raise _FakeAPIStatusError("rate limited", status_code=429)
        return "ok"

    result = asyncio.run(call_with_retry(rate_limited))
    assert result == "ok"
    assert calls["n"] == 2
    assert len(sleeps) == 1


def test_429_respects_retry_after_header(monkeypatch):
    sleeps = _async_sleep_calls(monkeypatch)
    calls = {"n": 0}

    async def rate_limited(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            raise _FakeAPIStatusError(
                "rate limited", status_code=429,
                response=_FakeResponse({"retry-after": "7"}),
            )
        return "ok"

    result = asyncio.run(call_with_retry(rate_limited))
    assert result == "ok"
    assert sleeps == [7.0]  # Retry-After overrides the default backoff constant


def test_retry_after_is_clamped_to_cap(monkeypatch):
    sleeps = _async_sleep_calls(monkeypatch)
    calls = {"n": 0}

    async def rate_limited(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            raise _FakeAPIStatusError(
                "rate limited", status_code=429,
                response=_FakeResponse({"retry-after": "9999"}),
            )
        return "ok"

    result = asyncio.run(call_with_retry(rate_limited))
    assert result == "ok"
    assert sleeps == [RETRY_AFTER_CAP_SECONDS]


def test_5xx_api_status_error_is_retried(monkeypatch):
    _async_sleep_calls(monkeypatch)
    calls = {"n": 0}

    async def flaky_5xx(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            raise _FakeAPIStatusError("internal server error", status_code=503)
        return "ok"

    result = asyncio.run(call_with_retry(flaky_5xx))
    assert result == "ok"
    assert calls["n"] == 2


def test_timeout_named_exception_is_retried(monkeypatch):
    _async_sleep_calls(monkeypatch)
    calls = {"n": 0}

    class ReadTimeout(Exception):
        pass

    async def flaky_timeout(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            raise ReadTimeout("the connection timed out")
        return "ok"

    result = asyncio.run(call_with_retry(flaky_timeout))
    assert result == "ok"
    assert calls["n"] == 2


def test_backoff_sequence_matches_named_constants(monkeypatch):
    from chart_review_deepagents.llm_retry import RETRY_BACKOFF_SECONDS
    sleeps = _async_sleep_calls(monkeypatch)
    calls = {"n": 0}

    async def always_fails(*args, **kwargs):
        calls["n"] += 1
        raise ValueError({"message": "A Timeout Occurred", "code": 504})

    with pytest.raises(ValueError):
        asyncio.run(call_with_retry(always_fails))

    assert sleeps == list(RETRY_BACKOFF_SECONDS[: RETRY_MAX_ATTEMPTS - 1])


# ── structure-first ValueError matching ─────────────────────────────────────
# langchain_openai raises `ValueError(response_dict["error"])` with the RAW
# error dict as exc.args[0] — NOT a formatted string. These tests lock the
# structure-first match (decide by dict `code` first) and its narrower
# fallback (message-substring match only when args[0] isn't a dict at all —
# the bare "504" substring branch was removed because it could false-positive
# on unrelated numbers, e.g. a day count).

def test_value_error_dict_code_int_504_is_transient(monkeypatch):
    _async_sleep_calls(monkeypatch)
    calls = {"n": 0}

    async def flaky(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            raise ValueError({"message": "A Timeout Occurred", "code": 504})
        return "ok"

    assert asyncio.run(call_with_retry(flaky)) == "ok"
    assert calls["n"] == 2


def test_value_error_dict_code_string_digit_is_coerced_and_transient(monkeypatch):
    _async_sleep_calls(monkeypatch)
    calls = {"n": 0}

    async def flaky(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            # code as a string digit, and a message that does NOT mention
            # "Timeout Occurred" — must still be transient via the code path.
            raise ValueError({"message": "Bad Gateway", "code": "502"})
        return "ok"

    assert asyncio.run(call_with_retry(flaky)) == "ok"
    assert calls["n"] == 2


def test_value_error_dict_no_transient_code_or_message_not_retried(monkeypatch):
    sleeps = _async_sleep_calls(monkeypatch)
    calls = {"n": 0}

    async def bad(*args, **kwargs):
        calls["n"] += 1
        raise ValueError({"message": "invalid_request_error", "code": 400})

    with pytest.raises(ValueError):
        asyncio.run(call_with_retry(bad))

    assert calls["n"] == 1
    assert sleeps == []


def test_value_error_non_dict_arg_falls_back_to_message_substring(monkeypatch):
    _async_sleep_calls(monkeypatch)
    calls = {"n": 0}

    async def flaky(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            raise ValueError("A Timeout Occurred while contacting the gateway")
        return "ok"

    assert asyncio.run(call_with_retry(flaky)) == "ok"
    assert calls["n"] == 2


def test_value_error_bare_504_substring_without_structure_not_retried(monkeypatch):
    """Locks removal of the old bare `"504" in msg` branch: a plain-string
    ValueError that merely contains the digits 504 (no dict structure, no
    "Timeout Occurred") must NOT be treated as transient."""
    sleeps = _async_sleep_calls(monkeypatch)
    calls = {"n": 0}

    async def bad(*args, **kwargs):
        calls["n"] += 1
        raise ValueError("patient reported symptoms for 504 days")

    with pytest.raises(ValueError, match="504 days"):
        asyncio.run(call_with_retry(bad))

    assert calls["n"] == 1
    assert sleeps == []


# ── sync path (call_with_retry_sync) — used by the sync _generate mirror ────

def test_sync_transient_error_succeeds_on_attempt_2(monkeypatch):
    sleeps = _sync_sleep_calls(monkeypatch)
    calls = {"n": 0}

    def flaky(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            raise ValueError({"message": "A Timeout Occurred", "code": 504})
        return "ok"

    assert call_with_retry_sync(flaky) == "ok"
    assert calls["n"] == 2
    assert len(sleeps) == 1


def test_sync_non_transient_error_not_retried(monkeypatch):
    sleeps = _sync_sleep_calls(monkeypatch)
    calls = {"n": 0}

    def bad_prompt():
        calls["n"] += 1
        raise ValueError("bad prompt")

    with pytest.raises(ValueError, match="bad prompt"):
        call_with_retry_sync(bad_prompt)

    assert calls["n"] == 1
    assert sleeps == []


# ── mixin composition — locks fix #1 (explicit langchain signatures) ───────

def test_retrying_mixin_composes_with_real_basechatmodel(monkeypatch):
    """Compose _RetryingModelMixin with a minimal concrete BaseChatModel and
    drive it through LangChain's own PUBLIC entry points (`.invoke()` /
    `.ainvoke()` — what langgraph's model node actually calls; they dispatch
    through the same `generate()`/`agenerate()` machinery `_create_chat_result`
    lives behind), not by calling `_generate`/`_agenerate` directly. This
    proves two things fix #1 depends on:
      (a) the retry fires through the real langchain call path, and
      (b) langchain's own
          `inspect.signature(self._agenerate).parameters.get("run_manager")`
          gate (chat_models.py) sees a literal `run_manager` parameter on our
          mixin's override — a `*args, **kwargs` override would make that
          check come back False and langchain would silently stop passing
          run_manager through."""
    from langchain_core.language_models.chat_models import BaseChatModel
    from langchain_core.messages import AIMessage, HumanMessage
    from langchain_core.outputs import ChatGeneration, ChatResult
    from chart_review_deepagents.models import _RetryingModelMixin

    calls = {"n": 0}

    class _FakeChatModelBase(BaseChatModel):
        @property
        def _llm_type(self) -> str:
            return "fake"

        def _generate(self, messages, stop=None, run_manager=None, **kwargs):
            calls["n"] += 1
            if calls["n"] == 1:
                raise ValueError({"message": "A Timeout Occurred", "code": 504})
            return ChatResult(generations=[ChatGeneration(message=AIMessage(content="ok"))])

        async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
            calls["n"] += 1
            if calls["n"] == 1:
                raise ValueError({"message": "A Timeout Occurred", "code": 504})
            return ChatResult(generations=[ChatGeneration(message=AIMessage(content="ok"))])

    class _FakeChatModel(_RetryingModelMixin, _FakeChatModelBase):
        pass

    # (b) — the signature gate langchain_core checks before deciding whether
    # to forward run_manager.
    assert "run_manager" in inspect.signature(_FakeChatModel._generate).parameters
    assert "run_manager" in inspect.signature(_FakeChatModel._agenerate).parameters

    monkeypatch.setattr("chart_review_deepagents.llm_retry.time.sleep", lambda s: None)

    async def fake_asleep(s):
        return None

    monkeypatch.setattr("chart_review_deepagents.llm_retry.asyncio.sleep", fake_asleep)

    model = _FakeChatModel()

    # (a) sync public entry point
    result = model.invoke([HumanMessage(content="hi")])
    assert result.content == "ok"
    assert calls["n"] == 2  # 1 failure + 1 successful retry, through .invoke()

    # (a) async public entry point
    calls["n"] = 0
    result = asyncio.run(model.ainvoke([HumanMessage(content="hi")]))
    assert result.content == "ok"
    assert calls["n"] == 2
