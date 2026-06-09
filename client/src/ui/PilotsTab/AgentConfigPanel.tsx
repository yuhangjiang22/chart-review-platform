// AgentConfigPanel — configures agent_specs[] when starting a pilot iteration.
// Each agent's role is composed from two orthogonal axes:
//   • search_mode    — HOW the agent finds evidence (smart-search vs comprehensive)
//   • interpretation — HOW the agent reads what it finds (default vs skeptical)
// "Custom prompt" bypasses both axes via role_prompt (free-form override).
// Fetches presets from GET /api/agent-roles and groups them by axis frontmatter.
//
// Model is per-agent and registry-backed: the available models come from
// GET /api/models (the honest picker source). Each agent gets a <select>
// populated from that registry; unavailable models are greyed/disabled; when
// no model is available the picker is replaced by a config message and the
// parent is signalled (onModelsAvailable) so it can disable session creation.
import { useEffect, useMemo, useState } from "react";
import { authFetch } from "../../auth";
import { useModelRegistry } from "../../useModelRegistry";

export interface AgentSpecForm {
  id: string;
  search_mode_preset?: string;
  interpretation_preset?: string;
  role_prompt?: string;
  /** The model STRING (registry entry's `model`) this agent runs on. Undefined
   *  → the registry default's model string (the picker seeds it on mount). */
  model?: string;
}

type Axis = "search_mode" | "interpretation";

interface RolePreset {
  preset_id: string;
  preset_version: string;
  axis: Axis | null;
}

interface AgentConfigPanelProps {
  value: AgentSpecForm[];
  onChange: (v: AgentSpecForm[]) => void;
  /** Signalled after the model registry loads: true if at least one model is
   *  available for the active provider. The parent gates session creation on
   *  this (a session with no runnable model can't run). */
  onModelsAvailable?: (hasAvailable: boolean) => void;
}

const AXIS_LABEL: Record<Axis, string> = {
  search_mode: "Search mode",
  interpretation: "Interpretation",
};

const AXIS_HINT: Record<Axis, string> = {
  search_mode: "How the agent finds evidence",
  interpretation: "How the agent reads what it finds",
};

const AXIS_DEFAULT: Record<Axis, string> = {
  search_mode: "smart-search",
  interpretation: "default",
};

export function AgentConfigPanel({ value, onChange, onModelsAvailable }: AgentConfigPanelProps) {
  const [presets, setPresets] = useState<RolePreset[]>([]);

  const {
    models, defaultModel, activeProvider, loaded, availableModels, noModels,
  } = useModelRegistry();

  useEffect(() => {
    authFetch("/api/agent-roles")
      .then((r) => (r.ok ? r.json() : { presets: [] }))
      .then((d) => setPresets(Array.isArray(d.presets) ? d.presets : []))
      .catch(() => setPresets([]));
  }, []);

  // Signal the parent whether any model is runnable, so it can gate session
  // creation. Fire only after the registry resolves to avoid a false "ok"
  // flash during loading.
  useEffect(() => {
    if (loaded) onModelsAvailable?.(availableModels.length > 0);
  }, [loaded, availableModels.length, onModelsAvailable]);

  // Seed any spec missing a model with the registry default's model string, so
  // a fresh agent card isn't blank. Runs once the default resolves.
  useEffect(() => {
    if (!defaultModel) return;
    if (value.some((s) => s.model == null)) {
      onChange(value.map((s) => (s.model == null ? { ...s, model: defaultModel } : s)));
    }
  }, [defaultModel, value, onChange]);

  const presetsByAxis = useMemo(() => {
    const out: Record<Axis, RolePreset[]> = { search_mode: [], interpretation: [] };
    for (const p of presets) {
      if (p.axis === "search_mode" || p.axis === "interpretation") out[p.axis].push(p);
    }
    return out;
  }, [presets]);

  const count = value.length;

  function updateSpec(index: number, patch: Partial<AgentSpecForm>) {
    onChange(value.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }

  function setAxisPreset(index: number, axis: Axis, presetId: string) {
    const key = axis === "search_mode" ? "search_mode_preset" : "interpretation_preset";
    updateSpec(index, { [key]: presetId, role_prompt: undefined });
  }

  function enableCustom(index: number) {
    updateSpec(index, {
      search_mode_preset: undefined,
      interpretation_preset: undefined,
      role_prompt: "",
    });
  }

  function disableCustom(index: number) {
    updateSpec(index, {
      role_prompt: undefined,
      search_mode_preset: AXIS_DEFAULT.search_mode,
      interpretation_preset: AXIS_DEFAULT.interpretation,
    });
  }

  function removeSpec(index: number) {
    if (value.length <= 1) return;
    onChange(value.filter((_, i) => i !== index));
  }

  function addSpec() {
    const n = value.length + 1;
    onChange([
      ...value,
      {
        id: `agent_${n}`,
        search_mode_preset: AXIS_DEFAULT.search_mode,
        interpretation_preset: AXIS_DEFAULT.interpretation,
      },
    ]);
  }

  return (
    <div className="space-y-3">
      <div>
        <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground mb-1">
          Agents (N = {count})
        </div>
        <p className="text-[11.5px] text-muted-foreground">
          {count === 1
            ? "Single-agent mode — no disagreement adjudication."
            : `Dual-agent mode (N=${count}) — each patient is reviewed by ${count} independent agents. Disagreements trigger adjudication.`}
        </p>
        <p className="mt-1 text-[11.5px] text-muted-foreground">
          Role composes two axes:{" "}
          <span className="font-mono">search_mode</span> ×{" "}
          <span className="font-mono">interpretation</span>.
        </p>
        {noModels && (
          <div className="mt-2 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-1.5 text-[11.5px] text-destructive">
            No models configured for the active provider (
            <span className="font-mono">{activeProvider}</span>). Add{" "}
            <span className="font-mono">config/models.json</span> or set the
            provider's API key (
            <span className="font-mono">AZURE_OPENAI_API_KEY</span> for codex /{" "}
            <span className="font-mono">ANTHROPIC_API_KEY</span> for claude).
          </div>
        )}
      </div>

      <div className="space-y-2">
        {value.map((spec, i) => {
          const isCustom = spec.role_prompt != null;
          return (
            <div
              key={spec.id}
              className="rounded-md border border-border bg-card px-3 py-2 space-y-2"
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-[12px] text-ink min-w-[72px]">{spec.id}</span>
                <button
                  type="button"
                  onClick={() => (isCustom ? disableCustom(i) : enableCustom(i))}
                  className="text-[11px] text-muted-foreground hover:text-ink underline-offset-2 hover:underline"
                >
                  {isCustom ? "use presets" : "use custom prompt"}
                </button>
                <span className="flex-1" />
                <button
                  type="button"
                  disabled={value.length <= 1}
                  onClick={() => removeSpec(i)}
                  className="text-[11px] text-muted-foreground hover:text-destructive disabled:opacity-30 disabled:cursor-not-allowed px-1"
                  aria-label={`Remove ${spec.id}`}
                >
                  remove
                </button>
              </div>

              {isCustom ? (
                <textarea
                  value={spec.role_prompt ?? ""}
                  onChange={(e) => updateSpec(i, { role_prompt: e.target.value })}
                  placeholder="Enter custom role prompt — bypasses both axes…"
                  rows={3}
                  className="w-full rounded-md border border-border px-2 py-1 text-[12px] font-mono resize-y bg-background"
                />
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  {(["search_mode", "interpretation"] as const).map((axis) => {
                    const fieldKey =
                      axis === "search_mode" ? "search_mode_preset" : "interpretation_preset";
                    const current = spec[fieldKey] ?? AXIS_DEFAULT[axis];
                    const options = presetsByAxis[axis];
                    return (
                      <label key={axis} className="flex flex-col gap-1">
                        <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                          {AXIS_LABEL[axis]}
                          <span className="ml-1 normal-case tracking-normal text-muted-foreground/70">
                            — {AXIS_HINT[axis]}
                          </span>
                        </span>
                        <select
                          value={current}
                          onChange={(e) => setAxisPreset(i, axis, e.target.value)}
                          className="rounded-md border border-border px-2 py-1 text-[12px] bg-background"
                        >
                          {options.length === 0 && (
                            <option value="" disabled>
                              (no presets found for axis)
                            </option>
                          )}
                          {options.map((p) => (
                            <option key={p.preset_id} value={p.preset_id}>
                              {p.preset_id} ({p.preset_version})
                            </option>
                          ))}
                        </select>
                      </label>
                    );
                  })}
                </div>
              )}

              <label className="flex flex-col gap-1">
                <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                  Model
                  <span className="ml-1 normal-case tracking-normal text-muted-foreground/70">
                    — which model this agent runs on
                  </span>
                </span>
                <select
                  value={spec.model ?? defaultModel ?? ""}
                  onChange={(e) => updateSpec(i, { model: e.target.value })}
                  disabled={models.length === 0}
                  className="rounded-md border border-border px-2 py-1 text-[12px] font-mono bg-background disabled:opacity-50"
                  aria-label={`Model for ${spec.id}`}
                >
                  {models.length === 0 && (
                    <option value="">(no models configured)</option>
                  )}
                  {models.map((m) => (
                    <option key={m.id} value={m.model} disabled={!m.available}>
                      {m.label}{m.available ? "" : " — (backend not active)"}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          );
        })}
      </div>

      <button
        type="button"
        onClick={addSpec}
        className="text-[11.5px] text-muted-foreground hover:text-ink underline-offset-2 hover:underline"
      >
        + add agent
      </button>
    </div>
  );
}
