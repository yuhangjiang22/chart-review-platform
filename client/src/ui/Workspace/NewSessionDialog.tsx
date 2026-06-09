// NewSessionDialog — modal for starting a new session.
//
// Flow: name → cohort → agent config → submit. Submit creates the session
// manifest ONLY — it does NOT start a run. The methodologist reviews the
// locked cohort/agent/model config and explicitly starts the first iter from
// the TRY phase ("Start iter", POST /api/pilots/:taskId), so no agent tokens
// are spent until they choose to run.

import { useState, useEffect } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { authFetch } from "../../auth";
import { withSession } from "../../active-session";
import { cn } from "@/lib/utils";
import { AgentConfigPanel, type AgentSpecForm } from "../PilotsTab/AgentConfigPanel";

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
  { id: "agent_2", search_mode_preset: "smart-search", interpretation_preset: "skeptical" },
];

function specsToApi(specs: AgentSpecForm[]): Array<Record<string, unknown>> {
  return specs.map((s) => {
    const out: Record<string, unknown> = { id: s.id };
    if (s.search_mode_preset) out.search_mode_preset = s.search_mode_preset;
    if (s.interpretation_preset) out.interpretation_preset = s.interpretation_preset;
    if (s.role_prompt) out.role_prompt = s.role_prompt;
    if (s.model) out.model = s.model;
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
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  // Patient list loaded INDEPENDENTLY of any active session — the previous
  // implementation chained through iterDetail.patient_status which was
  // circular ("need a session to start a session"). Source of truth:
  //   1. cohort-sampling.dev_patient_ids if the task has a curated cohort
  //   2. /api/patients (the workspace-wide corpus) as fallback
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
  // Signalled by AgentConfigPanel once the model registry loads. A session
  // with no runnable model can't run, so submit is gated on this. Starts
  // null ("not yet known") so we don't block before the registry resolves.
  const [modelsAvailable, setModelsAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    if (!open) {
      setName(""); setNotes(""); setSelected(new Set());
      setAgentSpecs(DEFAULT_AGENT_SPECS);
      setSelectedPackageId("");
      setSubmitting(false); setError(null);
      setModelsAvailable(null);
    }
  }, [open]);

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

  // Load the patient list on dialog open. Prefer the task's curated dev
  // cohort (cohort-sampling.dev_patient_ids); fall back to the whole
  // corpus if no sampling has been configured.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPatientsLoading(true);
    (async () => {
      let ids: string[] = [];
      try {
        const r = await authFetch(`/api/cohort-sampling/${encodeURIComponent(taskId)}`);
        if (r.ok) {
          const sampling = await r.json() as { dev_patient_ids?: string[] };
          if (Array.isArray(sampling?.dev_patient_ids) && sampling.dev_patient_ids.length > 0) {
            ids = sampling.dev_patient_ids;
          }
        }
      } catch { /* fall through */ }
      if (ids.length === 0) {
        try {
          const r = await authFetch(withSession("/api/patients"));
          if (r.ok) {
            const list = await r.json() as Array<{ patient_id: string }>;
            ids = Array.isArray(list) ? list.map((p) => p.patient_id) : [];
          }
        } catch { /* leave empty */ }
      }
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
    if (selected.size === 0) { setError("pick at least one patient"); return; }
    if (agentSpecs.length === 0) { setError("at least one agent is required"); return; }
    if (modelsAvailable === false) {
      setError("no model is available for the active provider — configure config/models.json or set the provider's API key before starting a session");
      return;
    }

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

      // Session created — do NOT auto-start a run. The methodologist reviews
      // the cohort / agent / model config and then explicitly starts the first
      // iter from the TRY phase ("Start iter"), so no tokens are spent until
      // they choose to run.
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
            A session locks a cohort + agent config. Creating it does NOT start a run —
            go to TRY and click “Start iter” when you’re ready. All iters in this session
            reuse the same cohort.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 pt-2">
          {/* Optional: start from a package — pre-fills agent_specs and
              applies the package's rubric to the live skill before the
              session is created. */}
          {availablePackages.length > 0 && (
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

          {/* Step 2 — cohort */}
          <div>
            <div className="flex items-baseline justify-between">
              <label className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                2 · Cohort ({selected.size}/{availablePatientIds.length} selected)
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

          {/* Step 3 — agent config */}
          <div>
            <label className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
              3 · Agents ({agentSpecs.length})
            </label>
            <div className="mt-1">
              <AgentConfigPanel
                value={agentSpecs}
                onChange={setAgentSpecs}
                onModelsAvailable={setModelsAvailable}
              />
            </div>
          </div>

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
              disabled={submitting || modelsAvailable === false}
              title={modelsAvailable === false
                ? "No model is available for the active provider — configure a model before starting a session"
                : undefined}
            >
              <Plus size={12} />
              {submitting ? "Creating session + starting iter…" : "Start session"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
