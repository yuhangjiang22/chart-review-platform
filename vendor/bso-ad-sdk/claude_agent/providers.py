"""Provider credential and configuration resolution."""

import os
from pathlib import Path

from dotenv import load_dotenv

# Load .env from project root (next to this package)
_PROJECT_ROOT = Path(__file__).resolve().parents[1]
load_dotenv(_PROJECT_ROOT / ".env", override=False)


def _recompose_azure_split() -> None:
    """Fold AZURE_OPENAI_ENDPOINT + AZURE_OPENAI_API_KEY into ANTHROPIC_API_KEY.

    Lets users keep two readable .env entries (endpoint URL, key) instead of
    the opaque "azure:<endpoint>:<key>" composite the proxy expects on the
    wire. Idempotent and deferential — does nothing if ANTHROPIC_API_KEY is
    already set, so explicit composite values still win and other providers
    (Anthropic, OpenAI, Gemini) are untouched.
    """
    if os.environ.get("ANTHROPIC_API_KEY"):
        return
    endpoint = os.environ.get("AZURE_OPENAI_ENDPOINT")
    key = os.environ.get("AZURE_OPENAI_API_KEY")
    if endpoint and key:
        os.environ["ANTHROPIC_API_KEY"] = f"azure:{endpoint.rstrip('/')}:{key}"


_recompose_azure_split()


def resolve_model() -> str:
    """Resolve model from env. CLI --model takes priority (handled in caller)."""
    return os.getenv("CLAUDE_MODEL", "claude-sonnet-4-6")


def resolve_provider_env(model: str | None = None) -> dict[str, str]:
    """Build env dict for the agent subprocess.

    Includes API credentials, optional base URL, and unified model aliases.
    Loads from .env file at project root (without overriding existing env vars).

    Args:
        model: The main model to use. If given, also pinned to haiku/sonnet/opus/
               subagent aliases so every internal Claude CLI call uses the same
               model. Needed for proxy mode where third-party APIs don't know
               the built-in claude-haiku-* / claude-opus-* names.

    Returns:
        Dict of env vars to pass to the agent subprocess.

    Raises:
        RuntimeError: If no valid credentials are found.
    """
    env: dict[str, str] = {}

    # --- API base URL (proxy / custom endpoint) ---
    base_url = os.environ.get("ANTHROPIC_BASE_URL")
    if base_url:
        env["ANTHROPIC_BASE_URL"] = base_url

    # --- Unify model aliases ---
    # Claude CLI internally issues calls with haiku (compact/title/background),
    # opus (plan mode), and a subagent model. Through a proxy to third-party
    # APIs those built-in names 404. We pin haiku/sonnet/opus/subagent so the
    # CLI stops trying to use them.
    #
    # Two-knob design:
    #   CLAUDE_MODEL        — main agent model (e.g. gpt-5)
    #   CLAUDE_CHEAP_MODEL  — model for compact / title / subagent (defaults
    #                         to CLAUDE_MODEL but you can point this at a
    #                         cheaper deployment, e.g. gpt-4o-mini, to cut
    #                         60-80 % of the per-day cost overhead).
    #
    # User overrides win: if the user already set ANTHROPIC_DEFAULT_HAIKU_MODEL
    # / ANTHROPIC_DEFAULT_SONNET_MODEL / ANTHROPIC_DEFAULT_OPUS_MODEL /
    # CLAUDE_CODE_SUBAGENT_MODEL, we leave it alone. Only fill in the gaps.
    effective_model = model or os.environ.get("CLAUDE_MODEL") or "claude-sonnet-4-6"
    cheap_model = os.environ.get("CLAUDE_CHEAP_MODEL") or effective_model

    def _set_if_unset(key: str, value: str) -> None:
        if not os.environ.get(key):
            env[key] = value

    _set_if_unset("ANTHROPIC_DEFAULT_HAIKU_MODEL", cheap_model)       # compact / title
    _set_if_unset("ANTHROPIC_DEFAULT_SONNET_MODEL", effective_model)  # default agent
    _set_if_unset("ANTHROPIC_DEFAULT_OPUS_MODEL", effective_model)    # plan mode
    _set_if_unset("CLAUDE_CODE_SUBAGENT_MODEL", cheap_model)          # subagents

    # --- Azure Foundry mode ---
    foundry_keys = [
        "ANTHROPIC_FOUNDRY_RESOURCE",
        "ANTHROPIC_FOUNDRY_API_KEY",
        "CLAUDE_CODE_USE_FOUNDRY",
    ]
    foundry_vals = {k: os.environ.get(k) for k in foundry_keys}
    foundry_set = [k for k, v in foundry_vals.items() if v]

    if foundry_set and len(foundry_set) < len(foundry_keys):
        # Partial config — almost certainly a misconfiguration. Refuse rather
        # than silently falling through to the ANTHROPIC_API_KEY path with
        # half the Foundry intent set.
        missing = [k for k in foundry_keys if not foundry_vals[k]]
        raise RuntimeError(
            "Azure Foundry partially configured. Set all three or none.\n"
            f"  set:     {', '.join(foundry_set)}\n"
            f"  missing: {', '.join(missing)}"
        )

    if all(foundry_vals.values()):
        for k, v in foundry_vals.items():
            if v:
                env[k] = v
        return env

    # --- Direct API mode ---
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if api_key:
        env["ANTHROPIC_API_KEY"] = api_key
        return env

    raise RuntimeError(
        "No Claude API credentials found. Set either:\n"
        "  Azure Foundry: ANTHROPIC_FOUNDRY_RESOURCE, ANTHROPIC_FOUNDRY_API_KEY, CLAUDE_CODE_USE_FOUNDRY=1\n"
        "  Direct API:    ANTHROPIC_API_KEY\n"
        "You can put these in .env at the project root."
    )
