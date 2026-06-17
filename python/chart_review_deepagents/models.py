# chart_review_deepagents/models.py
from . import registry


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
        class _SerialToolCallsAzure(AzureChatOpenAI):
            def bind_tools(self, tools, **kwargs):
                kwargs.setdefault("parallel_tool_calls", False)
                return super().bind_tools(tools, **kwargs)

        # serial -> the override above; parallel -> stock AzureChatOpenAI (the
        # client batches tool calls per turn, far fewer round-trips).
        cls = _SerialToolCallsAzure if serial_tool_calls else AzureChatOpenAI
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
            kwargs["reasoning_effort"] = conn["reasoning_effort"]
        else:
            # Non-reasoning models (gpt-4o): pin temperature=0 for determinism.
            kwargs["temperature"] = 0
        return cls(**kwargs)
    from langchain_openai import ChatOpenAI

    return ChatOpenAI(
        base_url=conn["base_url"],
        api_key=conn["api_key"],
        model=conn["model"],
        temperature=0,
        # See note above — absorbs transient vLLM 429s instead of crashing.
        max_retries=12,
    )
