// useDeepagentsModels — shared fetch of GET /api/deepagents/models.
// Returns the model list + availability so the agent-config picker and the
// session-create / run gates all read one source. noModels is true only AFTER
// the fetch resolves with zero available models (so the gate doesn't flash
// during loading).
import { useEffect, useMemo, useState } from "react";
import { authFetch } from "./auth";

export interface ModelInfo { id: string; backend: string; label: string; available: boolean; }

export interface DeepagentsModels {
  models: ModelInfo[];
  defaultModelId: string | null;
  loaded: boolean;
  availableModels: ModelInfo[];
  noModels: boolean;
}

export function useDeepagentsModels(): DeepagentsModels {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [defaultModelId, setDefaultModelId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    authFetch("/api/deepagents/models")
      .then((r) => (r.ok ? r.json() : { models: [], default: null }))
      .then((d) => {
        if (cancelled) return;
        setModels(Array.isArray(d.models) ? d.models : []);
        setDefaultModelId(typeof d.default === "string" ? d.default : null);
      })
      .catch(() => { if (!cancelled) { setModels([]); setDefaultModelId(null); } })
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, []);

  const availableModels = useMemo(() => models.filter((m) => m.available), [models]);
  const noModels = loaded && availableModels.length === 0;
  return { models, defaultModelId, loaded, availableModels, noModels };
}
