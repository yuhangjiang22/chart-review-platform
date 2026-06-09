// server/lib/model-registry.ts
//
// TypeScript reader for the per-deployment model registry
// (config/models.json, gitignored; config/models.example.json is the
// committed template). Backs the honest model picker (GET /api/models + the
// AgentConfigPanel <select>). v2 is TS-only — there is no Python parity copy.
//
// PRESENCE-ONLY for secrets: availability is computed by checking whether the
// relevant env var is SET, but the resolved listing NEVER carries api_key_env
// or any secret value — only id/backend/model/label/available.
//
// See docs/superpowers/specs/2026-06-09-per-agent-model-mixing-design.md.

import fs from "node:fs";
import path from "node:path";
import { PLATFORM_ROOT } from "./patients.js";
import { modelFor } from "./model-config.js";
import { readCodexProviderConfig } from "./codex-config.js";

export type Backend = "codex" | "claude";

/** No-secret resolved view of one model entry. */
export interface ResolvedModel {
  id: string;
  backend: Backend;
  model: string;
  label: string;
  available: boolean;
}

export interface ModelRegistryResult {
  models: ResolvedModel[];
  default: string | null;
  active_provider: Backend;
}

/** One raw registry entry as stored in config/models.json. */
interface RegistryEntry {
  backend: Backend;
  model: string;
  label: string;
  api_key_env: string;
  default?: boolean;
}
type Registry = Record<string, RegistryEntry>;

const DEFAULT_MODELS_PATH = path.join(PLATFORM_ROOT, "config", "models.json");

/** One run = one provider. codex unless AGENT_PROVIDER explicitly selects it. */
function activeProvider(): Backend {
  return (process.env.AGENT_PROVIDER ?? "claude").toLowerCase() === "codex"
    ? "codex"
    : "claude";
}

/** A claude entry whose key env is ANTHROPIC_API_KEY is also satisfied by
 *  ANTHROPIC_AUTH_TOKEN (the platform accepts either). */
function keyPresent(apiKeyEnv: string): boolean {
  if (process.env[apiKeyEnv]) return true;
  if (apiKeyEnv === "ANTHROPIC_API_KEY") return !!process.env.ANTHROPIC_AUTH_TOKEN;
  return false;
}

/** Availability: the entry's key env is set AND its backend equals the active
 *  provider (a non-active-backend model can't run this run — it's listed but
 *  unavailable). */
function isAvailable(entry: RegistryEntry, provider: Backend): boolean {
  return keyPresent(entry.api_key_env) && entry.backend === provider;
}

/** Read config/models.json. Returns null if absent or malformed (caller falls
 *  back to env synthesis). Never throws. */
function readRegistryFile(modelsPath: string): Registry | null {
  try {
    if (!fs.existsSync(modelsPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("models.json root must be a JSON object");
    }
    return parsed as Registry;
  } catch (err) {
    console.warn(
      `[model-registry] could not load ${modelsPath} (${(err as Error).message}) — falling back to env synthesis`,
    );
    return null;
  }
}

/** Zero-config: synthesize a single entry for the active provider. */
function synthesize(provider: Backend): ModelRegistryResult {
  if (provider === "codex") {
    const codex = readCodexProviderConfig();
    const activeModel = codex.active_model ?? null;
    const available = !!process.env.AZURE_OPENAI_API_KEY && !!activeModel;
    const entry: ResolvedModel = {
      id: activeModel ?? "codex-default",
      backend: "codex",
      model: activeModel ?? "",
      label: activeModel ? `${activeModel} (codex)` : "codex (no active model)",
      available,
    };
    return { models: [entry], default: available ? entry.id : null, active_provider: "codex" };
  }

  const model = modelFor("default") ?? "";
  const available = !!process.env.ANTHROPIC_API_KEY || !!process.env.ANTHROPIC_AUTH_TOKEN;
  const entry: ResolvedModel = {
    id: "claude-default",
    backend: "claude",
    model,
    label: model ? `${model} (claude)` : "claude (no model)",
    available,
  };
  return { models: [entry], default: available ? entry.id : null, active_provider: "claude" };
}

/** Load the resolved model registry. Pass `opts.path` to point at a fixture
 *  file in tests; defaults to config/models.json under PLATFORM_ROOT. */
export function loadModelRegistry(opts?: { path?: string }): ModelRegistryResult {
  const provider = activeProvider();
  const modelsPath = opts?.path ?? DEFAULT_MODELS_PATH;
  const registry = readRegistryFile(modelsPath);

  // File absent or malformed → env synthesis for the active provider.
  if (registry === null) return synthesize(provider);

  const models: ResolvedModel[] = [];
  let firstAvailable: string | null = null;
  let markedDefault: string | null = null;
  for (const [id, entry] of Object.entries(registry)) {
    const available = isAvailable(entry, provider);
    models.push({ id, backend: entry.backend, model: entry.model, label: entry.label, available });
    if (available) {
      if (firstAvailable === null) firstAvailable = id;
      if (entry.default && markedDefault === null) markedDefault = id;
    }
  }

  // Prefer an available entry flagged default:true; else the first available;
  // else null.
  const def = markedDefault ?? firstAvailable;
  return { models, default: def, active_provider: provider };
}
