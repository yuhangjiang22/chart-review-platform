// useModelRegistry — shared fetch of GET /api/models (the registry-backed,
// honest model picker source). Returns the model list + availability so the
// agent-config picker and the session-create gate read one source.
//
// The route is NOT session-scoped, so no withSession wrapping. Response shape:
//   { models: [{ id, backend, model, label, available }], default: <id|null>,
//     active_provider: "codex" | "claude" }
//
// `noModels` is true only AFTER the fetch resolves with zero AVAILABLE models
// (so the create gate doesn't flash during loading). The registry `default`
// is an entry id; `defaultModel` resolves it to that entry's `model` string —
// the value that flows into agent_spec.model.
import { useEffect, useMemo, useState } from "react";
import { authFetch } from "./auth";

export type Backend = "codex" | "claude";

export interface ModelInfo {
  id: string;
  backend: Backend;
  model: string;
  label: string;
  available: boolean;
}

export interface ModelRegistry {
  models: ModelInfo[];
  /** The registry's default entry id (or null). */
  defaultId: string | null;
  /** The `model` string of the default entry (or null) — what seeds a spec. */
  defaultModel: string | null;
  activeProvider: Backend;
  loaded: boolean;
  availableModels: ModelInfo[];
  /** True only after load resolves with zero available models. */
  noModels: boolean;
}

export function useModelRegistry(): ModelRegistry {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [defaultId, setDefaultId] = useState<string | null>(null);
  const [activeProvider, setActiveProvider] = useState<Backend>("claude");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    authFetch("/api/models")
      .then((r) => (r.ok ? r.json() : { models: [], default: null, active_provider: "claude" }))
      .then((d) => {
        if (cancelled) return;
        setModels(Array.isArray(d.models) ? d.models : []);
        setDefaultId(typeof d.default === "string" ? d.default : null);
        setActiveProvider(d.active_provider === "codex" ? "codex" : "claude");
      })
      .catch(() => {
        if (!cancelled) { setModels([]); setDefaultId(null); setActiveProvider("claude"); }
      })
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, []);

  const availableModels = useMemo(() => models.filter((m) => m.available), [models]);
  const defaultModel = useMemo(() => {
    const entry = models.find((m) => m.id === defaultId);
    return entry ? entry.model : null;
  }, [models, defaultId]);
  const noModels = loaded && availableModels.length === 0;

  return {
    models, defaultId, defaultModel, activeProvider, loaded, availableModels, noModels,
  };
}
