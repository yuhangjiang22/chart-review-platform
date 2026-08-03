// Settings — configure the model backend + keys from the UI instead of hand-
// editing .env. Secrets are shown only as a masked hint (…tail) and are never
// returned to the browser; you re-type a key only to change it. Saving writes
// .env on the server and applies live to the next run.
import { useCallback, useEffect, useState } from "react";
import { authFetch } from "../auth";
import { Button } from "@/components/ui/button";

interface Config {
  backend: string;
  azure: { endpoint: string; api_version: string; deployment: string; key: { set: boolean; hint: string | null } };
  vllm: { base_url: string; model: string; key: { set: boolean; hint: string | null } };
  models: { default: string; judge: string; phi: string };
}

const field =
  "w-full rounded-md border border-border bg-paper/60 px-2.5 py-1.5 text-[13px] outline-none focus:border-[hsl(var(--sage))]";
const label = "block text-[11px] uppercase tracking-[0.12em] text-muted-foreground mb-1";

export function SettingsPage() {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [backend, setBackend] = useState("azure");
  const [az, setAz] = useState({ endpoint: "", api_version: "", deployment: "" });
  const [azKey, setAzKey] = useState("");
  const [vl, setVl] = useState({ base_url: "", model: "" });
  const [vlKey, setVlKey] = useState("");
  const [models, setModels] = useState({ default: "", judge: "", phi: "" });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [test, setTest] = useState<{ pending: boolean; text: string | null; ok?: boolean }>({ pending: false, text: null });

  const load = useCallback(async () => {
    const r = await authFetch("/api/system/config");
    if (!r.ok) return;
    const c = (await r.json()) as Config;
    setCfg(c);
    setBackend(c.backend);
    setAz({ endpoint: c.azure.endpoint, api_version: c.azure.api_version, deployment: c.azure.deployment });
    setVl({ base_url: c.vllm.base_url, model: c.vllm.model });
    setModels(c.models);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function save() {
    setSaving(true); setMsg(null);
    try {
      const payload: Record<string, string> = {
        DEEPAGENTS_LLM_BACKEND: backend,
        AZURE_OPENAI_ENDPOINT: az.endpoint,
        AZURE_OPENAI_API_VERSION: az.api_version,
        AZURE_OPENAI_DEPLOYMENT: az.deployment,
        VLLM_BASE_URL: vl.base_url,
        VLLM_MODEL: vl.model,
        CHART_REVIEW_MODEL: models.default,
        CHART_REVIEW_JUDGE_MODEL: models.judge,
        CHART_REVIEW_PHI_MODEL: models.phi,
      };
      if (azKey.trim()) payload.AZURE_OPENAI_API_KEY = azKey.trim();
      if (vlKey.trim()) payload.VLLM_API_KEY = vlKey.trim();
      const r = await authFetch("/api/system/config", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg({ kind: "err", text: j.error ?? j.message ?? `HTTP ${r.status}` }); return; }
      setMsg({ kind: "ok", text: `Saved (${(j.changed ?? []).length} setting(s)). Applied to the next run.` });
      setAzKey(""); setVlKey("");
      await load();
    } finally { setSaving(false); }
  }

  async function runTest() {
    setTest({ pending: true, text: null });
    const r = await authFetch("/api/system/config/test", { method: "POST" });
    const j = await r.json().catch(() => ({}));
    setTest({ pending: false, ok: !!j.ok, text: j.ok ? `✓ ${j.detail}` : `✗ ${j.detail ?? "failed"} (HTTP ${j.status ?? "?"})` });
  }

  if (!cfg) return <div className="p-8 text-[13px] text-muted-foreground">Loading settings…</div>;

  return (
    <div className="mx-auto max-w-[640px] space-y-6 py-4">
      <div>
        <h1 className="font-display text-[24px] tracking-tight" style={{ fontVariationSettings: '"opsz" 24' }}>Settings</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Model backend + keys. 🔒 Keys are stored in <code>.env</code> on the server, shown here only as a masked hint,
          and never sent to the browser or published.
        </p>
      </div>

      <section className="space-y-3 rounded-lg border border-border p-4">
        <div>
          <span className={label}>Model backend</span>
          <div className="flex gap-2">
            {["azure", "vllm"].map((b) => (
              <button key={b} type="button" onClick={() => setBackend(b)}
                className={"rounded-md border px-3 py-1.5 text-[12px] " +
                  (backend === b ? "border-[hsl(var(--sage))] bg-[hsl(var(--sage))]/10 text-foreground"
                                  : "border-border text-muted-foreground hover:bg-paper/50")}>
                {b === "azure" ? "Azure OpenAI" : "vLLM / OpenRouter"}
              </button>
            ))}
          </div>
        </div>

        {backend === "azure" ? (
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2"><span className={label}>Azure endpoint</span>
              <input className={field} value={az.endpoint} placeholder="https://<resource>.openai.azure.com/"
                onChange={(e) => setAz({ ...az, endpoint: e.target.value })} /></div>
            <div><span className={label}>Deployment</span>
              <input className={field} value={az.deployment} placeholder="gpt-4o"
                onChange={(e) => setAz({ ...az, deployment: e.target.value })} /></div>
            <div><span className={label}>API version</span>
              <input className={field} value={az.api_version} placeholder="2024-06-01"
                onChange={(e) => setAz({ ...az, api_version: e.target.value })} /></div>
            <div className="col-span-2"><span className={label}>API key</span>
              <input className={field} type="password" value={azKey}
                placeholder={cfg.azure.key.set ? `${cfg.azure.key.hint} — leave blank to keep` : "not set"}
                onChange={(e) => setAzKey(e.target.value)} /></div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2"><span className={label}>Base URL (OpenAI-compatible /v1)</span>
              <input className={field} value={vl.base_url} placeholder="https://openrouter.ai/api/v1"
                onChange={(e) => setVl({ ...vl, base_url: e.target.value })} /></div>
            <div className="col-span-2"><span className={label}>Model id</span>
              <input className={field} value={vl.model} placeholder="qwen/qwen3-32b"
                onChange={(e) => setVl({ ...vl, model: e.target.value })} /></div>
            <div className="col-span-2"><span className={label}>API key</span>
              <input className={field} type="password" value={vlKey}
                placeholder={cfg.vllm.key.set ? `${cfg.vllm.key.hint} — leave blank to keep` : "not set (use EMPTY for a local vLLM)"}
                onChange={(e) => setVlKey(e.target.value)} /></div>
          </div>
        )}
      </section>

      <section className="space-y-3 rounded-lg border border-border p-4">
        <span className={label}>Model per slot (registry key or provider id)</span>
        <div className="grid grid-cols-3 gap-3">
          <div><span className={label}>Default</span>
            <input className={field} value={models.default} onChange={(e) => setModels({ ...models, default: e.target.value })} /></div>
          <div><span className={label}>Judge / Refine</span>
            <input className={field} value={models.judge} onChange={(e) => setModels({ ...models, judge: e.target.value })} /></div>
          <div><span className={label}>PHI (in-BAA)</span>
            <input className={field} value={models.phi} onChange={(e) => setModels({ ...models, phi: e.target.value })} /></div>
        </div>
      </section>

      <div className="flex items-center gap-3">
        <Button onClick={() => void save()} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
        <Button variant="outline" onClick={() => void runTest()} disabled={test.pending}>
          {test.pending ? "Testing…" : "Test connection"}
        </Button>
        {msg && <span className={"text-[12px] " + (msg.kind === "ok" ? "text-[hsl(var(--sage))]" : "text-[hsl(var(--oxblood))]")}>{msg.text}</span>}
        {test.text && <span className={"text-[12px] " + (test.ok ? "text-[hsl(var(--sage))]" : "text-[hsl(var(--oxblood))]")}>{test.text}</span>}
      </div>
    </div>
  );
}
