# chart_review_deepagents/models.py
from . import registry


def make_model(model_key=None):
    """Build a LangChain chat model for a registry key. When model_key is None,
    use the registry's default entry. The registry resolves the key to a
    backend + connection (Azure or vLLM); see registry.py for the contract."""
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

        return _SerialToolCallsAzure(
            azure_endpoint=conn["azure_endpoint"],
            api_key=conn["api_key"],
            api_version=conn["api_version"],
            azure_deployment=conn["azure_deployment"],
            temperature=0,
            # Back off + retry on transient 429s. The OpenAI SDK honors
            # Retry-After with exponential backoff; without this a single 429
            # (server at capacity / batch concurrency) aborts the patient. The
            # primary 429 lever is run concurrency (RUN_CONCURRENCY); this is
            # the secondary cushion.
            max_retries=12,
        )
    from langchain_openai import ChatOpenAI

    return ChatOpenAI(
        base_url=conn["base_url"],
        api_key=conn["api_key"],
        model=conn["model"],
        temperature=0,
        # See note above — absorbs transient vLLM 429s instead of crashing.
        max_retries=12,
    )
