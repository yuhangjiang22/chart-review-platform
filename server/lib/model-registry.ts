// server/lib/model-registry.ts
// TypeScript reader for the model registry (python/models.json). Mirrors the
// Python copy (python/chart_review_deepagents/registry.py) — keep the contract
// in sync (see docs/superpowers/specs/2026-06-06-per-agent-model-mixing-design.md).
// This reader is PRESENCE-ONLY: it checks whether secret env vars are SET to
// compute availability, but never returns their values.
import fs from "node:fs";
import path from "node:path";
import { PLATFORM_ROOT } from "@chart-review/patients";

const DEFAULT_MODELS_PATH = path.join(PLATFORM_ROOT, "python", "models.json");

interface AzureEntry {
  backend: "azure"; deployment: string;
  endpoint_env?: string; api_key_env?: string; api_version_env?: string; default?: boolean;
}
interface VllmEntry {
  backend: "vllm"; base_url?: string; base_url_env?: string; model: string; api_key_env?: string; default?: boolean;
}
type Entry = AzureEntry | VllmEntry;
type Registry = Record<string, Entry>;

export interface ModelInfo { id: string; backend: "azure" | "vllm"; label: string; available: boolean; }
export interface ListModelsResult { models: ModelInfo[]; default: string | null; }

function synthesize(env: NodeJS.ProcessEnv): Registry {
  const backend = (env.DEEPAGENTS_LLM_BACKEND ?? "azure").toLowerCase();
  if (backend === "vllm") {
    const key = env.VLLM_MODEL || "vllm-default";
    return { [key]: { backend: "vllm", base_url: env.VLLM_BASE_URL ?? "", model: env.VLLM_MODEL ?? "", api_key_env: "VLLM_API_KEY", default: true } };
  }
  const key = env.AZURE_OPENAI_DEPLOYMENT || "azure-default";
  return { [key]: { backend: "azure", deployment: env.AZURE_OPENAI_DEPLOYMENT ?? "", default: true } };
}

function loadRegistry(env: NodeJS.ProcessEnv, modelsPath: string): Registry {
  try {
    if (fs.existsSync(modelsPath)) {
      const parsed = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("models.json root must be a JSON object");
      }
      return parsed as Registry;
    }
  } catch (err) {
    console.warn(
      `[model-registry] could not load ${modelsPath} (${(err as Error).message}) — falling back to env synthesis`,
    );
  }
  return synthesize(env);
}

// Tokens that appear ONLY in the .env.example / .env.docker.example placeholders.
// A value containing one of these is treated as not-yet-configured. Keep this
// list in sync with python/chart_review_deepagents/registry.py (_PLACEHOLDER_TOKENS).
//   your-vllm-host / YOUR-RESOURCE  -> .env.docker.example
//   <resource>                      -> .env.example (bare-metal) azure endpoint
const PLACEHOLDER_TOKENS = ["your-vllm-host", "your-resource", "<resource>"] as const;

function isConfigured(value: string | undefined): boolean {
  if (!value) return false;
  const lower = value.toLowerCase();
  return !PLACEHOLDER_TOKENS.some((t) => lower.includes(t));
}

function available(entry: Entry, env: NodeJS.ProcessEnv): boolean {
  if (entry.backend === "azure") {
    const ep = env[entry.endpoint_env ?? "AZURE_OPENAI_ENDPOINT"];
    const key = env[entry.api_key_env ?? "AZURE_OPENAI_API_KEY"];
    return isConfigured(ep) && !!key;
  }
  // vllm: the base URL must be set AND not the example placeholder.
  const baseUrl = entry.base_url_env ? env[entry.base_url_env] : entry.base_url;
  return isConfigured(baseUrl);
}

/** The provider label shown in the picker. The "vllm" backend is really
 *  "any OpenAI-compatible endpoint"; when its base URL points at OpenRouter we
 *  show "OpenRouter" (and "vLLM" otherwise) so the picker reflects where the
 *  model actually runs, not the registry's internal backend name. */
function providerLabel(entry: Entry, env: NodeJS.ProcessEnv): string {
  if (entry.backend === "azure") return "azure";
  const baseUrl = (entry.base_url_env ? env[entry.base_url_env] : entry.base_url) ?? "";
  if (/openrouter\.ai/i.test(baseUrl)) return "OpenRouter";
  return "vllm";
}

function label(entry: Entry, env: NodeJS.ProcessEnv): string {
  return entry.backend === "azure"
    ? `azure · ${entry.deployment}`
    : `${providerLabel(entry, env)} · ${entry.model}`;
}

export function listModels(opts?: { env?: NodeJS.ProcessEnv; modelsPath?: string }): ListModelsResult {
  const env = opts?.env ?? process.env;
  const modelsPath = opts?.modelsPath ?? DEFAULT_MODELS_PATH;
  const registry = loadRegistry(env, modelsPath);
  const models: ModelInfo[] = [];
  let def: string | null = null;
  for (const [id, entry] of Object.entries(registry)) {
    const avail = available(entry, env);
    models.push({ id, backend: entry.backend, label: label(entry, env), available: avail });
    if (avail && def === null) def = id;
  }
  const marked = Object.entries(registry).find(([, e]) => e.default && available(e, env));
  if (marked) def = marked[0];
  return { models, default: def };
}

// ── server-side endpoint resolver (SECRET-BEARING — never expose via a route) ──
//
// `listModels` above is presence-only: it tells the API which models exist and
// whether their env is configured, but never returns the API keys. The NER
// extractor (`extractSpansDirect`) runs in TypeScript and calls OpenRouter /
// Azure directly, so it needs the resolved connection details — base URL, API
// key, concrete model id, and the transport mode. The Python deepagents sidecar
// resolves these in Python for the phenotype path; this is the TS equivalent for
// the direct-LLM NER path. Keep it OFF every Express route — it returns secrets.

/** Transport selector matching `@chart-review/pipeline-extract-ner`'s LlmMode. */
export type ModelEndpointMode = "openrouter" | "azure-responses";

export interface ResolvedModelEndpoint {
  /** Base URL the LLM client posts to (vllm → OpenRouter base; azure → /openai/v1). */
  baseUrl: string;
  /** API key read from the entry's env var. */
  apiKey: string;
  /** Concrete model id sent in the request body (vllm `model` / azure `deployment`). */
  model: string;
  /** Transport shape: vllm → "openrouter" (chat/completions), azure → "azure-responses". */
  mode: ModelEndpointMode;
}

/**
 * Resolve a `python/models.json` KEY (e.g. `qwen3-32b`) to its concrete
 * connection details. Returns `null` when the key has no registry entry — the
 * caller should fail that agent loudly rather than guess an endpoint.
 *
 *   - vllm backend (the OpenRouter path):
 *       { baseUrl: env[entry.base_url_env], apiKey: env[entry.api_key_env],
 *         model: entry.model, mode: "openrouter" }
 *   - azure backend:
 *       { baseUrl: env.AZURE_OPENAI_BASE_URL ?? <default /openai/v1>,
 *         apiKey: env[entry.api_key_env ?? "AZURE_OPENAI_API_KEY"],
 *         model: entry.deployment, mode: "azure-responses" }
 */
export function resolveModelEndpoint(
  modelKey: string,
  opts?: { env?: NodeJS.ProcessEnv; modelsPath?: string },
): ResolvedModelEndpoint | null {
  const env = opts?.env ?? process.env;
  const modelsPath = opts?.modelsPath ?? DEFAULT_MODELS_PATH;
  const registry = loadRegistry(env, modelsPath);
  const entry = registry[modelKey];
  if (!entry) return null;
  if (entry.backend === "vllm") {
    const baseUrl = (entry.base_url_env ? env[entry.base_url_env] : entry.base_url) ?? "";
    const apiKey = entry.api_key_env ? (env[entry.api_key_env] ?? "") : "";
    return { baseUrl, apiKey, model: entry.model, mode: "openrouter" };
  }
  // azure backend — Responses API shape.
  const baseUrl =
    env.AZURE_OPENAI_BASE_URL ?? "https://iu-bhds-nlp-project.services.ai.azure.com/openai/v1";
  const apiKey = env[entry.api_key_env ?? "AZURE_OPENAI_API_KEY"] ?? "";
  return { baseUrl, apiKey, model: entry.deployment, mode: "azure-responses" };
}
