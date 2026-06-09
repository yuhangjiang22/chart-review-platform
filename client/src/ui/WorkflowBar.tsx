// WorkflowBar — bottom action bar in editorial-scientific styling.
//
// Same actions (bulk-accept, validate, pre-lock, lock, encounters),
// rebuilt with shadcn primitives and the oxblood/cream palette. Lock is
// the single oxblood button — everything else is outline or ghost so the
// eye lands where it matters.
//
// Status pill on the left tells the reviewer where they are in the
// workflow ladder. Progress sits next to it in tabular numerals so it
// scans without re-counting.
import { useState } from "react";
import { CheckSquare, Lock, ScrollText, Search, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { authFetch } from "../auth";
import { withSession } from "../active-session";
import type { CompiledField, ReviewState } from "../types";

export interface WorkflowBarProps {
  patientId: string;
  taskId: string;
  fields: CompiledField[];
  reviewState: ReviewState | null;
  onOpenPreLock: () => void;
  onOpenEncounters: () => void;
}

export function WorkflowBar({
  patientId,
  taskId,
  fields,
  reviewState,
  onOpenPreLock,
  onOpenEncounters,
}: WorkflowBarProps) {
  const [busy, setBusy] = useState(false);

  const leaves = fields.filter((f) => !f.derivation);
  const fas = reviewState?.field_assessments ?? [];
  const terminal = leaves.filter((f) => {
    const fa = fas.find((x) => x.field_id === f.id);
    return fa && (fa.status === "approved" || fa.status === "overridden" || fa.status === "not_applicable");
  }).length;
  const touched = leaves.filter((f) => fas.find((x) => x.field_id === f.id)?.source === "reviewer").length;
  const total = leaves.length;
  const isLocked = reviewState?.review_status === "locked";
  const isValidated = reviewState?.review_status === "reviewer_validated";

  async function bulkAccept() {
    if (!confirm("Accept ALL remaining agent drafts as-is?")) return;
    setBusy(true);
    try {
      await authFetch(withSession(`/api/reviews/${patientId}/${taskId}/bulk-accept`), { method: "POST" });
    } finally { setBusy(false); }
  }
  async function validate() {
    setBusy(true);
    try {
      const r = await authFetch(withSession(`/api/reviews/${patientId}/${taskId}/validate`), { method: "POST" });
      const body = await r.json();
      if (!body.ok) alert(`Cannot validate yet:\n${JSON.stringify(body.gate_results, null, 2)}`);
    } finally { setBusy(false); }
  }
  async function lock() {
    if (!confirm("Lock this record? This is irreversible — no further writes will be accepted.")) return;
    setBusy(true);
    try {
      const r = await authFetch(withSession(`/api/reviews/${patientId}/${taskId}/lock`), { method: "POST" });
      const body = await r.json();
      if (!body.ok) alert(`Lock failed:\n${body.error ?? "Unknown error"}`);
    } finally { setBusy(false); }
  }
  async function unvalidate() {
    setBusy(true);
    try {
      await authFetch(withSession(`/api/reviews/${patientId}/${taskId}/uiactions`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "set_review_status",
          payload: { review_status: "in_progress" },
        }),
      });
    } finally { setBusy(false); }
  }

  if (isLocked) {
    return (
      <footer className="flex h-12 items-center gap-3 border-t border-border bg-paper/70 px-5 text-[12px]">
        <Badge variant="locked" className="!text-[10px]">
          <Lock size={9} strokeWidth={2.5} className="mr-0.5" /> Locked
        </Badge>
        {reviewState?.lock_task_sha && (
          <span className="font-mono text-muted-foreground">sha {reviewState.lock_task_sha.slice(0, 8)}</span>
        )}
        {reviewState?.locked_by && <span className="text-muted-foreground">by {reviewState.locked_by}</span>}
        {reviewState?.locked_at && <span className="text-muted-foreground">at {reviewState.locked_at.slice(0, 16)}</span>}
      </footer>
    );
  }

  return (
    <footer className="flex h-12 items-center gap-3 border-t border-border bg-paper/70 px-5">
      {/* Status pill */}
      {isValidated ? (
        <Badge variant="validated" className="!text-[10px]">
          <ShieldCheck size={9} strokeWidth={2.5} className="mr-0.5" /> Validated
        </Badge>
      ) : (
        <Badge variant="outline" className="!text-[10px]">{reviewState?.review_status ?? "draft"}</Badge>
      )}

      {/* Progress */}
      <div className="flex items-center gap-2 text-[12px] tabular-nums">
        <span className="text-muted-foreground">Progress</span>
        <span className="font-mono text-ink">
          {terminal}<span className="text-muted-foreground">/{total}</span>
        </span>
        <span className="text-muted-foreground">·</span>
        <span className="font-mono text-ink">
          {touched} <span className="text-muted-foreground">touched</span>
        </span>
      </div>

      <div className="flex-1" />

      {/* Encounters */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="sm" onClick={onOpenEncounters} disabled={busy}>
            <ScrollText size={13} /> Encounters
          </Button>
        </TooltipTrigger>
        <TooltipContent>Add per-encounter / per-episode scope to this record</TooltipContent>
      </Tooltip>

      {/* Bulk accept */}
      {!isValidated && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline" size="sm" onClick={bulkAccept} disabled={busy}>
              <CheckSquare size={13} /> Accept all remaining
            </Button>
          </TooltipTrigger>
          <TooltipContent>Approve every remaining agent draft as-is</TooltipContent>
        </Tooltip>
      )}

      {/* Pre-lock check */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline" size="sm" onClick={onOpenPreLock} disabled={busy}>
            <Search size={13} /> Pre-lock check
          </Button>
        </TooltipTrigger>
        <TooltipContent>Copilot summary of approvals + override reasons + lock blockers (~30s)</TooltipContent>
      </Tooltip>

      {/* Mark validated / Unvalidate (toggle) */}
      {!isValidated ? (
        <Button
          variant="secondary"
          size="sm"
          onClick={validate}
          disabled={busy || terminal !== total}
          title={terminal !== total ? `${total - terminal} criteria still need a decision` : "Mark this record reviewer-validated"}
        >
          Mark validated
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          onClick={unvalidate}
          disabled={busy}
          title="Revert to in-progress so you can edit again. Lock will require re-validating."
        >
          Unvalidate
        </Button>
      )}

      {/* Lock — the single oxblood button. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="sm"
            onClick={lock}
            disabled={busy || !isValidated}
            title="Irreversible. No further writes accepted."
          >
            <Lock size={13} strokeWidth={2} /> Lock
          </Button>
        </TooltipTrigger>
        <TooltipContent>{isValidated ? "Commit this record permanently" : "Mark validated first"}</TooltipContent>
      </Tooltip>
    </footer>
  );
}
