# chart_review_deepagents/models.py
import os
import sys


def make_model():
    """Build a LangChain chat model from env. Backend selected by
    DEEPAGENTS_LLM_BACKEND = azure | vllm. Returns a BaseChatModel
    that create_deep_agent accepts directly."""
    backend = os.environ.get("DEEPAGENTS_LLM_BACKEND", "azure").lower()
    if backend == "azure":
        from langchain_openai import AzureChatOpenAI

        return AzureChatOpenAI(
            azure_endpoint=os.environ["AZURE_OPENAI_ENDPOINT"],
            api_key=os.environ["AZURE_OPENAI_API_KEY"],
            api_version=os.environ.get("AZURE_OPENAI_API_VERSION", "2024-10-21"),
            azure_deployment=os.environ["AZURE_OPENAI_DEPLOYMENT"],
            temperature=0,
        )
    if backend == "vllm":
        from langchain_openai import ChatOpenAI

        return ChatOpenAI(
            base_url=os.environ["VLLM_BASE_URL"],
            api_key=os.environ.get("VLLM_API_KEY", "EMPTY"),
            model=os.environ["VLLM_MODEL"],
            temperature=0,
        )
    print(
        f"[deepagents] Unknown DEEPAGENTS_LLM_BACKEND={backend!r} (expected azure|vllm)",
        file=sys.stderr,
    )
    raise SystemExit(2)
