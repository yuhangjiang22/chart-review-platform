// app/server/agent-specs.ts
import fs from "fs";
import path from "path";
import { PLATFORM_ROOT } from "@chart-review/patients";

/**
 * Two orthogonal axes shape an agent's role framing:
 *   - search_mode    — HOW the agent finds evidence (e.g. smart-search vs comprehensive)
 *   - interpretation — HOW the agent reads what it finds (e.g. default vs skeptical)
 *
 * Every preset declares its axis via `axis:` frontmatter. AgentSpec exposes a
 * named slot per axis. The legacy `role_preset` slot is kept for back-compat
 * and routes to whichever slot the preset's axis declares.
 *
 * resolveRolePrompt always emits a complete two-axis framing — unfilled axes
 * fall back to DEFAULT_PRESET_BY_AXIS so every agent has full guidance.
 */

export const AXIS_SEARCH_MODE = "search_mode" as const;
export const AXIS_INTERPRETATION = "interpretation" as const;
export type Axis = typeof AXIS_SEARCH_MODE | typeof AXIS_INTERPRETATION;

const DEFAULT_PRESET_BY_AXIS: Record<Axis, string> = {
  search_mode: "smart-search",
  interpretation: "default",
};

export interface AgentSpec {
  /** Unique identifier within the pilot, e.g., "agent_1". */
  id: string;
  /** Search-mode axis preset (must have `axis: search_mode` in its frontmatter). */
  search_mode_preset?: string;
  /** Interpretation-attitude axis preset (must have `axis: interpretation`). */
  interpretation_preset?: string;
  /** Back-compat: single preset slot. Routed at resolve time to the axis its
   *  frontmatter declares. Cannot collide with a named slot of the same axis. */
  role_preset?: string;
  /** Recorded for reproducibility. Documentary; not consumed by validation. */
  role_version?: string;
  /** Free-form role prompt — overrides preset-based composition. Flagged
   *  "experimental" in cross-pilot analysis. */
  role_prompt?: string;
  /** Optional model override. Falls back to env CHART_REVIEW_MODEL or SDK default. */
  model?: string;
}

export interface RolePreset {
  preset_id: string;
  preset_version: string;
  /** Which axis this preset fills. Undefined for legacy presets without axis frontmatter. */
  axis?: Axis;
  role_prompt: string;
  file_path: string;
}

function rolesRoot(): string {
  return path.join(PLATFORM_ROOT, "prompts", "agent_roles");
}

function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, body: text.trim() };
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { meta, body: m[2].trim() };
}

function parseAxis(presetId: string, raw: string | undefined): Axis | undefined {
  if (raw === undefined) return undefined;
  if (raw === AXIS_SEARCH_MODE || raw === AXIS_INTERPRETATION) return raw;
  throw new Error(
    `preset '${presetId}' has invalid axis '${raw}'; expected 'search_mode' or 'interpretation'`,
  );
}

export function loadRolePreset(presetId: string): RolePreset {
  if (!/^[a-z0-9_-]+$/.test(presetId)) {
    throw new Error(`invalid preset id: '${presetId}'`);
  }
  const fp = path.join(rolesRoot(), `${presetId}.md`);
  if (!fs.existsSync(fp)) {
    throw new Error(`role preset '${presetId}' not found at ${fp}`);
  }
  const text = fs.readFileSync(fp, "utf8");
  const { meta, body } = parseFrontmatter(text);
  if (meta.preset_id !== presetId) {
    throw new Error(`preset_id mismatch in ${fp}: file says '${meta.preset_id}', expected '${presetId}'`);
  }
  return {
    preset_id: meta.preset_id,
    preset_version: meta.preset_version ?? "v1",
    axis: parseAxis(presetId, meta.axis),
    role_prompt: body,
    file_path: fp,
  };
}

export function listAvailablePresets(): RolePreset[] {
  const dir = rolesRoot();
  if (!fs.existsSync(dir)) return [];
  const out: RolePreset[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".md") || f === "README.md") continue;
    const id = f.replace(/\.md$/, "");
    try { out.push(loadRolePreset(id)); } catch { /* skip malformed */ }
  }
  return out.sort((a, b) => a.preset_id.localeCompare(b.preset_id));
}

export function defaultAgentSpecs(): AgentSpec[] {
  return [
    {
      id: "agent_1",
      search_mode_preset: "smart-search",
      interpretation_preset: "default",
    },
    {
      id: "agent_2",
      search_mode_preset: "smart-search",
      interpretation_preset: "skeptical",
    },
  ];
}

/**
 * Pre-baked spec for a search-recall benchmark pilot: same interpretation,
 * different search modes. The disagreement signal between these two agents
 * is exactly the search-recall gap.
 */
export function searchRecallBenchmarkSpecs(): AgentSpec[] {
  return [
    {
      id: "agent_smart",
      search_mode_preset: "smart-search",
      interpretation_preset: "default",
    },
    {
      id: "agent_comprehensive",
      search_mode_preset: "comprehensive",
      interpretation_preset: "default",
    },
  ];
}

export function validateAgentSpec(specs: AgentSpec[]): void {
  if (!Array.isArray(specs) || specs.length === 0) {
    throw new Error("agent_specs must contain at least one agent");
  }
  const seen = new Set<string>();
  for (const s of specs) {
    if (!s.id || typeof s.id !== "string") {
      throw new Error(`agent spec missing id: ${JSON.stringify(s)}`);
    }
    if (seen.has(s.id)) {
      throw new Error(`duplicate agent id: ${s.id}`);
    }
    seen.add(s.id);

    const hasAnyPreset = !!(
      s.role_preset || s.search_mode_preset || s.interpretation_preset
    );
    if (!hasAnyPreset && !s.role_prompt) {
      throw new Error(
        `agent ${s.id} must have a preset (role_preset / search_mode_preset / interpretation_preset) or a role_prompt`,
      );
    }

    if (s.search_mode_preset) {
      const p = loadRolePreset(s.search_mode_preset);
      if (p.axis !== AXIS_SEARCH_MODE) {
        throw new Error(
          `agent ${s.id}: search_mode_preset '${s.search_mode_preset}' has axis '${p.axis ?? "(none)"}', expected 'search_mode'`,
        );
      }
    }
    if (s.interpretation_preset) {
      const p = loadRolePreset(s.interpretation_preset);
      if (p.axis !== AXIS_INTERPRETATION) {
        throw new Error(
          `agent ${s.id}: interpretation_preset '${s.interpretation_preset}' has axis '${p.axis ?? "(none)"}', expected 'interpretation'`,
        );
      }
    }

    if (s.role_preset) {
      const p = loadRolePreset(s.role_preset);
      if (p.axis === AXIS_SEARCH_MODE && s.search_mode_preset) {
        throw new Error(
          `agent ${s.id}: role_preset '${s.role_preset}' (axis search_mode) conflicts with search_mode_preset '${s.search_mode_preset}'`,
        );
      }
      if (p.axis === AXIS_INTERPRETATION && s.interpretation_preset) {
        throw new Error(
          `agent ${s.id}: role_preset '${s.role_preset}' (axis interpretation) conflicts with interpretation_preset '${s.interpretation_preset}'`,
        );
      }
    }

    if (s.model !== undefined && typeof s.model !== "string") {
      throw new Error(`agent ${s.id}: model must be a string`);
    }
  }
}

/** Resolve an AgentSpec to the literal role_prompt string used at runtime.
 *  Composes BOTH axes (search_mode + interpretation). Unfilled axes fall back
 *  to DEFAULT_PRESET_BY_AXIS so every agent gets complete two-axis guidance. */
export function resolveRolePrompt(spec: AgentSpec): string {
  if (spec.role_prompt) return spec.role_prompt;

  let searchModeId = spec.search_mode_preset;
  let interpretationId = spec.interpretation_preset;
  let legacyAxisless: RolePreset | undefined;

  if (spec.role_preset) {
    const p = loadRolePreset(spec.role_preset);
    if (p.axis === AXIS_SEARCH_MODE && !searchModeId) {
      searchModeId = spec.role_preset;
    } else if (p.axis === AXIS_INTERPRETATION && !interpretationId) {
      interpretationId = spec.role_preset;
    } else if (!p.axis) {
      legacyAxisless = p;
    }
  }

  if (!searchModeId) searchModeId = DEFAULT_PRESET_BY_AXIS.search_mode;
  if (!interpretationId) interpretationId = DEFAULT_PRESET_BY_AXIS.interpretation;

  const search = loadRolePreset(searchModeId);
  const interp = loadRolePreset(interpretationId);

  const sections: string[] = [
    `## Search mode: ${search.preset_id} (${search.preset_version})`,
    search.role_prompt,
    "",
    `## Interpretation: ${interp.preset_id} (${interp.preset_version})`,
    interp.role_prompt,
  ];

  if (legacyAxisless) {
    sections.push(
      "",
      `## Additional framing: ${legacyAxisless.preset_id} (${legacyAxisless.preset_version})`,
      legacyAxisless.role_prompt,
    );
  }

  return sections.join("\n");
}
