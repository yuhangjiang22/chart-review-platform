// NewSessionDialog — modal for starting a new session.
//
// Single end-to-end flow: name → cohort → agent config → submit.
// Submit creates the session manifest (cohort + agent config) only — it
// does NOT start a run. The reviewer lands in TRY, reviews the rubric +
// cohort, and clicks Run when ready.
//
// If the iter-start fails after session creation succeeds, the session
// is left in place (no iters) and the dialog shows an error; the user
// can retry the iter via "Run again" later without re-creating the
// session.

import { useState, useEffect } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { authFetch } from "../../auth";
import { cn } from "@/lib/utils";
import { AgentConfigPanel, type AgentSpecForm } from "../PilotsTab/AgentConfigPanel";
import { useDeepagentsModels } from "../../useDeepagentsModels";

interface NewSessionDialogProps {
  open: boolean;
  onClose: () => void;
  taskId: string;
  /** Called after a successful session+iter creation. Parent should refetch
   *  the session list and switch the active session to the new id. */
  onCreated: (sessionId: string) => void;
}

const DEFAULT_AGENT_SPECS: AgentSpecForm[] = [
  { id: "agent_1", search_mode_preset: "smart-search", interpretation_preset: "default" },
];

function specsToApi(specs: AgentSpecForm[]): Array<Record<string, unknown>> {
  return specs.map((s) => {
    const out: Record<string, unknown> = { id: s.id };
    if (s.search_mode_preset) out.search_mode_preset = s.search_mode_preset;
    if (s.interpretation_preset) out.interpretation_preset = s.interpretation_preset;
    if (s.role_prompt) out.role_prompt = s.role_prompt;
    if (s.model) out.model = s.model; // registry key; undefined → sidecar default
    return out;
  });
}

interface PackageItem {
  package_id: string;
  name: string;
  description?: string;
  agent_specs?: AgentSpecForm[];
  calibration_summary?: {
    macro_f1?: number;
    tuple_kappa?: number;
    overall_match_rate?: number;
    [k: string]: unknown;
  } | null;
}

/** A prior batch run for this task — listed by GET /api/runs?task_id=…
 *  so a session can be created by IMPORTING it (e.g. a headless
 *  deploy-runner run) instead of configuring a cohort to run. */
interface RunItem {
  run_id: string;
  label?: string;
  state: string;
  started_at: string;
  n_patients: number;
  n_complete: number;
  n_error: number;
}

function runDropdownLabel(r: RunItem): string {
  const when = (r.started_at || "").replace("T", " ").slice(0, 16);
  const tag = r.label ? `${r.label} · ` : "";
  return `${tag}${r.n_complete}/${r.n_patients} patients · ${r.state} · ${when}`;
}

/** Compose a one-line "(F1 0.78 · 2 agents)" annotation for the
 *  package picker dropdown, when calibration evidence is available. */
function packageDropdownAnnotation(pkg: PackageItem): string {
  const parts: string[] = [];
  const cs = pkg.calibration_summary;
  if (typeof cs?.macro_f1 === "number") {
    parts.push(`F1 ${cs.macro_f1.toFixed(2)}`);
  } else if (typeof cs?.overall_match_rate === "number") {
    parts.push(`match ${(cs.overall_match_rate * 100).toFixed(0)}%`);
  }
  if (pkg.agent_specs && pkg.agent_specs.length > 0) {
    parts.push(`${pkg.agent_specs.length} agent${pkg.agent_specs.length === 1 ? "" : "s"}`);
  }
  return parts.length > 0 ? ` (${parts.join(" · ")})` : "";
}

export function NewSessionDialog({
  open, onClose, taskId, onCreated,
}: NewSessionDialogProps) {
  const { noModels } = useDeepagentsModels();
  // Two ways to start a session: configure a cohort+agent to RUN, or IMPORT
  // an existing run (its cohort+agent are adopted and it's attached as
  // iter_001, ready to validate — no agent work re-runs).
  const [mode, setMode] = useState<"run" | "import">("run");
  const [availableRuns, setAvailableRuns] = useState<RunItem[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string>("");
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  // Patient list loaded INDEPENDENTLY of any active session — the previous
  // implementation chained through iterDetail.patient_status which was
  // circular ("need a session to start a session"). Source of truth:
  //   /api/patients (the workspace-wide corpus).
  const [availablePatientIds, setAvailablePatientIds] = useState<string[]>([]);
  const [patientsLoading, setPatientsLoading] = useState(false);
  // Optional "start from package" — when selected, the package's
  // agent_specs pre-fill the agent config and the package gets
  // applied to the live rubric BEFORE the session is created.
  const [availablePackages, setAvailablePackages] = useState<PackageItem[]>([]);
  const [selectedPackageId, setSelectedPackageId] = useState<string>("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [agentSpecs, setAgentSpecs] = useState<AgentSpecForm[]>(DEFAULT_AGENT_SPECS);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setName(""); setNotes(""); setSelected(new Set());
      setAgentSpecs(DEFAULT_AGENT_SPECS);
      setSelectedPackageId("");
      setMode("run"); setSelectedRunId("");
      setSubmitting(false); setError(null);
    }
  }, [open]);

  // Load prior runs for this task so the user can import one.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    authFetch(`/api/runs?task_id=${encodeURIComponent(taskId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: RunItem[] | { runs?: RunItem[] } | null) => {
        if (cancelled || !d) return;
        const runs = Array.isArray(d) ? d : (d.runs ?? []);
        // newest first; the API already sorts, but be defensive
        setAvailableRuns([...runs].sort((a, b) => (a.started_at < b.started_at ? 1 : -1)));
      })
      .catch(() => { /* swallow — import is optional */ });
    return () => { cancelled = true; };
  }, [open, taskId]);

  // Load available packages when the dialog opens so the user can
  // choose to start from one.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    authFetch(`/api/packages/${encodeURIComponent(taskId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { packages?: PackageItem[] } | null) => {
        if (cancelled || !d?.packages) return;
        setAvailablePackages(d.packages);
      })
      .catch(() => { /* swallow */ });
    return () => { cancelled = true; };
  }, [open, taskId]);

  // When the user picks a package, pre-fill the agent_specs from it.
  // They can still edit; the package is "starting point," not a lock.
  useEffect(() => {
    if (!selectedPackageId) return;
    const pkg = availablePackages.find((p) => p.package_id === selectedPackageId);
    if (pkg?.agent_specs && pkg.agent_specs.length > 0) {
      setAgentSpecs(pkg.agent_specs);
    }
  }, [selectedPackageId, availablePackages]);

  // Load the patient list on dialog open from the workspace-wide corpus.
  // (concur has no cohort-sampling service — the curated-dev-cohort source
  // was a v2 feature with no server backing here, so it's not consulted.)
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPatientsLoading(true);
    (async () => {
      let ids: string[] = [];
      try {
        const r = await authFetch("/api/patients");
        if (r.ok) {
          const list = await r.json() as Array<{ patient_id: string }>;
          ids = Array.isArray(list) ? list.map((p) => p.patient_id) : [];
        }
      } catch { /* leave empty */ }
      if (!cancelled) {
        setAvailablePatientIds(ids);
        setPatientsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, taskId]);

  function togglePatient(pid: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(pid)) next.delete(pid);
      else next.add(pid);
      return next;
    });
  }
  function selectAll() { setSelected(new Set(availablePatientIds)); }
  function selectNone() { setSelected(new Set()); }

  async function submit() {
    if (submitting) return;
    if (!name.trim()) { setError("name is required"); return; }

    // ── Import path: create the session FROM an existing run ────────────
    if (mode === "import") {
      if (!selectedRunId) { setError("pick a run to import"); return; }
      setSubmitting(true); setError(null);
      try {
        const r = await authFetch(`/api/sessions/${encodeURIComponent(taskId)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: name.trim(),
            notes: notes.trim() || undefined,
            import_run_id: selectedRunId,
          }),
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          setError(body?.error ?? `import failed: HTTP ${r.status}`);
          return;
        }
        const body = await r.json() as { session: { session_id: string } };
        onCreated(body.session.session_id);
        onClose();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setSubmitting(false);
      }
      return;
    }

    if (selected.size === 0) { setError("pick at least one patient"); return; }
    if (agentSpecs.length === 0) { setError("at least one agent is required"); return; }

    setSubmitting(true); setError(null);
    const patientIds = [...selected];
    const apiSpecs = specsToApi(agentSpecs);

    try {
      // 0. If starting from a package, apply it to the live rubric FIRST.
      // The session manifest created next will then snapshot the post-apply
      // skill SHA, and the first iter will run on the package's rubric.
      if (selectedPackageId) {
        const ra = await authFetch(
          `/api/packages/${encodeURIComponent(taskId)}/${encodeURIComponent(selectedPackageId)}/apply`,
          { method: "POST" },
        );
        if (!ra.ok) {
          const body = await ra.json().catch(() => ({}));
          setError(`apply package failed: ${body?.error ?? `HTTP ${ra.status}`}`);
          return;
        }
      }

      // 1. Create session manifest.
      const r1 = await authFetch(`/api/sessions/${encodeURIComponent(taskId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          patient_ids: patientIds,
          notes: notes.trim() || undefined,
          agent_specs: apiSpecs,
        }),
      });
      if (!r1.ok) {
        const body = await r1.json().catch(() => ({}));
        setError(body?.error ?? `session create failed: HTTP ${r1.status}`);
        return;
      }
      const sessionBody = await r1.json() as { session: { session_id: string } };
      const sessionId = sessionBody.session.session_id;

      // Session created. Do NOT auto-start a run — the reviewer reviews the
      // rubric + cohort in TRY and clicks Run when ready.
      onCreated(sessionId);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-[760px] max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Start a new session</DialogTitle>
          <DialogDescription>
            A session locks a cohort + agent config. After you create it you'll land in TRY,
            where you can review the rubric and click Run to start the first iter.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 pt-2">
          {/* Mode toggle: configure a cohort to RUN, or IMPORT an existing
              run (e.g. a headless deploy-runner run) for validation. */}
          <div className="inline-flex rounded-md border border-border p-0.5 text-[11.5px]">
            <button
              type="button"
              onClick={() => { setMode("run"); setError(null); }}
              className={cn(
                "px-3 py-1 rounded",
                mode === "run" ? "bg-[hsl(var(--sage))]/15 text-ink" : "text-muted-foreground hover:text-ink",
              )}
            >
              Configure &amp; run
            </button>
            <button
              type="button"
              onClick={() => { setMode("import"); setError(null); }}
              className={cn(
                "px-3 py-1 rounded",
                mode === "import" ? "bg-[hsl(var(--sage))]/15 text-ink" : "text-muted-foreground hover:text-ink",
              )}
            >
              Import existing run
            </button>
          </div>

          {/* Import mode: pick a prior run; its cohort + agent are adopted. */}
          {mode === "import" && (
            <div>
              <label className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                Run to import
              </label>
              <select
                value={selectedRunId}
                onChange={(e) => setSelectedRunId(e.target.value)}
                className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-[12.5px] focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="">— select a run —</option>
                {availableRuns.map((r) => (
                  <option key={r.run_id} value={r.run_id}>
                    {runDropdownLabel(r)}
                  </option>
                ))}
              </select>
              {availableRuns.length === 0 ? (
                <p className="mt-1 text-[10.5px] text-muted-foreground">
                  No prior runs found for this task. Run one in TRY, or use the deploy-runner.
                </p>
              ) : (
                <p className="mt-1 text-[10.5px] text-muted-foreground">
                  The session adopts this run's cohort + agent and attaches it as iter 1,
                  ready to validate. No agent work is re-run.
                </p>
              )}
            </div>
          )}

          {/* Optional: start from a package — pre-fills agent_specs and
              applies the package's rubric to the live skill before the
              session is created. */}
          {mode === "run" && availablePackages.length > 0 && (
            <div>
              <label className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                Start from package (optional)
              </label>
              <select
                value={selectedPackageId}
                onChange={(e) => setSelectedPackageId(e.target.value)}
                className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-[12.5px] focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="">— start from current live rubric —</option>
                {availablePackages.map((pkg) => (
                  <option key={pkg.package_id} value={pkg.package_id}>
                    {pkg.name}{packageDropdownAnnotation(pkg)}
                  </option>
                ))}
              </select>
              {selectedPackageId && (
                <p className="mt-1 text-[10.5px] text-muted-foreground">
                  The selected package will REPLACE the live references/ before
                  this session's first iter runs.
                </p>
              )}
            </div>
          )}

          {/* Step 1 — name */}
          <div>
            <label className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">1 · Name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. WCM pilot cohort A"
              className="mt-1"
              autoFocus
            />
          </div>

          {/* Step 2 — cohort (run mode only) */}
          {mode === "run" && (
          <div>
            <div className="flex items-baseline justify-between">
              <label className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                2 · Cohort ({patientsLoading ? "loading…" : `${selected.size}/${availablePatientIds.length} selected`})
              </label>
              <div className="flex gap-2 text-[10px]">
                <button type="button" onClick={selectAll} className="text-muted-foreground hover:text-ink underline-offset-2 hover:underline">
                  all
                </button>
                <span className="text-muted-foreground">·</span>
                <button type="button" onClick={selectNone} className="text-muted-foreground hover:text-ink underline-offset-2 hover:underline">
                  none
                </button>
              </div>
            </div>
            <div className="mt-1 max-h-[200px] overflow-y-auto rounded-md border border-border bg-paper/40 p-1">
              {patientsLoading ? (
                <div className="px-2 py-3 text-[11.5px] text-muted-foreground text-center italic">
                  Loading patient list…
                </div>
              ) : availablePatientIds.length === 0 ? (
                <div className="px-2 py-3 text-[11.5px] text-muted-foreground text-center">
                  No patients found in the corpus.
                </div>
              ) : availablePatientIds.map((pid) => (
                <button
                  key={pid}
                  type="button"
                  onClick={() => togglePatient(pid)}
                  className={cn(
                    "w-full text-left flex items-center gap-2 px-2 py-1 rounded text-[11.5px] font-mono",
                    selected.has(pid)
                      ? "bg-[hsl(var(--sage))]/10 text-ink"
                      : "text-muted-foreground hover:bg-paper/60",
                  )}
                >
                  <span className="w-3 inline-block">{selected.has(pid) ? "✓" : ""}</span>
                  <span className="truncate">{pid}</span>
                </button>
              ))}
            </div>
          </div>
          )}

          {/* Step 3 — agent config (run mode only) */}
          {mode === "run" && (
          <div>
            <label className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
              3 · Agents ({agentSpecs.length})
            </label>
            <div className="mt-1">
              <AgentConfigPanel value={agentSpecs} onChange={setAgentSpecs} />
            </div>
          </div>
          )}

          {/* Optional notes */}
          <div>
            <label className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">Notes (optional)</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="What's this session exploring? Hypothesis, baseline, etc."
              rows={2}
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-[12.5px] focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>

          {error && (
            <div className="rounded-md border border-[hsl(var(--oxblood))]/30 bg-[hsl(var(--oxblood))]/5 px-3 py-2 text-[11.5px] text-[hsl(var(--oxblood))]">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" size="sm" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            <Button
              size="sm"
              className="gap-1.5"
              onClick={submit}
              disabled={submitting || (mode === "run" && noModels) || (mode === "import" && !selectedRunId)}
            >
              <Plus size={12} />
              {submitting
                ? (mode === "import" ? "Importing…" : "Creating session…")
                : (mode === "import" ? "Import run" : "Create session")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
