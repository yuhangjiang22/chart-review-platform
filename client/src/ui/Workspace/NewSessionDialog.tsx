// NewSessionDialog — modal for starting a new session.
//
// Single end-to-end flow: name → cohort → agent config → submit.
// Submit is atomic from the user's perspective: it creates the session
// manifest AND kicks off the first iter (POST /api/pilots/:taskId with
// session_id) so the methodologist lands in a usable workspace
// immediately.
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
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [agentSpecs, setAgentSpecs] = useState<AgentSpecForm[]>(DEFAULT_AGENT_SPECS);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setName(""); setNotes(""); setSelected(new Set());
      setAgentSpecs(DEFAULT_AGENT_SPECS);
      setSubmitting(false); setError(null);
    }
  }, [open]);

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
          const r = await authFetch("/api/patients");
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

    setSubmitting(true); setError(null);
    const patientIds = [...selected];
    const apiSpecs = specsToApi(agentSpecs);

    try {
      // 1. Create session manifest.
      const r1 = await authFetch(`/api/sessions/${encodeURIComponent(taskId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          patient_ids: patientIds,
          notes: notes.trim() || undefined,
          default_agent_specs: apiSpecs,
        }),
      });
      if (!r1.ok) {
        const body = await r1.json().catch(() => ({}));
        setError(body?.error ?? `session create failed: HTTP ${r1.status}`);
        return;
      }
      const sessionBody = await r1.json() as { session: { session_id: string } };
      const sessionId = sessionBody.session.session_id;

      // 2. Kick off the first iter for this session. Cohort + agents come
      // from the session (strict lock); we only pass session_id + notes.
      const r2 = await authFetch(`/api/pilots/${encodeURIComponent(taskId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          notes: notes.trim() || undefined,
        }),
      });
      if (!r2.ok) {
        const body = await r2.json().catch(() => ({}));
        // Session is created but first iter failed. Surface the error;
        // the methodologist can manually start an iter later.
        setError(
          `Session created (id ${sessionId}) but starting the first iter failed: `
          + (body?.error ?? `HTTP ${r2.status}`)
          + ". The session is usable; click 'Run again' on DECIDE to retry.",
        );
        // Still call onCreated so the parent switches to this session.
        onCreated(sessionId);
        return;
      }
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
            A session locks a cohort + agent config. The first iter starts automatically once
            you submit; subsequent iters in this session reuse the same cohort.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 pt-2">
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
              <AgentConfigPanel value={agentSpecs} onChange={setAgentSpecs} />
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
            <Button size="sm" className="gap-1.5" onClick={submit} disabled={submitting}>
              <Plus size={12} />
              {submitting ? "Creating session + starting iter…" : "Start session"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
