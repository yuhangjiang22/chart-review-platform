// server/lib/model-registry.ts
// TypeScript reader for the model registry (python/models.json). Mirrors the
// Python copy (python/chart_review_deepagents/registry.py) — keep the contract
// in sync (see docs/superpowers/specs/2026-06-06-per-agent-model-mixing-design.md).
// This reader is PRESENCE-ONLY: it checks whether secret env vars are SET to
// compute availability, but never returns their values.
import fs from "node:fs";
import path from "node:path";

const PLATFORM_ROOT = process.env.CHART_REVIEW_PLATFORM_ROOT ?? process.cwd();
const DEFAULT_MODELS_PATH = path.join(PLATFORM_ROOT, "python", "models.json");

interface AzureEntry {
  backend: "azure"; deployment: string;
  endpoint_env?: string; api_key_env?: string; api_version_env?: string; default?: boolean;
}
interface VllmEntry {
  backend: "vllm"; base_url: string; model: string; api_key_env?: string; default?: boolean;
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
    if (fs.existsSync(modelsPath)) return JSON.parse(fs.readFileSync(modelsPath, "utf8")) as Registry;
  } catch { /* malformed → fall through to synthesis */ }
  return synthesize(env);
}

function available(entry: Entry, env: NodeJS.ProcessEnv): boolean {
  if (entry.backend === "azure") {
    const ep = env[entry.endpoint_env ?? "AZURE_OPENAI_ENDPOINT"];
    const key = env[entry.api_key_env ?? "AZURE_OPENAI_API_KEY"];
    return !!ep && !!key;
  }
  return true;
}

function label(entry: Entry): string {
  return entry.backend === "azure" ? `azure · ${entry.deployment}` : `vllm · ${entry.model}`;
}

export function listModels(opts?: { env?: NodeJS.ProcessEnv; modelsPath?: string }): ListModelsResult {
  const env = opts?.env ?? process.env;
  const modelsPath = opts?.modelsPath ?? DEFAULT_MODELS_PATH;
  const registry = loadRegistry(env, modelsPath);
  const models: ModelInfo[] = [];
  let def: string | null = null;
  for (const [id, entry] of Object.entries(registry)) {
    const avail = available(entry, env);
    models.push({ id, backend: entry.backend, label: label(entry), available: avail });
    if (avail && def === null) def = id;
  }
  const marked = Object.entries(registry).find(([, e]) => e.default && available(e, env));
  if (marked) def = marked[0];
  return { models, default: def };
}
