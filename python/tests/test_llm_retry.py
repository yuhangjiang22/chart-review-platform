"""Unit tests for the per-LLM-call retry wrapper (chart_review_deepagents.llm_retry).

Covers the transient-504 signature that killed a real 23-minute-in adherence
run (`ValueError: {'message': 'A Timeout Occurred', 'code': 504}`), plus the
general transient set (timeouts, 5xx, 429) and the non-transient/exhaustion
paths that must preserve the loud-fail contract. time.sleep is monkeypatched
so the tests run instantly — no real backoff is exercised."""
import asyncio

import pytest

from chart_review_deepagents.llm_retry import (
    call_with_retry,
    call_with_retry_sync,
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


def _sleep_calls(monkeypatch):
    calls = []
    monkeypatch.setattr("chart_review_deepagents.llm_retry.time.sleep", lambda s: calls.append(s))
    return calls


# ── async path (call_with_retry) — the one actually exercised by _agenerate ──

def test_transient_504_value_error_succeeds_on_attempt_2(monkeypatch):
    sleeps = _sleep_calls(monkeypatch)
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
    sleeps = _sleep_calls(monkeypatch)
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
    sleeps = _sleep_calls(monkeypatch)
    calls = {"n": 0}

    async def bad_prompt(*args, **kwargs):
        calls["n"] += 1
        raise ValueError("bad prompt")

    with pytest.raises(ValueError, match="bad prompt"):
        asyncio.run(call_with_retry(bad_prompt))

    assert calls["n"] == 1  # no retry attempted
    assert sleeps == []


def test_429_is_retried(monkeypatch):
    sleeps = _sleep_calls(monkeypatch)
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
    sleeps = _sleep_calls(monkeypatch)
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


def test_5xx_api_status_error_is_retried(monkeypatch):
    _sleep_calls(monkeypatch)
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
    _sleep_calls(monkeypatch)
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
    sleeps = _sleep_calls(monkeypatch)
    calls = {"n": 0}

    async def always_fails(*args, **kwargs):
        calls["n"] += 1
        raise ValueError({"message": "A Timeout Occurred", "code": 504})

    with pytest.raises(ValueError):
        asyncio.run(call_with_retry(always_fails))

    assert sleeps == list(RETRY_BACKOFF_SECONDS[: RETRY_MAX_ATTEMPTS - 1])


# ── sync path (call_with_retry_sync) — used by the sync _generate mirror ────

def test_sync_transient_error_succeeds_on_attempt_2(monkeypatch):
    sleeps = _sleep_calls(monkeypatch)
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
    sleeps = _sleep_calls(monkeypatch)
    calls = {"n": 0}

    def bad_prompt():
        calls["n"] += 1
        raise ValueError("bad prompt")

    with pytest.raises(ValueError, match="bad prompt"):
        call_with_retry_sync(bad_prompt)

    assert calls["n"] == 1
    assert sleeps == []
