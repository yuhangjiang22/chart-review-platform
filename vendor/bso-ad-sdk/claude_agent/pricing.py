"""Estimated per-token prices for cost estimation.

These are best-effort lookups based on public Azure OpenAI / OpenAI / Anthropic
price lists. Returned cost is an *estimate*: your real bill depends on the
specific deployment tier (Standard / Provisioned / Batch), reservation
discounts, and auto-cache hit rate. Treat this as a sanity check, not a
source of truth — for billing, look at your provider's portal.

Override the table at runtime via env vars when your deployment uses
non-standard pricing:
  CLAUDE_PRICE_INPUT_PER_M_<MODEL>=<usd>
  CLAUDE_PRICE_OUTPUT_PER_M_<MODEL>=<usd>
where <MODEL> is the lowercased model id with non-alphanumerics replaced by
'_' (e.g. CLAUDE_PRICE_INPUT_PER_M_GPT_5_4=2.50).
"""

from __future__ import annotations

import os
import re
from typing import Optional

# (input_per_M, output_per_M) USD per million tokens.
# Azure / OpenAI prices match each other for equivalent models.
_PRICE_TABLE: dict[str, tuple[float, float]] = {
    # GPT-5 family (Azure OpenAI / OpenAI direct)
    "gpt-5":          (1.25, 10.00),
    "gpt-5-mini":     (0.25,  2.00),
    "gpt-5-nano":     (0.05,  0.40),
    "gpt-5-pro":      (15.00, 120.00),
    "gpt-5.4":        (2.50, 15.00),
    "gpt-5.4-mini":   (0.25,  2.00),
    "gpt-5.4-nano":   (0.05,  0.40),
    "gpt-5.4-pro":    (30.00, 180.00),
    # GPT-4 legacy (still common in deployments)
    "gpt-4o":         (2.50, 10.00),
    "gpt-4o-mini":    (0.15,  0.60),
    "gpt-4.1":        (2.00,  8.00),
    "gpt-4-turbo":   (10.00, 30.00),
    # Anthropic native (when not going through proxy)
    "claude-sonnet-4-6": (3.00, 15.00),
    "claude-opus-4-7":   (15.00, 75.00),
    "claude-haiku-4-5":  (0.80,  4.00),
}

# Cache-read multiplier (Anthropic charges ~10 % of standard input price for
# cache_read tokens; OpenAI does roughly the same — $0.13 vs $1.25 on GPT-5).
_CACHE_READ_DISCOUNT = 0.10

# Cache-creation multiplier — provider-specific.
# Anthropic charges 1.25× standard input for tokens written to its prompt cache.
# OpenAI / Azure don't separately bill for cache *creation* (only cache reads
# get the discount), so the multiplier is 1.0× there. Default to 1.0× for any
# model not in this lookup; the per-model fallback prefix-matches lc(model).
_CACHE_CREATE_PREMIUM_DEFAULT = 1.0
_CACHE_CREATE_PREMIUM_BY_PREFIX: dict[str, float] = {
    "claude-": 1.25,
}


def _cache_create_premium(model: str) -> float:
    lc = model.lower().strip()
    for prefix, mult in _CACHE_CREATE_PREMIUM_BY_PREFIX.items():
        if lc.startswith(prefix):
            return mult
    return _CACHE_CREATE_PREMIUM_DEFAULT


def _env_override_key(model: str, kind: str) -> str:
    """Build env-var name for per-model price override."""
    safe = re.sub(r"[^A-Za-z0-9]", "_", model).upper()
    return f"CLAUDE_PRICE_{kind}_PER_M_{safe}"


def _lookup_prices(model: str) -> Optional[tuple[float, float]]:
    """Resolve a (input_per_M, output_per_M) tuple for the given model name.

    Match precedence:
      1. Per-model env override
      2. Exact match in _PRICE_TABLE
      3. Longest prefix in _PRICE_TABLE (so dated suffixes like
         "gpt-5.4-2025-12-01" still resolve to the base "gpt-5.4")
    """
    lc = model.lower().strip()
    if not lc:
        return None

    in_env = os.environ.get(_env_override_key(lc, "INPUT"))
    out_env = os.environ.get(_env_override_key(lc, "OUTPUT"))
    if in_env is not None and out_env is not None:
        try:
            return float(in_env), float(out_env)
        except ValueError:
            pass

    if lc in _PRICE_TABLE:
        return _PRICE_TABLE[lc]

    for prefix in sorted(_PRICE_TABLE, key=len, reverse=True):
        if lc.startswith(prefix):
            return _PRICE_TABLE[prefix]
    return None


def estimate_cost_usd(model: str, usage: dict | None) -> Optional[float]:
    """Compute an estimated cost from token usage and a model price lookup.

    Returns None when the model is unknown or usage is empty, so the caller
    can leave the field unset rather than emit a misleading 0.

    Token semantics follow the Anthropic convention reported by the SDK:
      input_tokens                 — non-cached prompt tokens (full price)
      cache_read_input_tokens      — cache hits (discounted)
      cache_creation_input_tokens  — written to cache this turn (slight premium)
      output_tokens                — completion (output price)
    """
    if not usage:
        return None
    prices = _lookup_prices(model)
    if prices is None:
        return None
    in_per_m, out_per_m = prices
    inp = int(usage.get("input_tokens", 0) or 0)
    out = int(usage.get("output_tokens", 0) or 0)
    cache_read = int(usage.get("cache_read_input_tokens", 0) or 0)
    cache_create = int(usage.get("cache_creation_input_tokens", 0) or 0)
    create_premium = _cache_create_premium(model)
    cost = (
        inp / 1_000_000 * in_per_m
        + cache_read / 1_000_000 * in_per_m * _CACHE_READ_DISCOUNT
        + cache_create / 1_000_000 * in_per_m * create_premium
        + out / 1_000_000 * out_per_m
    )
    return round(cost, 6)
