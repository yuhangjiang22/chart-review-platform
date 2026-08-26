# chart_review_deepagents/llm_retry.py
#
# Bounded retry wrapper for the per-LLM-call layer.
#
# Background: 23 minutes into a real adherence run, Azure returned a
# gateway timeout and the sidecar died with:
#   ValueError: {'message': 'A Timeout Occurred', 'code': 504}
#
# That ValueError is raised by langchain_openai's `_create_chat_result`
# (chat_models/base.py) AFTER the HTTP call has already "succeeded" from
# openai-python's point of view — Azure sometimes returns an in-band
# `{"error": {...}}` JSON body instead of an HTTP-level 4xx/5xx status, so
# it never triggers openai-python's own `max_retries` (that retry logic
# only fires on `openai.APIStatusError`/`APITimeoutError` raised while
# making the request; this ValueError is raised afterward, once the
# response body has been parsed). A gateway 504 is transient — the prompt
# cache stays warm, so a short backoff and re-issuing the SAME model call
# converts an infrastructure blip into a pause instead of a dead patient.
#
# This module retries ONLY the single LLM call (the thing `_generate` /
# `_agenerate` on a LangChain chat model does). It must never wrap whole
# agent execution — a retry there could replay committed tool calls (MCP
# writes are not idempotent). Callers wrap `super()._generate` /
# `super()._agenerate` directly (see models.py), so a retry re-issues
# exactly one HTTP call and nothing else.
#
# NOTE: `_stream`/`_astream` are NOT wrapped — the current sidecar config
# never streams (models.py always calls generate-style paths; the agent
# loop consumes `agent.astream()` at the graph level, not model-level
# token streaming). Revisit if that changes.
#
# NOTE: the 5xx/429 branch here intentionally overlaps with the openai
# SDK's own `max_retries` (set in models.py). That's deliberate, not
# redundant: this outer layer exists specifically to catch the in-band
# `{"error": {...}}` case the SDK's HTTP-level retry logic misses (see
# above) — it also happens to give 5xx/429 a second line of defense.
import asyncio
import sys
import time
from typing import Any, Awaitable, Callable, TypeVar

T = TypeVar("T")

# 3 attempts total (1 initial + 2 retries). Backoff is generous — the luna
# model is slow and an Azure gateway timeout can take a while to clear.
# Named constants so the policy is a one-line change, not a hunt.
RETRY_MAX_ATTEMPTS = 3
RETRY_BACKOFF_SECONDS = (15, 45)  # sleep before attempt 2, before attempt 3
RETRY_AFTER_CAP_SECONDS = 300.0  # clamp a server-supplied Retry-After


def _is_transient_value_error(exc: ValueError) -> bool:
    """Structure-first match for the gateway-504-shaped ValueError:
    `langchain_openai` raises `ValueError(response_dict["error"])` with the
    RAW error dict as `exc.args[0]` (not a formatted string) — so inspect
    that dict's `code` first (504, 429, or any >=500 int all count; a
    string digit code is coerced). Falls back to a `"Timeout Occurred"`
    substring match on the dict's `message`, and only falls back to
    matching `str(exc)` when `args[0]` isn't a dict at all (defensive,
    in case a future SDK version formats this differently)."""
    if exc.args and isinstance(exc.args[0], dict):
        body = exc.args[0]
        code = body.get("code")
        if isinstance(code, str) and code.isdigit():
            code = int(code)
        if isinstance(code, int) and (code == 429 or code >= 500):
            return True
        return "Timeout Occurred" in str(body.get("message") or "")
    return "Timeout Occurred" in str(exc)


def _is_transient(exc: BaseException) -> bool:
    """True when `exc` looks like a transient Azure/openai infra error worth
    retrying:
      - the gateway-504-shaped ValueError described above;
      - an httpx/openai timeout (ConnectTimeout, ReadTimeout, APITimeoutError, …);
      - a 5xx APIStatusError (InternalServerError etc.);
      - a 429 RateLimitError.
    Matched by message/name/status_code rather than importing openai/httpx
    exception classes directly, so this stays correct across SDK versions
    and is trivially unit-testable with plain exception instances."""
    if isinstance(exc, ValueError) and _is_transient_value_error(exc):
        return True

    name = type(exc).__name__
    if "Timeout" in name:  # httpx.*Timeout*, openai.APITimeoutError
        return True

    status = getattr(exc, "status_code", None)
    if isinstance(status, int) and (status == 429 or status >= 500):
        return True

    return False


def _retry_after_seconds(exc: BaseException) -> float | None:
    """Best-effort Retry-After (seconds), read from a 429's response headers
    when the SDK surfaced one. Clamped to RETRY_AFTER_CAP_SECONDS so a
    misbehaving/huge server-supplied value can't stall the sidecar for an
    unbounded time. Returns None when absent/unparseable, in which case the
    caller falls back to RETRY_BACKOFF_SECONDS."""
    response = getattr(exc, "response", None)
    headers = getattr(response, "headers", None)
    if not headers:
        return None
    value = None
    try:
        value = headers.get("retry-after")
    except AttributeError:
        return None
    if value is None:
        return None
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        return None
    return min(seconds, RETRY_AFTER_CAP_SECONDS)


def _summarize(exc: BaseException) -> str:
    msg = str(exc)
    if len(msg) > 160:
        msg = msg[:157] + "..."
    return f"{type(exc).__name__}: {msg}"


def _backoff_for(attempt: int, exc: BaseException) -> float:
    """`attempt` is the 1-based attempt number that just failed."""
    retry_after = _retry_after_seconds(exc)
    if retry_after is not None:
        return retry_after
    idx = min(attempt - 1, len(RETRY_BACKOFF_SECONDS) - 1)
    return RETRY_BACKOFF_SECONDS[idx]


def _log_retry(attempt: int, exc: BaseException, sleep_s: float) -> None:
    # stderr reaches the run transcript as deepagents-stderr lines.
    print(
        f"[deepagents-retry] attempt {attempt + 1}/{RETRY_MAX_ATTEMPTS} "
        f"after {_summarize(exc)}; sleeping {sleep_s}s",
        file=sys.stderr,
    )


async def call_with_retry(fn: Callable[..., Awaitable[T]], *args: Any, **kwargs: Any) -> T:
    """Await `fn(*args, **kwargs)`, retrying on a transient error with
    backoff (see policy above). Sleeps with `asyncio.sleep` (this is the
    async path, invoked from `_agenerate` inside a live event loop — a
    blocking `time.sleep` here would stall the loop for no reason). On
    exhaustion (or a non-transient error), re-raises the ORIGINAL exception
    unchanged — the loud-fail contract for real failures is preserved."""
    attempt = 1
    while True:
        try:
            return await fn(*args, **kwargs)
        except Exception as exc:
            if not _is_transient(exc) or attempt >= RETRY_MAX_ATTEMPTS:
                raise
            sleep_s = _backoff_for(attempt, exc)
            _log_retry(attempt, exc, sleep_s)
            await asyncio.sleep(sleep_s)
            attempt += 1


def call_with_retry_sync(fn: Callable[..., T], *args: Any, **kwargs: Any) -> T:
    """Sync counterpart of `call_with_retry`, for the sync `_generate` path."""
    attempt = 1
    while True:
        try:
            return fn(*args, **kwargs)
        except Exception as exc:
            if not _is_transient(exc) or attempt >= RETRY_MAX_ATTEMPTS:
                raise
            sleep_s = _backoff_for(attempt, exc)
            _log_retry(attempt, exc, sleep_s)
            time.sleep(sleep_s)
            attempt += 1
