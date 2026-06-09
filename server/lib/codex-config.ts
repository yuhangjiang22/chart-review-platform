// server/lib/codex-config.ts
//
// Shared reader for the Codex CLI's .codex/config.toml. Extracted from
// misc-routes.ts (the /api/diagnostics/api-providers handler) so the model
// registry can resolve the active codex model without duplicating the TOML
// scan. PRESENCE-ONLY for secrets: it reports whether an env_key is set, never
// its value.
//
// Minimal TOML parsing — we only need a few top-level scalar assignments + the
// [model_providers.X] sections. A full toml parser is overkill for a read-only
// view and would pull a dependency we don't otherwise need.

import fs from "node:fs";
import path from "node:path";

export interface CodexProviderConfig {
  config_path: string | null;
  config_present: boolean;
  /** Top-level `model = ...` */
  active_model: string | null;
  /** Top-level `model_provider = ...` */
  active_provider: string | null;
  /** `model_reasoning_effort = ...` */
  reasoning_effort: string | null;
  /** Every [model_providers.X] block found, with its base_url + env_key
   *  + whether that env_key is currently set. */
  available_providers: Array<{
    id: string;
    name?: string;
    base_url?: string;
    wire_api?: string;
    env_key?: string;
    env_key_present?: boolean;
  }>;
  /** CODEX_HOME the platform spawns codex against (project-local override). */
  codex_home: string;
}

export function readCodexProviderConfig(): CodexProviderConfig {
  const codexHome = process.env.CHART_REVIEW_CODEX_HOME
    ?? path.join(process.env.CHART_REVIEW_PLATFORM_ROOT ?? process.cwd(), ".codex");
  const cfgPath = path.join(codexHome, "config.toml");
  const out: CodexProviderConfig = {
    config_path: cfgPath,
    config_present: false,
    active_model: null,
    active_provider: null,
    reasoning_effort: null,
    available_providers: [],
    codex_home: codexHome,
  };
  if (!fs.existsSync(cfgPath)) return out;
  out.config_present = true;
  let raw: string;
  try { raw = fs.readFileSync(cfgPath, "utf8"); }
  catch { return out; }

  // Minimal TOML parsing — we only need three top-level scalar
  // assignments + the [model_providers.X] sections.
  const topModel = /^[ \t]*model[ \t]*=[ \t]*"([^"]+)"/m.exec(raw);
  const topProvider = /^[ \t]*model_provider[ \t]*=[ \t]*"([^"]+)"/m.exec(raw);
  const topEffort = /^[ \t]*model_reasoning_effort[ \t]*=[ \t]*"([^"]+)"/m.exec(raw);
  if (topModel) out.active_model = topModel[1] ?? null;
  if (topProvider) out.active_provider = topProvider[1] ?? null;
  if (topEffort) out.reasoning_effort = topEffort[1] ?? null;

  // Walk [model_providers.X] sections.
  const sectionRe = /\[model_providers\.([A-Za-z0-9_-]+)\]([\s\S]*?)(?=^\[|$(?![\r\n]))/gm;
  let m: RegExpExecArray | null;
  while ((m = sectionRe.exec(raw)) !== null) {
    const id = m[1]!;
    const body = m[2] ?? "";
    const grab = (k: string): string | undefined =>
      new RegExp(`^[ \\t]*${k}[ \\t]*=[ \\t]*"([^"]+)"`, "m").exec(body)?.[1];
    const envKey = grab("env_key");
    out.available_providers.push({
      id,
      name: grab("name"),
      base_url: grab("base_url"),
      wire_api: grab("wire_api"),
      env_key: envKey,
      env_key_present: envKey ? !!process.env[envKey] : undefined,
    });
  }
  return out;
}
