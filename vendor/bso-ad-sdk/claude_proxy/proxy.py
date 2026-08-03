"""
Claude API → OpenAI-compatible API Proxy

Receives Claude /v1/messages requests, translates them to OpenAI /v1/chat/completions format,
and translates the streaming response back to Claude SSE format.

Supports OpenAI / OpenRouter / Together / Gemini / Azure — auto-detects
provider based on API key prefix. Proxy is a pure forwarder: model selection
and API key are provided by the client.

Usage:
    python proxy.py

    # Client sets ANTHROPIC_API_KEY depending on provider:
    #   OpenAI:      sk-...
    #   OpenRouter:  sk-or-...
    #   Together:    tgp_...
    #   Gemini:      AIzaSy...
    #   Azure:       azure:<endpoint>:<api-key>
    #                Endpoint MUST include the protocol scheme (https://...)
    #                and MUST end before the last ':'. The API key cannot
    #                contain a ':' character.
    #                e.g. azure:https://myres.openai.azure.com:abcdef123456
    #                Parsing: strips "azure:" prefix, then rpartitions on the
    #                LAST ':' to split endpoint from key (so "https://" colon
    #                stays inside the endpoint).
"""

import asyncio
import glob
import hashlib
import json
import os
import re
import uuid
from dataclasses import dataclass, field

import httpx
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

# ─── Config ───────────────────────────────────────────────────────────────────

PROXY_PORT = int(os.environ.get("PROXY_PORT", "18080"))

AZURE_API_VERSION = os.environ.get("AZURE_API_VERSION", "2024-12-01-preview")

# Auth: expected key the SDK must present on every request. Read once at
# import time. When set, the proxy 401s any request whose x-api-key /
# Authorization header doesn't match. This blocks unrelated localhost
# processes from using the proxy as an open relay; it does NOT defend
# against the agent itself, which inherits the same env as the SDK and
# can read this value via Bash. The full defence requires a Bash whitelist
# (Layer 3 — issue 3.1) so the agent can't introspect its own env.
_EXPECTED_API_KEY = os.environ.get("ANTHROPIC_API_KEY")

# Reasoning effort for OpenAI reasoning models (gpt-5 / o1 / o3 / o4).
# Read once at import; injected into translated payloads in translate_request
# only when the target model matches _REASONING_PREFIXES. Non-reasoning models
# (gpt-4o, gpt-4.1, claude-*) get nothing — those endpoints reject the field.
# Anthropic's Claude SDK has no native equivalent to surface this per-call,
# so we expose it as a proxy-wide env var. Acceptable values per OpenAI:
# "minimal" | "low" | "medium" | "high".
_REASONING_EFFORT = os.environ.get("REASONING_EFFORT")
_VALID_REASONING_EFFORTS = {"minimal", "low", "medium", "high"}
if _REASONING_EFFORT and _REASONING_EFFORT not in _VALID_REASONING_EFFORTS:
    raise ValueError(
        f"REASONING_EFFORT={_REASONING_EFFORT!r} not in "
        f"{sorted(_VALID_REASONING_EFFORTS)}"
    )


@dataclass
class ProviderInfo:
    name: str
    api_key: str
    base_url: str
    auth_header: str = "Authorization"   # header name for auth
    auth_prefix: str = "Bearer "         # prefix before the key value

    def chat_completions_url(self, model: str) -> str:
        """Build the full chat/completions URL (Azure needs model in path)."""
        if self.name == "azure":
            return (f"{self.base_url}/openai/deployments/{model}"
                    f"/chat/completions?api-version={AZURE_API_VERSION}")
        return f"{self.base_url}/chat/completions"

    def request_headers(self) -> dict:
        return {
            self.auth_header: f"{self.auth_prefix}{self.api_key}",
            "Content-Type": "application/json",
        }


def detect_provider(raw_key: str) -> ProviderInfo:
    """Detect provider by API key prefix and return routing info."""
    # Azure: composite key format "azure:<endpoint>:<api-key>"
    # Endpoint may contain "://" (e.g. https://...), so strip the "azure:"
    # prefix first, then rsplit on the LAST ":" — that one separates endpoint
    # from key. A naive split(":", 2) breaks on the colon inside "https://".
    if raw_key.startswith("azure:"):
        without_prefix = raw_key[len("azure:"):]
        endpoint, sep, actual_key = without_prefix.rpartition(":")
        if sep and endpoint and actual_key:
            return ProviderInfo(
                name="azure",
                api_key=actual_key,
                base_url=endpoint.rstrip("/"),
                auth_header="api-key",
                auth_prefix="",
            )

    # Together AI (keys start with `tgp_`)
    if raw_key.startswith("tgp_"):
        return ProviderInfo(
            name="together", api_key=raw_key,
            base_url="https://api.together.xyz/v1",
        )

    # OpenRouter (must be checked before generic sk- to avoid misrouting)
    if raw_key.startswith("sk-or-"):
        return ProviderInfo(
            name="openrouter", api_key=raw_key,
            base_url="https://openrouter.ai/api/v1",
        )

    # OpenAI
    if raw_key.startswith("sk-"):
        return ProviderInfo(
            name="openai", api_key=raw_key,
            base_url="https://api.openai.com/v1",
        )

    # Gemini
    if raw_key.startswith("AIzaSy"):
        return ProviderInfo(
            name="gemini", api_key=raw_key,
            base_url="https://generativelanguage.googleapis.com/v1beta/openai",
        )

    # Unknown prefix — refuse rather than silently defaulting to OpenAI.
    # Past behaviour was: any unrecognised key got sent to api.openai.com and
    # came back 401, which masked the real problem (typo / missing prefix /
    # forgotten "azure:" composite form).
    prefix_preview = raw_key[:12] if raw_key else "(empty)"
    raise ValueError(
        "Unrecognised ANTHROPIC_API_KEY prefix. Supported formats:\n"
        "  sk-ant-*                 — Anthropic (handled outside the proxy)\n"
        "  sk-or-v1-*               — OpenRouter\n"
        "  sk-*                     — OpenAI\n"
        "  tgp_*                    — Together AI\n"
        "  AIzaSy*                  — Gemini\n"
        "  azure:https://<host>:<key> — Azure OpenAI (composite)\n"
        f"Got: {prefix_preview}..."
    )

app = FastAPI()


# ─── Schema Sanitization ─────────────────────────────────────────────────────
# Ref: claudish transform.ts:removeUriFormat + openai-tools.ts:sanitizeSchemaForOpenAI


def remove_uri_format(schema):
    """Recursively remove format:"uri" from JSON Schema (unsupported by OpenAI)."""
    if schema is None or not isinstance(schema, dict):
        return schema
    if isinstance(schema, list):
        return [remove_uri_format(item) for item in schema]

    if schema.get("type") == "string" and schema.get("format") == "uri":
        return {k: v for k, v in schema.items() if k != "format"}

    result = {}
    for key, value in schema.items():
        if key == "properties" and isinstance(value, dict):
            result[key] = {pk: remove_uri_format(pv) for pk, pv in value.items()}
        elif key == "items" and isinstance(value, dict):
            result[key] = remove_uri_format(value)
        elif key == "additionalProperties" and isinstance(value, dict):
            result[key] = remove_uri_format(value)
        elif key in ("anyOf", "allOf", "oneOf") and isinstance(value, list):
            result[key] = [remove_uri_format(item) for item in value]
        else:
            result[key] = value
    return result


def sanitize_schema(schema):
    """Sanitize tool input_schema for OpenAI function calling compatibility."""
    if not schema or not isinstance(schema, dict):
        return remove_uri_format(schema)

    root = dict(schema)

    # Collapse top-level oneOf/anyOf/allOf
    for combiner in ("oneOf", "anyOf", "allOf"):
        branches = root.get(combiner)
        if isinstance(branches, list) and len(branches) > 0:
            obj_branch = next(
                (b for b in branches if isinstance(b, dict) and b.get("type") == "object"),
                None,
            )
            if obj_branch:
                del root[combiner]
                root.update(obj_branch)
            else:
                root = {"type": "object", "properties": {}, "additionalProperties": True}
            break

    root.pop("enum", None)
    root.pop("not", None)
    root["type"] = "object"

    return remove_uri_format(root)


# ─── Request Translation ─────────────────────────────────────────────────────
# Ref: claudish openai-messages.ts, openai-tools.ts, openai-api-format.ts


# Anthropic SDK injects this header line into the system prompt for its own
# billing telemetry. The `cch=<hex>` field changes every turn, which sits at
# the very start of the system message and would otherwise break OpenAI /
# Azure prefix-caching turn over turn (one byte of drift in the prefix is
# enough to force a full re-tokenize). Strip the line for non-Anthropic
# providers — the proxy never routes Anthropic-native traffic anyway
# (sk-ant-* keys bypass us via the SDK's direct path).
_BILLING_HEADER_RE = re.compile(
    r"^x-anthropic-billing-header:[^\n]*\n*", re.MULTILINE
)


def _strip_anthropic_billing_header(text: str) -> str:
    return _BILLING_HEADER_RE.sub("", text).lstrip("\n")


def convert_system(body):
    """Claude system array → OpenAI system message string."""
    sys = body.get("system")
    if not sys:
        return []

    if isinstance(sys, list):
        parts = []
        for item in sys:
            if isinstance(item, dict):
                parts.append(item.get("text", ""))
            else:
                parts.append(str(item))
        content = "\n\n".join(parts)
    else:
        content = str(sys)

    content = _strip_anthropic_billing_header(content)
    if not content:
        return []
    return [{"role": "system", "content": content}]


def convert_user_message(msg):
    """Claude user message → OpenAI messages (may produce multiple due to tool_result splitting)."""
    content = msg.get("content")

    if isinstance(content, str):
        return [{"role": "user", "content": content}]

    if not isinstance(content, list):
        return [{"role": "user", "content": str(content)}]

    content_parts = []
    tool_results = []
    seen = set()

    for block in content:
        block_type = block.get("type")

        if block_type == "text":
            content_parts.append({"type": "text", "text": block["text"]})

        elif block_type == "image":
            source = block.get("source", {})
            media_type = source.get("media_type", "image/png")
            data = source.get("data", "")
            content_parts.append({
                "type": "image_url",
                "image_url": {"url": f"data:{media_type};base64,{data}"},
            })

        elif block_type == "tool_result":
            tool_use_id = block.get("tool_use_id", "")
            if tool_use_id in seen:
                continue
            seen.add(tool_use_id)

            result_content = block.get("content", "")
            if not isinstance(result_content, str):
                result_content = json.dumps(result_content)

            tool_results.append({
                "role": "tool",
                "content": result_content,
                "tool_call_id": tool_use_id,
            })

    # Tool results first, then user message (ref: claudish line 93)
    messages = []
    if tool_results:
        messages.extend(tool_results)
    if content_parts:
        messages.append({"role": "user", "content": content_parts})
    return messages


def convert_assistant_message(msg):
    """Claude assistant message → OpenAI assistant message."""
    content = msg.get("content")

    if isinstance(content, str):
        return [{"role": "assistant", "content": content}]

    if not isinstance(content, list):
        return [{"role": "assistant", "content": str(content)}]

    strings = []
    thinking_strings = []
    tool_calls = []
    seen = set()

    for block in content:
        block_type = block.get("type")

        if block_type == "text":
            strings.append(block["text"])

        elif block_type == "thinking":
            # Anthropic extended-thinking blocks. Most OpenAI-compatible
            # endpoints don't accept a structured thinking block, so we
            # surface the chain-of-thought as a tagged prefix on the
            # assistant message — preserves the reasoning when replaying
            # a Claude session through a non-Claude provider, instead of
            # dropping it on the floor (which made cross-model relay
            # produce noticeably worse follow-ups).
            t = block.get("thinking") or ""
            if t:
                thinking_strings.append(str(t))

        elif block_type == "tool_use":
            block_id = block.get("id", "")
            if block_id in seen:
                continue
            seen.add(block_id)

            tool_calls.append({
                "id": block_id,
                "type": "function",
                "function": {
                    "name": block["name"],
                    "arguments": json.dumps(block.get("input", {})),
                },
            })

    m = {"role": "assistant"}
    text_body = " ".join(strings) if strings else ""
    if thinking_strings:
        # Tagged so the receiving model can recognise it as prior
        # chain-of-thought rather than authoritative response text.
        thinking_body = "\n\n".join(thinking_strings)
        prefix = f"<thinking>\n{thinking_body}\n</thinking>\n\n"
        text_body = prefix + text_body if text_body else prefix.rstrip()
    if text_body:
        m["content"] = text_body
    elif tool_calls:
        m["content"] = None

    if tool_calls:
        m["tool_calls"] = tool_calls

    if m.get("content") is not None or m.get("tool_calls"):
        return [m]
    return []


def convert_tools(body):
    """Claude tools → OpenAI function calling tools."""
    tools = body.get("tools")
    if not tools:
        return []

    return [
        {
            "type": "function",
            "function": {
                "name": tool["name"],
                "description": tool.get("description", ""),
                "parameters": sanitize_schema(tool.get("input_schema", {})),
            },
        }
        for tool in tools
    ]


# Models that require the new `max_completion_tokens` parameter and refuse
# the legacy `max_tokens`. Match prefix-only — e.g. "gpt-5", "gpt-5-turbo",
# "o1-mini" all match. Older models (gpt-4o, gpt-4.1, gpt-3.5-turbo) still
# need `max_tokens`. When in doubt about Azure deployment names, the user
# can override via env var (model name there is the deployment, not the
# underlying model id).
_NEW_TOKEN_PARAM_PREFIXES = ("gpt-5", "o1", "o3", "o4", "gpt-6")

# Output-token caps per model family. The Claude Code CLI sends
# max_tokens=32000 by default, but several Azure deployments cap output
# at a lower value (gpt-4o = 16384) and would return 400. Match by prefix;
# first hit wins. Models not listed pass through unmodified.
_MODEL_OUTPUT_CAPS = {
    "gpt-4o":    16384,
    "gpt-4.1":   16384,
    "gpt-3.5":   4096,
}

# Reasoning models that reject `temperature` (API returns 400). Same prefix
# match. Note: gpt-4o/gpt-4.1 ARE NOT reasoning models — they accept
# temperature.
_REASONING_PREFIXES = ("o1", "o3", "o4", "gpt-5")


def _model_uses_completion_tokens(model: str) -> bool:
    name = (model or "").lower()
    return any(name.startswith(p) for p in _NEW_TOKEN_PARAM_PREFIXES)


def _model_rejects_temperature(model: str) -> bool:
    name = (model or "").lower()
    return any(name.startswith(p) for p in _REASONING_PREFIXES)


# HTTP statuses where retrying with backoff is appropriate. 429 is the
# common case (Azure throttle); 500/502/503/504 cover transient upstream
# blips. Anything outside this set fails immediately — non-retriable
# client errors (400 invalid_value, 401 auth, 404 not found) would only
# delay the inevitable.
_RETRY_STATUSES = {429, 500, 502, 503, 504}
_RETRY_MAX_ATTEMPTS = int(os.environ.get("PROXY_RETRY_MAX_ATTEMPTS", "6"))
_RETRY_BASE_SECONDS = float(os.environ.get("PROXY_RETRY_BASE_SECONDS", "1.0"))
_RETRY_CAP_SECONDS = float(os.environ.get("PROXY_RETRY_CAP_SECONDS", "30.0"))


def _retry_after_seconds(headers, attempt: int) -> float:
    """Compute the wait before the next retry. Honors Azure/OpenAI's
    `Retry-After` (seconds) and `Retry-After-Ms` (milliseconds) headers
    when present; otherwise falls back to exponential backoff
    base * 2**attempt, capped at PROXY_RETRY_CAP_SECONDS.
    """
    ra_ms = headers.get("retry-after-ms")
    if ra_ms:
        try:
            return min(float(ra_ms) / 1000.0, _RETRY_CAP_SECONDS)
        except ValueError:
            pass
    ra = headers.get("retry-after")
    if ra:
        try:
            return min(float(ra), _RETRY_CAP_SECONDS)
        except ValueError:
            # Header may be an HTTP-date for non-Azure providers; ignore.
            pass
    return min(_RETRY_BASE_SECONDS * (2 ** attempt), _RETRY_CAP_SECONDS)


def translate_request(body, model):
    """Full Claude → OpenAI request translation."""
    messages = convert_system(body)

    for msg in body.get("messages", []):
        role = msg.get("role")
        if role == "user":
            messages.extend(convert_user_message(msg))
        elif role == "assistant":
            messages.extend(convert_assistant_message(msg))

    tools = convert_tools(body)

    payload = {
        "model": model,
        "messages": messages,
        "stream": True,
        "stream_options": {"include_usage": True},
    }

    if body.get("max_tokens"):
        # Newer reasoning models (gpt-5/o1/o3/o4) require
        # `max_completion_tokens`; older OpenAI / Azure deployments
        # (gpt-4o, gpt-4.1, gpt-3.5) still require `max_tokens`.
        # Picking the wrong key gets a 400 from the upstream API.
        token_key = "max_completion_tokens" if _model_uses_completion_tokens(model) else "max_tokens"
        requested = body["max_tokens"]
        # Per-model output cap. Claude Code CLI sends max_tokens=32000 by
        # default, but several Azure deployments cap output lower → 400
        # invalid_value. Clamp here so callers don't have to know each
        # model's limit.
        for prefix, cap in _MODEL_OUTPUT_CAPS.items():
            if model.startswith(prefix) and requested > cap:
                requested = cap
                break
        payload[token_key] = requested

    if body.get("temperature") is not None and not _model_rejects_temperature(model):
        # Reasoning models (o1/o3/o4/gpt-5) reject the temperature param
        # with a 400; SDK defaults to temperature=1.0 so we'd otherwise
        # break every call to those models silently.
        payload["temperature"] = body["temperature"]

    if _REASONING_EFFORT and _model_rejects_temperature(model):
        # Reuse the temperature-rejection predicate as the gate: it tracks
        # _REASONING_PREFIXES, the exact set of models that accept (and need)
        # reasoning_effort. Non-reasoning models 400 on this field.
        payload["reasoning_effort"] = _REASONING_EFFORT

    if tools:
        payload["tools"] = tools

    # tool_choice translation
    tc = body.get("tool_choice")
    if tc:
        tc_type = tc.get("type") if isinstance(tc, dict) else tc
        tc_name = tc.get("name") if isinstance(tc, dict) else None
        if tc_type == "tool" and tc_name:
            payload["tool_choice"] = {"type": "function", "function": {"name": tc_name}}
        elif tc_type in ("auto", "none"):
            payload["tool_choice"] = tc_type

    return payload


# ─── Stream Response Translation ─────────────────────────────────────────────
# Ref: claudish openai-sse.ts state machine


@dataclass
class ToolState:
    id: str
    name: str
    block_index: int
    started: bool = False
    closed: bool = False
    arguments: str = ""


@dataclass
class StreamState:
    text_started: bool = False
    text_idx: int = -1
    thinking_started: bool = False
    thinking_idx: int = -1
    cur_idx: int = 0
    tools: dict = field(default_factory=dict)
    usage: dict = field(default_factory=dict)
    stop_reason: str = "end_turn"


def format_sse(event_type, data):
    """Format a Claude SSE event."""
    return f"event: {event_type}\ndata: {json.dumps(data)}\n\n".encode()


async def translate_stream(response_lines, model_name, allowed_tools=None):
    """Translate OpenAI SSE stream → Claude SSE stream.

    `allowed_tools` is the set of tool names the client declared in the
    request. Some providers (OpenRouter + MiniMax, etc.) inject their own
    built-in tools (`fetch_fetch`, `fetch_search_results`, ...) that the
    Claude SDK never registered. If forwarded, the SDK has no handler and
    the agent hangs waiting for a tool_result. We silently drop any
    tool_call whose name isn't in `allowed_tools`.
    """
    state = StreamState()
    dropped_tool_indices: set[int] = set()
    dropped_tool_names: list[str] = []
    msg_id = f"msg_{uuid.uuid4().hex[:16]}"

    yield format_sse("message_start", {
        "type": "message_start",
        "message": {
            "id": msg_id,
            "type": "message",
            "role": "assistant",
            "content": [],
            "model": model_name,
            "stop_reason": None,
            "stop_sequence": None,
            "usage": {"input_tokens": 0, "output_tokens": 0},
        },
    })
    yield format_sse("ping", {"type": "ping"})

    async for line in response_lines:
        line = line.strip()
        if not line or not line.startswith("data: "):
            continue

        data_str = line[6:]
        if data_str == "[DONE]":
            break

        try:
            chunk = json.loads(data_str)
        except json.JSONDecodeError:
            continue

        if chunk.get("usage"):
            state.usage = chunk["usage"]

        choices = chunk.get("choices", [])
        if not choices:
            continue

        choice = choices[0]
        delta = choice.get("delta", {})
        finish_reason = choice.get("finish_reason")

        # Reasoning content (OpenAI-style `delta.reasoning` from reasoning
        # models like minimax-m2, deepseek-r1). Forward as a Claude thinking
        # block so it's visible to on_thinking callbacks. Without this, the
        # whole chain-of-thought is silently dropped and the model often
        # appears to "do nothing" in logs.
        reasoning_content = delta.get("reasoning")
        if reasoning_content:
            if not state.thinking_started:
                state.thinking_idx = state.cur_idx
                state.cur_idx += 1
                yield format_sse("content_block_start", {
                    "type": "content_block_start",
                    "index": state.thinking_idx,
                    "content_block": {"type": "thinking", "thinking": ""},
                })
                state.thinking_started = True

            yield format_sse("content_block_delta", {
                "type": "content_block_delta",
                "index": state.thinking_idx,
                "delta": {"type": "thinking_delta", "thinking": reasoning_content},
            })

        # Text content
        text_content = delta.get("content")
        if text_content:
            # Close thinking block before starting text (Claude order: thinking → text)
            if state.thinking_started:
                # Emit signature_delta — Anthropic's real API always sends one
                # before closing a thinking block. Some SDK versions reject
                # the response as malformed if it's missing.
                yield format_sse("content_block_delta", {
                    "type": "content_block_delta",
                    "index": state.thinking_idx,
                    "delta": {"type": "signature_delta", "signature": ""},
                })
                yield format_sse("content_block_stop", {
                    "type": "content_block_stop",
                    "index": state.thinking_idx,
                })
                state.thinking_started = False

            if not state.text_started:
                state.text_idx = state.cur_idx
                state.cur_idx += 1
                yield format_sse("content_block_start", {
                    "type": "content_block_start",
                    "index": state.text_idx,
                    "content_block": {"type": "text", "text": ""},
                })
                state.text_started = True

            yield format_sse("content_block_delta", {
                "type": "content_block_delta",
                "index": state.text_idx,
                "delta": {"type": "text_delta", "text": text_content},
            })

        # Tool calls
        tool_calls = delta.get("tool_calls")
        if tool_calls:
            for tc in tool_calls:
                idx = tc.get("index", 0)
                func = tc.get("function", {})
                tool_name = func.get("name")
                tool_args = func.get("arguments", "")

                # Drop server-injected tools the client didn't declare.
                if tool_name and allowed_tools is not None and tool_name not in allowed_tools:
                    dropped_tool_indices.add(idx)
                    dropped_tool_names.append(tool_name)
                    print(
                        f"[proxy] dropping unsolicited tool_call: {tool_name}"
                        f" (allowed={sorted(allowed_tools)[:6]}...)",
                        flush=True,
                    )
                    continue
                if idx in dropped_tool_indices:
                    continue

                if tool_name:
                    print(f"[proxy] tool_call: {tool_name}", flush=True)
                    # Close any open text/thinking block before starting a tool
                    if state.text_started:
                        yield format_sse("content_block_stop", {
                            "type": "content_block_stop",
                            "index": state.text_idx,
                        })
                        state.text_started = False
                    if state.thinking_started:
                        yield format_sse("content_block_delta", {
                            "type": "content_block_delta",
                            "index": state.thinking_idx,
                            "delta": {"type": "signature_delta", "signature": ""},
                        })
                        yield format_sse("content_block_stop", {
                            "type": "content_block_stop",
                            "index": state.thinking_idx,
                        })
                        state.thinking_started = False

                    tool_id = tc.get("id", f"tool_{uuid.uuid4().hex[:12]}")
                    block_idx = state.cur_idx
                    state.cur_idx += 1

                    t = ToolState(
                        id=tool_id,
                        name=tool_name,
                        block_index=block_idx,
                        started=True,
                    )
                    state.tools[idx] = t

                    yield format_sse("content_block_start", {
                        "type": "content_block_start",
                        "index": block_idx,
                        "content_block": {"type": "tool_use", "id": tool_id, "name": tool_name},
                    })

                if tool_args and idx in state.tools:
                    t = state.tools[idx]
                    t.arguments += tool_args
                    yield format_sse("content_block_delta", {
                        "type": "content_block_delta",
                        "index": t.block_index,
                        "delta": {"type": "input_json_delta", "partial_json": tool_args},
                    })

        if finish_reason:
            if finish_reason == "tool_calls":
                state.stop_reason = "tool_use"
            elif finish_reason == "length":
                state.stop_reason = "max_tokens"
            else:
                state.stop_reason = "end_turn"

    # If we dropped tool_calls and emitted no text/tool, the assistant
    # message would be empty (or only contain a thinking block). Claude CLI
    # rejects that with "model's tool call could not be parsed". Inject a
    # text block so the SDK has something concrete and the model sees its
    # own attempt on the next turn — usually enough to make it switch to
    # the listed tools.
    # Close any open blocks before potentially injecting a synthetic one.
    if state.thinking_started:
        yield format_sse("content_block_delta", {
            "type": "content_block_delta",
            "index": state.thinking_idx,
            "delta": {"type": "signature_delta", "signature": ""},
        })
        yield format_sse("content_block_stop", {
            "type": "content_block_stop",
            "index": state.thinking_idx,
        })
        state.thinking_started = False
    if state.text_started:
        yield format_sse("content_block_stop", {
            "type": "content_block_stop",
            "index": state.text_idx,
        })
        state.text_started = False

    # If the entire stream produced no actionable content block, the SDK
    # reports "API returned an empty or malformed response (HTTP 200)".
    # Inject a placeholder text so the message has at least one content
    # block. Either:
    #   (a) we dropped unsolicited tools and there's no fallback content, or
    #   (b) the upstream returned literally nothing (no reasoning/text/tools).
    forwarded_tools = [t for t in state.tools.values() if t.started]
    nothing_emitted = (
        state.thinking_idx < 0  # no thinking block opened
        and state.text_idx < 0  # no text block opened
        and not forwarded_tools  # no tool calls forwarded
    )
    if nothing_emitted:
        synth_idx = state.cur_idx
        state.cur_idx += 1
        yield format_sse("content_block_start", {
            "type": "content_block_start",
            "index": synth_idx,
            "content_block": {"type": "text", "text": ""},
        })
        yield format_sse("content_block_delta", {
            "type": "content_block_delta",
            "index": synth_idx,
            "delta": {"type": "text_delta", "text": "[empty response from upstream]"},
        })
        yield format_sse("content_block_stop", {
            "type": "content_block_stop",
            "index": synth_idx,
        })
    elif dropped_tool_names and not forwarded_tools:
        synth_idx = state.cur_idx
        state.cur_idx += 1
        names = ", ".join(dropped_tool_names)
        msg = (
            f"[Tried to call unavailable tool(s): {names}. These are not "
            f"part of this environment. Use only the tools listed in the "
            f"system prompt and the project skill.]"
        )
        yield format_sse("content_block_start", {
            "type": "content_block_start",
            "index": synth_idx,
            "content_block": {"type": "text", "text": ""},
        })
        yield format_sse("content_block_delta", {
            "type": "content_block_delta",
            "index": synth_idx,
            "delta": {"type": "text_delta", "text": msg},
        })
        yield format_sse("content_block_stop", {
            "type": "content_block_stop",
            "index": synth_idx,
        })

    for t in state.tools.values():
        if t.started and not t.closed:
            yield format_sse("content_block_stop", {
                "type": "content_block_stop",
                "index": t.block_index,
            })
            t.closed = True

    # Map OpenAI usage → Anthropic usage. OpenAI streams a single `usage`
    # block in the final chunk (only when stream_options.include_usage=True),
    # which is captured into state.usage above. message_start was emitted
    # before usage arrived (with 0/0 placeholders); the Anthropic streaming
    # spec lets message_delta.usage carry the *final* cumulative counts —
    # the SDK merges these into the message's final usage.
    op_usage = state.usage or {}
    output_tokens = op_usage.get("completion_tokens", 0)
    raw_prompt_tokens = op_usage.get("prompt_tokens", 0)
    # Some OpenAI deployments (and Azure) report cached tokens under
    # prompt_tokens_details.cached_tokens. Map that to Anthropic's
    # cache_read_input_tokens. OpenAI's prompt_tokens is the *total* count
    # (including cached); Anthropic's input_tokens excludes cached and
    # surfaces them separately. Subtract so the schema matches the
    # SDK's expectations and downstream cost math doesn't double-count.
    # OpenAI has no analogue for cache *creation* (writes are not
    # separately billed), so cache_creation_input_tokens stays 0.
    prompt_details = op_usage.get("prompt_tokens_details") or {}
    cache_read = prompt_details.get("cached_tokens", 0)
    input_tokens = max(raw_prompt_tokens - cache_read, 0)
    yield format_sse("message_delta", {
        "type": "message_delta",
        "delta": {"stop_reason": state.stop_reason, "stop_sequence": None},
        "usage": {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cache_creation_input_tokens": 0,
            "cache_read_input_tokens": cache_read,
        },
    })
    yield format_sse("message_stop", {"type": "message_stop"})


# ─── Routes ───────────────────────────────────────────────────────────────────


@app.get("/")
async def health():
    return {"status": "ok", "proxy": "claude-to-openai-compatible"}


@app.post("/v1/messages")
async def handle_messages(request: Request):
    body = await request.json()

    # Read key and model from client request
    raw_key = (
        request.headers.get("x-api-key")
        or request.headers.get("authorization", "").removeprefix("Bearer ")
        or ""
    )
    model = body.get("model", "")

    # Reject requests whose key doesn't match the configured one. Compares
    # only when _EXPECTED_API_KEY is set (skip in test / dev where the env
    # might be unset).
    if _EXPECTED_API_KEY and raw_key != _EXPECTED_API_KEY:
        return JSONResponse(
            status_code=401,
            content={
                "type": "error",
                "error": {
                    "type": "authentication_error",
                    "message": (
                        "Proxy received a request whose api key does not "
                        "match the configured ANTHROPIC_API_KEY. This proxy "
                        "only accepts requests authorised with the same key "
                        "set in its environment at startup."
                    ),
                },
            },
        )

    # Auto-detect provider by key prefix (may raise ValueError on unknown
    # prefix — translate to a 400 so SDK callers see a structured error
    # instead of a 500).
    try:
        provider = detect_provider(raw_key)
    except ValueError as exc:
        return JSONResponse(
            status_code=400,
            content={
                "type": "error",
                "error": {"type": "invalid_request_error", "message": str(exc)},
            },
        )

    openai_payload = translate_request(body, model)
    url = provider.chat_completions_url(model)
    allowed_tools = {
        t["function"]["name"]
        for t in openai_payload.get("tools", [])
        if isinstance(t, dict) and t.get("function", {}).get("name")
    }

    # Cache-diagnostic fingerprints. Azure OpenAI auto-caches only when the
    # *exact* prefix has been seen recently — even one varying byte (a
    # timestamp, a cwd listing, a random session id in the system prompt)
    # breaks the prefix and forces full input-token billing on every turn.
    # Hash the system message and the sorted tool-name list separately so we
    # can tell which one is drifting between runs.
    sys_text = ""
    for m in openai_payload["messages"]:
        if m.get("role") == "system":
            sys_text = m.get("content", "") or ""
            break
    sys_hash = hashlib.sha256(sys_text.encode("utf-8", errors="replace")).hexdigest()[:8]
    tools_sorted = sorted(
        t["function"]["name"]
        for t in openai_payload.get("tools", [])
        if isinstance(t, dict) and t.get("function", {}).get("name")
    )
    tools_hash = hashlib.sha256(
        "\n".join(tools_sorted).encode("utf-8")
    ).hexdigest()[:8]

    print(f"[proxy] {provider.name} | model={model} | "
          f"msgs={len(openai_payload['messages'])} | "
          f"tools={len(openai_payload.get('tools', []))} | "
          f"sys_hash={sys_hash} | tools_hash={tools_hash} | "
          f"sys_len={len(sys_text)} | "
          f"max_tokens={openai_payload.get('max_tokens')}",
          flush=True)
    # One-shot dump of the system prompt content the first time we see each
    # unique hash. Helps spot dynamic content (timestamps, session ids) that
    # break Azure prefix-caching turn-over-turn.
    #
    # Debug-only — do NOT enable in production. Bounded by PROXY_DUMP_SYS_MAX
    # (default 20) to keep /tmp from filling up if a long-running proxy keeps
    # seeing fresh hashes.
    if os.environ.get("PROXY_DUMP_SYS") == "1" and sys_text:
        try:
            max_files = int(os.environ.get("PROXY_DUMP_SYS_MAX", "20"))
        except ValueError:
            max_files = 20
        dump_path = f"/tmp/proxy_sys_{sys_hash}.txt"
        if not os.path.exists(dump_path):
            existing = glob.glob("/tmp/proxy_sys_*.txt")
            if len(existing) >= max_files:
                print(
                    f"[proxy]   sys_text dump skipped (cap "
                    f"PROXY_DUMP_SYS_MAX={max_files} reached, "
                    f"{len(existing)} files in /tmp)",
                    flush=True,
                )
            else:
                try:
                    with open(dump_path, "w", encoding="utf-8") as fh:
                        fh.write(sys_text)
                    print(f"[proxy]   sys_text dumped → {dump_path}", flush=True)
                except OSError:
                    pass

    async def stream_generator():
        async with httpx.AsyncClient() as client:
            # Retry loop: 429 throttles + 5xx blips are retried with backoff.
            # Without this, the upstream throttle would surface to the Claude
            # Code CLI as a fatal "result: error" event — the CLI then exits
            # cleanly and the SDK reports "Claude Code returned an error
            # result: success", leaving the agent run with empty output.
            for attempt in range(_RETRY_MAX_ATTEMPTS):
                async with client.stream(
                    "POST", url,
                    json=openai_payload,
                    headers=provider.request_headers(),
                    timeout=httpx.Timeout(300.0, connect=10.0),
                ) as resp:
                    if (
                        resp.status_code in _RETRY_STATUSES
                        and attempt < _RETRY_MAX_ATTEMPTS - 1
                    ):
                        delay = _retry_after_seconds(resp.headers, attempt)
                        error_body = await resp.aread()
                        snippet = error_body.decode(errors="replace")[:200]
                        print(
                            f"[proxy] {provider.name} {resp.status_code} "
                            f"(attempt {attempt + 1}/{_RETRY_MAX_ATTEMPTS}) — "
                            f"retrying in {delay:.1f}s. body[:200]={snippet}",
                            flush=True,
                        )
                        await asyncio.sleep(delay)
                        continue

                    if resp.status_code != 200:
                        error_body = await resp.aread()
                        error_msg = error_body.decode()[:500]
                        print(f"[proxy] {provider.name} error {resp.status_code}: {error_msg}")
                        yield format_sse("error", {
                            "type": "error",
                            "error": {
                                "type": "api_error",
                                "message": f"{provider.name} error {resp.status_code}: {error_msg}",
                            },
                        })
                        return

                    # Optional fixture-capture hook. Mirrors PROXY_DUMP_SYS pattern:
                    # writes the raw upstream SSE to /tmp/proxy_upstream_<sys_hash>.sse
                    # so that tests/fixtures/proxy/ can be refreshed via a real call.
                    # Production runs leave PROXY_DUMP_STREAM unset and pay nothing.
                    upstream_lines = resp.aiter_lines()
                    if os.environ.get("PROXY_DUMP_STREAM") == "1":
                        dump_path = f"/tmp/proxy_upstream_{sys_hash}.sse"
                        print(f"[proxy]   upstream SSE dumped → {dump_path}", flush=True)

                        async def _tee_to_file(source, path):
                            # Truncate on first line so each request gets a fresh file.
                            with open(path, "w", encoding="utf-8") as fh:
                                async for line in source:
                                    fh.write(line + "\n")
                                    fh.flush()
                                    yield line

                        upstream_lines = _tee_to_file(upstream_lines, dump_path)

                    async for chunk in translate_stream(
                        upstream_lines, model, allowed_tools=allowed_tools
                    ):
                        yield chunk
                    return

    return StreamingResponse(
        stream_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
    )


# ─── Startup ──────────────────────────────────────────────────────────────────

SUPPORTED_PROVIDERS = ["openai", "openrouter", "together", "gemini", "azure"]

if __name__ == "__main__":
    print(f"Claude → OpenAI-compatible proxy")
    print(f"  Listening: http://127.0.0.1:{PROXY_PORT}")
    print(f"  Providers: {', '.join(SUPPORTED_PROVIDERS)}")
    print(f"  Model & Key: provided by client, proxy auto-routes by key prefix")
    print()

    uvicorn.run(app, host="127.0.0.1", port=PROXY_PORT, log_level="warning")
