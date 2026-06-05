// NewSessionDialog — modal for starting a new session.
//
// Inputs: name, patient_ids (multi-select from available cohort
// patients), optional notes.
//
// Calls POST /api/sessions/:taskId on submit. The parent (Workspace)
// triggers a session-list refresh and switches the active session to
// the new one on success.

import { useState, useEffect } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { authFetch } from "../../auth";
import { cn } from "@/lib/utils";

interface NewSessionDialogProps {
  open: boolean;
  onClose: () => void;
  taskId: string;
  /** Patient IDs available for selection (cohort sampling output). */
  availablePatientIds: string[];
  /** Called after a successful POST. Parent should refetch + switch active. */
  onCreated: (sessionId: string) => void;
}

export function NewSessionDialog({
  open, onClose, taskId, availablePatientIds, onCreated,
}: NewSessionDialogProps) {
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setName(""); setNotes(""); setSelected(new Set());
      setSubmitting(false); setError(null);
    }
  }, [open]);

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
    setSubmitting(true); setError(null);
    try {
      const r = await authFetch(`/api/sessions/${encodeURIComponent(taskId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          patient_ids: [...selected],
          notes: notes.trim() || undefined,
        }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        setError(body?.error ?? `HTTP ${r.status}`);
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
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Start a new session</DialogTitle>
          <DialogDescription>
            A session locks a cohort + agent config. All iters started inside this session run
            on the selected patients.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          <div>
            <label className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">Name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. WCM pilot cohort A"
              className="mt-1"
              autoFocus
            />
          </div>

          <div>
            <div className="flex items-baseline justify-between">
              <label className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                Cohort ({selected.size}/{availablePatientIds.length} selected)
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
              {availablePatientIds.length === 0 ? (
                <div className="px-2 py-3 text-[11.5px] text-muted-foreground text-center">
                  No patients available — load a cohort sample first.
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

          <div>
            <label className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">Notes (optional)</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="What's this session exploring? Hypothesis, baseline, etc."
              rows={3}
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
              {submitting ? "Creating…" : "Start session"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
