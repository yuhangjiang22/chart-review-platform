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

        return AzureChatOpenAI(
            azure_endpoint=conn["azure_endpoint"],
            api_key=conn["api_key"],
            api_version=conn["api_version"],
            azure_deployment=conn["azure_deployment"],
            temperature=0,
        )
    from langchain_openai import ChatOpenAI

    return ChatOpenAI(
        base_url=conn["base_url"],
        api_key=conn["api_key"],
        model=conn["model"],
        temperature=0,
    )
