# chart_review_deepagents/models.py
from . import registry
from .llm_retry import call_with_retry, call_with_retry_sync


class _RetryingModelMixin:
    """Wrap the per-call LLM invocation with the bounded transient-error
    retry policy in llm_retry.py. Composed with a LangChain chat model class
    (see the Azure/vLLM classes below) so ONLY the individual `_generate` /
    `_agenerate` call is retried — never the whole agent turn, never a tool
    call. `super()._agenerate`/`super()._generate` is the same method the
    unwrapped class would have run; wrapping it here just re-issues that
    exact call on a transient failure (see llm_retry.py for why this layer,
    not the SDK's own max_retries, has to catch the gateway-504 case)."""

    async def _agenerate(self, *args, **kwargs):
        return await call_with_retry(super()._agenerate, *args, **kwargs)

    def _generate(self, *args, **kwargs):
        return call_with_retry_sync(super()._generate, *args, **kwargs)


def make_model(model_key=None, serial_tool_calls=True):
    """Build a LangChain chat model for a registry key. When model_key is None,
    use the registry's default entry. The registry resolves the key to a
    backend + connection (Azure or vLLM); see registry.py for the contract.

    serial_tool_calls: when True (default), force ONE tool call per turn on the
    Azure path (parallel_tool_calls=False) so the tool_calls array can't overflow
    Azure's 128 cap — needed for the note-heavy single-call path. Per-item mode
    passes False: its conversations are short (one item, well under the cap) and
    parallel batching is far cheaper (fewer turns -> fewer context re-sends)."""
    if model_key is None:
        _, model_key = registry.list_models()
        if model_key is None:
            raise ValueError(
                "no model available — set AZURE_OPENAI_* in .env, or start a "
                "vLLM server and add it to python/models.json")
    conn = registry.resolve(model_key)
    if conn["backend"] == "azure":
        from langchain_openai import AzureChatOpenAI

        # Force ONE tool call per turn. Azure/OpenAI cap a single assistant
        # message's tool_calls array at 128; on note-heavy patients the agent
        # otherwise emits a huge parallel batch (we saw 1364) and the request is
        # rejected with a 400, aborting the patient. parallel_tool_calls is a
        # bind_tools-time param (no constructor field), and create_deep_agent
        # binds tools internally — so we override bind_tools to inject it.
        class _SerialToolCallsAzure(_RetryingModelMixin, AzureChatOpenAI):
            def bind_tools(self, tools, **kwargs):
                kwargs.setdefault("parallel_tool_calls", False)
                return super().bind_tools(tools, **kwargs)

        # Parallel path also gets the retry mixin (transient errors aren't
        # specific to serial mode) but skips the tool-call-batching override.
        class _RetryingAzure(_RetryingModelMixin, AzureChatOpenAI):
            pass

        # serial -> the override above; parallel -> retrying AzureChatOpenAI
        # (the client batches tool calls per turn, far fewer round-trips).
        cls = _SerialToolCallsAzure if serial_tool_calls else _RetryingAzure
        kwargs = dict(
            azure_endpoint=conn["azure_endpoint"],
            api_key=conn["api_key"],
            api_version=conn["api_version"],
            azure_deployment=conn["azure_deployment"],
            # Back off + retry on transient 429s. The OpenAI SDK honors
            # Retry-After with exponential backoff; without this a single 429
            # (server at capacity / batch concurrency) aborts the patient. The
            # primary 429 lever is run concurrency (RUN_CONCURRENCY); this is
            # the secondary cushion.
            max_retries=12,
        )
        if conn.get("reasoning_effort"):
            # Reasoning models (gpt-5.x) accept reasoning_effort (minimal|low|
            # medium|high) — smaller effort = fewer reasoning tokens (billed as
            # output) = cheaper + faster. They REJECT temperature != 1 ("only the
            # default (1) is supported"), so we omit temperature entirely for them
            # (RUCAM scoring is thus non-deterministic on these models).
            # NOTE: reasoning_effort + function tools requires Azure's /v1/responses
            # API; on chat.completions it 400s. Use omit_temperature (below) to run
            # a reasoning model on chat.completions with default reasoning instead.
            kwargs["reasoning_effort"] = conn["reasoning_effort"]
        elif conn.get("omit_temperature"):
            # Reasoning model on chat.completions: send neither temperature nor
            # reasoning_effort (both 400 on these models with function tools).
            # Uses the model's default reasoning; non-deterministic.
            pass
        else:
            # Non-reasoning models (gpt-4o): pin temperature=0 for determinism.
            kwargs["temperature"] = 0
        return cls(**kwargs)
    from langchain_openai import ChatOpenAI

    class _RetryingChatOpenAI(_RetryingModelMixin, ChatOpenAI):
        pass

    return _RetryingChatOpenAI(
        base_url=conn["base_url"],
        api_key=conn["api_key"],
        model=conn["model"],
        temperature=0,
        # See note above — absorbs transient vLLM 429s instead of crashing.
        max_retries=12,
    )
