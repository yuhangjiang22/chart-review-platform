// AgentConfigPanel — configures agent_specs[] when starting a pilot iteration.
// Each agent's role is composed from two orthogonal axes:
//   • search_mode    — HOW the agent finds evidence (smart-search vs comprehensive)
//   • interpretation — HOW the agent reads what it finds (default vs skeptical)
// "Custom prompt" bypasses both axes via role_prompt (free-form override).
// Fetches presets from GET /api/agent-roles and groups them by axis frontmatter.
// Fetches env default model from GET /api/agent-roles/default-model.
import { useEffect, useMemo, useState } from "react";
import { authFetch } from "../../auth";

export interface AgentSpecForm {
  id: string;
  search_mode_preset?: string;
  interpretation_preset?: string;
  role_prompt?: string;
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
}

const QUICK_PICK_MODELS = [
  "anthropic/claude-haiku-4.5",
  "anthropic/claude-sonnet-4-6",
  "openai/gpt-5.2",
  "openai/gpt-4o",
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4-flash",
] as const;

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

export function AgentConfigPanel({ value, onChange }: AgentConfigPanelProps) {
  const [presets, setPresets] = useState<RolePreset[]>([]);
  const [defaultModel, setDefaultModel] = useState<string | null>(null);

  useEffect(() => {
    authFetch("/api/agent-roles")
      .then((r) => (r.ok ? r.json() : { presets: [] }))
      .then((d) => setPresets(Array.isArray(d.presets) ? d.presets : []))
      .catch(() => setPresets([]));
  }, []);

  useEffect(() => {
    authFetch("/api/agent-roles/default-model")
      .then((r) => (r.ok ? r.json() : { default_model: null }))
      .then((d) => setDefaultModel(typeof d.default_model === "string" ? d.default_model : null))
      .catch(() => setDefaultModel(null));
  }, []);

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

  const modelPlaceholder = defaultModel
    ? `(env default: ${defaultModel})`
    : "(env default)";

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

              <div className="flex flex-col gap-1.5">
                <input
                  type="text"
                  value={spec.model ?? ""}
                  onChange={(e) => updateSpec(i, { model: e.target.value || undefined })}
                  placeholder={modelPlaceholder}
                  className="w-full rounded-md border border-border px-2 py-1 text-[12px] font-mono bg-background placeholder:text-muted-foreground/60"
                  aria-label={`Model override for ${spec.id}`}
                />
                <div className="flex flex-wrap gap-1">
                  {QUICK_PICK_MODELS.map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => updateSpec(i, { model: m })}
                      className={[
                        "rounded border px-1.5 py-0.5 text-[10px] font-mono transition-colors",
                        spec.model === m
                          ? "border-foreground/40 bg-foreground/10 text-foreground"
                          : "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground",
                      ].join(" ")}
                    >
                      {m.split("/").pop()}
                    </button>
                  ))}
                  {spec.model && (
                    <button
                      type="button"
                      onClick={() => updateSpec(i, { model: undefined })}
                      className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-destructive transition-colors"
                    >
                      clear
                    </button>
                  )}
                </div>
              </div>
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
