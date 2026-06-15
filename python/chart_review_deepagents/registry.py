# chart_review_deepagents/registry.py
"""Model registry: declares named models (Azure/vLLM) selectable per agent.

Reads <platform_root>/python/models.json. When that file is absent, synthesizes
a single default entry from the existing env vars so current setups keep working
with no new file. This module is the Python copy of the registry contract; the
TypeScript copy is server/lib/model-registry.ts — keep the two in sync (see the
spec for the canonical contract)."""
import json
import os
from pathlib import Path

_DEFAULT_MODELS_PATH = Path(__file__).resolve().parent.parent / "models.json"


def _load_raw(models_path):
    path = Path(models_path) if models_path is not None else _DEFAULT_MODELS_PATH
    if path.exists():
        with open(path, "r", encoding="utf-8") as f:
            try:
                return json.load(f)
            except json.JSONDecodeError as exc:
                raise ValueError(f"malformed models.json at {path}: {exc}") from exc
    return None


def _synthesize(env):
    backend = env.get("DEEPAGENTS_LLM_BACKEND", "azure").lower()
    if backend == "vllm":
        key = env.get("VLLM_MODEL") or "vllm-default"
        return {key: {"backend": "vllm",
                      "base_url": env.get("VLLM_BASE_URL", ""),
                      "model": env.get("VLLM_MODEL", ""),
                      "api_key_env": "VLLM_API_KEY", "default": True}}
    key = env.get("AZURE_OPENAI_DEPLOYMENT") or "azure-default"
    return {key: {"backend": "azure", "deployment": env.get("AZURE_OPENAI_DEPLOYMENT", ""),
                  "default": True}}


def _entries(env, models_path):
    raw = _load_raw(models_path)
    return raw if raw is not None else _synthesize(env)


# Tokens that appear ONLY in the .env.example / .env.docker.example placeholders.
# A value containing one of these is treated as not-yet-configured. Keep in sync
# with server/lib/model-registry.ts (PLACEHOLDER_TOKENS).
#   your-vllm-host / YOUR-RESOURCE  -> .env.docker.example
#   <resource>                      -> .env.example (bare-metal) azure endpoint
_PLACEHOLDER_TOKENS = ("your-vllm-host", "your-resource", "<resource>")


def _is_configured(value):
    return bool(value) and not any(t in value.lower() for t in _PLACEHOLDER_TOKENS)


def _available(entry, env):
    if entry["backend"] == "azure":
        ep = env.get(entry.get("endpoint_env", "AZURE_OPENAI_ENDPOINT"))
        key = env.get(entry.get("api_key_env", "AZURE_OPENAI_API_KEY"))
        return _is_configured(ep) and bool(key)
    # vllm: the base URL must be set AND not the example placeholder.
    base_url = env.get(entry["base_url_env"]) if entry.get("base_url_env") else entry.get("base_url")
    return _is_configured(base_url)


def _label(entry):
    if entry["backend"] == "azure":
        return f"azure · {entry['deployment']}"
    return f"vllm · {entry['model']}"


def list_models(env=None, models_path=None):
    """Return (models, default_key). models is a list of presence-only dicts
    {id, backend, label, available} in insertion order. default_key is the
    available entry marked default, else the first available, else None."""
    env = os.environ if env is None else env
    entries = _entries(env, models_path)
    models, default = [], None
    for key, entry in entries.items():
        avail = _available(entry, env)
        models.append({"id": key, "backend": entry["backend"],
                       "label": _label(entry), "available": avail})
        if avail and default is None:
            default = key
    marked = next((k for k, e in entries.items()
                   if e.get("default") and _available(e, env)), None)
    if marked is not None:
        default = marked
    return models, default


def resolve(key, env=None, models_path=None):
    """Return a connection dict for make_model(). Reads secret VALUES from env
    (Python side only). Raises ValueError on an unknown key."""
    env = os.environ if env is None else env
    entries = _entries(env, models_path)
    entry = entries.get(key)
    if entry is None:
        raise ValueError(f"unknown model {key!r} (not in registry)")
    if entry["backend"] == "azure":
        ep_var = entry.get("endpoint_env", "AZURE_OPENAI_ENDPOINT")
        key_var = entry.get("api_key_env", "AZURE_OPENAI_API_KEY")
        endpoint = env.get(ep_var)
        if not _is_configured(endpoint):
            endpoint = None
        api_key = env.get(key_var)
        missing = [v for v, val in ((ep_var, endpoint), (key_var, api_key)) if not val]
        if missing:
            raise ValueError(
                f"model {key!r} requires env var(s) {', '.join(missing)} but they are not set")
        return {"backend": "azure",
                "azure_endpoint": endpoint,
                "api_key": api_key,
                "api_version": env.get(entry.get("api_version_env", "AZURE_OPENAI_API_VERSION"),
                                       "2024-10-21"),
                "azure_deployment": entry["deployment"]}
    # vllm: endpoint from base_url_env (read at run time) or a literal base_url.
    base_url = env.get(entry["base_url_env"]) if entry.get("base_url_env") else entry.get("base_url")
    if not _is_configured(base_url):
        need = entry.get("base_url_env") or "base_url"
        raise ValueError(
            f"model {key!r} is not configured: set {need} to a real value "
            f"(not the .env.example placeholder)")
    return {"backend": "vllm",
            "base_url": base_url,
            "api_key": env.get(entry.get("api_key_env", "VLLM_API_KEY"), "EMPTY") or "EMPTY",
            "model": entry["model"]}
