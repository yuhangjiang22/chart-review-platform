// TaskKindPickerDialog — step 1 of the "Create new task" flow.
//
// Opens before AuthoringModeDialog. Lets the user pick which task_kind
// they're creating. Routes:
//   phenotype → existing AuthoringModeDialog (chart-review-author / build)
//   ner       → POST /api/tasks/scaffold + jump to AUTHOR pane
//   adherence → POST /api/tasks/scaffold + jump to AUTHOR pane
//
// The NER and adherence scaffolders create a skeleton skill bundle on
// disk so the methodologist can start authoring through PhaseSpanAuthor /
// PhaseAdherenceAuthor instead of hand-editing YAML on the filesystem.

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { Button } from "@/components/ui/button";
import { authFetch } from "../../auth";

export type TaskKindChoice = "phenotype" | "ner" | "adherence";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called with "phenotype" — caller opens the existing
   *  AuthoringModeDialog. */
  onPickPhenotype: () => void;
  /** Called with the newly-created task_id after a successful scaffold. */
  onScaffolded: (taskId: string, kind: "ner" | "adherence") => void;
}

export function TaskKindPickerDialog({
  open, onClose, onPickPhenotype, onScaffolded,
}: Props) {
  const [kind, setKind] = useState<TaskKindChoice | null>(null);
  const [taskId, setTaskId] = useState("");
  const [ontologyPin, setOntologyPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function reset() {
    setKind(null); setTaskId(""); setOntologyPin(""); setErr(null); setBusy(false);
  }

  async function scaffold(scaffoldKind: "ner" | "adherence") {
    if (!taskId.trim()) { setErr("task_id required"); return; }
    setBusy(true); setErr(null);
    try {
      const r = await authFetch("/api/tasks/scaffold", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task_id: taskId.trim(),
          task_kind: scaffoldKind,
          ...(scaffoldKind === "ner" && ontologyPin.trim()
            ? { ontology_pin: ontologyPin.trim() }
            : {}),
        }),
      });
      const body = await r.json().catch(() => ({} as { error?: string }));
      if (!r.ok) {
        setErr((body as { error?: string }).error ?? `scaffold failed: ${r.status}`);
        return;
      }
      onScaffolded(taskId.trim(), scaffoldKind);
      reset();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { reset(); onClose(); } }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a new task</DialogTitle>
        </DialogHeader>

        {kind === null && (
          <div className="space-y-3 mt-3">
            <div className="text-[12.5px] text-muted-foreground">
              What kind of chart-review task are you creating?
            </div>
            <button
              onClick={() => setKind("phenotype")}
              className="block w-full rounded-md border border-border bg-card p-3 text-left hover:bg-muted/40 transition-colors"
            >
              <div className="font-serif text-[15px]">Phenotype validation</div>
              <div className="text-[11.5px] text-muted-foreground mt-1">
                A rubric of yes / no / value criteria evaluated per patient
                (e.g. lung-cancer status, asthma severity).
              </div>
            </button>
            <button
              onClick={() => setKind("ner")}
              className="block w-full rounded-md border border-border bg-card p-3 text-left hover:bg-muted/40 transition-colors"
            >
              <div className="font-serif text-[15px]">NER (entity extraction)</div>
              <div className="text-[11.5px] text-muted-foreground mt-1">
                Pull concept mentions from notes against an ontology
                (e.g. BSO-AD social determinants, AD-CDE common data elements).
              </div>
            </button>
            <button
              onClick={() => setKind("adherence")}
              className="block w-full rounded-md border border-border bg-card p-3 text-left hover:bg-muted/40 transition-colors"
            >
              <div className="font-serif text-[15px]">Adherence (guideline concordance)</div>
              <div className="text-[11.5px] text-muted-foreground mt-1">
                Tier-stratified question framework + rule-based concordance
                evaluation (e.g. NAEPP asthma, NCCN lung-cancer).
              </div>
            </button>
          </div>
        )}

        {kind === "phenotype" && (
          <div className="space-y-3 mt-3">
            <div className="text-[12.5px]">
              Phenotype tasks use the existing authoring flow — Builder
              (interactive chat) or One-shot wizard.
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setKind(null)}>Back</Button>
              <Button onClick={() => { reset(); onPickPhenotype(); }}>Continue</Button>
            </div>
          </div>
        )}

        {(kind === "ner" || kind === "adherence") && (
          <div className="space-y-3 mt-3">
            <label className="block">
              <div className="text-[11.5px] uppercase tracking-wider text-muted-foreground">
                Task id (kebab-case)
              </div>
              <input
                value={taskId}
                onChange={(e) => setTaskId(e.target.value)}
                placeholder={kind === "ner" ? "e.g. ad-cde-ner" : "e.g. asthma-adherence"}
                className="w-full border border-border rounded px-2 py-1 mt-1 bg-background font-mono text-[13px]"
                autoFocus
              />
            </label>

            {kind === "ner" && (
              <label className="block">
                <div className="text-[11.5px] uppercase tracking-wider text-muted-foreground">
                  Ontology pin (optional)
                </div>
                <input
                  value={ontologyPin}
                  onChange={(e) => setOntologyPin(e.target.value)}
                  placeholder="e.g. ad-cde@0.1"
                  className="w-full border border-border rounded px-2 py-1 mt-1 bg-background font-mono text-[13px]"
                />
                <div className="text-[11px] text-muted-foreground mt-1">
                  Form: <code>&lt;id&gt;@&lt;version&gt;</code>. You'll vendor the
                  <code> concepts.json</code> under
                  <code> references/ontology/</code> next.
                </div>
              </label>
            )}

            <div className="text-[11.5px] text-muted-foreground border-l-2 border-[hsl(var(--sage))]/40 pl-2">
              The platform will create a minimal skill skeleton on disk.
              You'll be dropped into the AUTHOR pane to fill in
              {kind === "ner"
                ? " the ontology + per-entity-type guidance."
                : " the tier-stratified questions + rules."}
            </div>

            {err && (
              <div className="text-[12px] text-[hsl(var(--oxblood))]">{err}</div>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setKind(null)} disabled={busy}>Back</Button>
              <Button onClick={() => scaffold(kind)} disabled={busy || !taskId.trim()}>
                {busy ? "Creating…" : "Create task"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
