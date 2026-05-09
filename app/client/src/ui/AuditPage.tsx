// AuditPage — locked records & history surface.
//
// Shares the editorial-scientific aesthetic with Studio. The page is read-
// only by definition: locked records are immutable. We pull the patients
// listing (with task_id filter so review_status flows through) and surface
// every patient whose review is locked, ordered newest-first.
import { useEffect, useMemo, useState } from "react";
import { History, Lock, Search } from "lucide-react";
import { authFetch } from "../auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import type { PatientSummary } from "../types";
import { cn } from "@/lib/utils";

interface LockedRow {
  patient_id: string;
  display_name?: string;
  locked_at?: string;
  locked_by?: string;
  lock_task_sha?: string;
}

export interface AuditPageProps {
  taskId: string;
  onOpenPatient: (patientId: string) => void;
}

export function AuditPage({ taskId, onOpenPatient }: AuditPageProps) {
  const [patients, setPatients] = useState<PatientSummary[]>([]);
  const [filter, setFilter] = useState("");
  // Per-patient lock detail (locked_at / locked_by / sha) is on the
  // review_state, not on the patients listing — fetch lazily so we don't
  // hammer the server with N requests on first paint.
  const [locks, setLocks] = useState<Record<string, LockedRow>>({});

  useEffect(() => {
    authFetch(`/api/patients?task_id=${encodeURIComponent(taskId)}`)
      .then((r) => r.json())
      .then((list: PatientSummary[]) => setPatients(list));
  }, [taskId]);

  const lockedIds = useMemo(
    () => patients.filter((p) => p.review_status === "locked").map((p) => p.patient_id),
    [patients],
  );

  // Fetch lock metadata for the locked patients (review_state.json contains
  // locked_at / locked_by / lock_task_sha at the top level).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const pid of lockedIds) {
        if (locks[pid]) continue;
        try {
          const rs = await authFetch(`/api/reviews/${pid}/${taskId}`).then((r) => r.json());
          if (cancelled) return;
          const display = patients.find((p) => p.patient_id === pid)?.display_name;
          setLocks((prev) => ({
            ...prev,
            [pid]: {
              patient_id: pid,
              display_name: display,
              locked_at: rs.locked_at,
              locked_by: rs.locked_by,
              lock_task_sha: rs.lock_task_sha,
            },
          }));
        } catch {
          /* skip */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lockedIds.join("|"), taskId]);

  const rows = useMemo(() => {
    const list = lockedIds
      .map((pid) => locks[pid] ?? { patient_id: pid })
      .filter((row) => {
        if (!filter) return true;
        const f = filter.toLowerCase();
        return (
          row.patient_id.toLowerCase().includes(f) ||
          (row.display_name ?? "").toLowerCase().includes(f) ||
          (row.locked_by ?? "").toLowerCase().includes(f) ||
          (row.lock_task_sha ?? "").toLowerCase().includes(f)
        );
      })
      .sort((a, b) => (b.locked_at ?? "").localeCompare(a.locked_at ?? ""));
    return list;
  }, [lockedIds, locks, filter]);

  const distinctLockers = useMemo(
    () => new Set(Object.values(locks).map((l) => l.locked_by).filter(Boolean)).size,
    [locks],
  );
  const distinctSHAs = useMemo(
    () => new Set(Object.values(locks).map((l) => l.lock_task_sha).filter(Boolean)).size,
    [locks],
  );

  return (
    <div className="mx-auto max-w-[1080px] px-10 py-10 animate-rise-in">
      <header className="mb-8">
        <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
          Read-only · committed evidence
        </div>
        <h1
          className="mt-1.5 font-display text-[40px] leading-[1.05] tracking-tight"
          style={{ fontVariationSettings: '"opsz" 60, "SOFT" 60' }}
        >
          Audit
        </h1>
        <p className="mt-2 max-w-[64ch] text-[14px] leading-relaxed text-muted-foreground">
          Every locked record for{" "}
          <code className="font-mono text-[12.5px] text-foreground">{taskId}</code>. Locked records are
          immutable; reopening requires an explicit unlock from a methodologist.
        </p>
      </header>

      <div className="grid grid-cols-2 gap-x-12 gap-y-3 md:grid-cols-3">
        <Stat label="Locked records" value={String(lockedIds.length)} accent={lockedIds.length > 0} />
        <Stat label="Distinct lockers" value={String(distinctLockers)} mute />
        <Stat label="Distinct task SHAs" value={String(distinctSHAs)} mute />
      </div>

      <Separator className="my-8" />

      <div className="mb-4 flex items-center gap-3">
        <div className="relative w-72">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by patient, locker, or sha…"
            className="pl-8"
          />
        </div>
        <span className="text-[11.5px] tabular-nums text-muted-foreground">
          {rows.length} of {lockedIds.length}
        </span>
      </div>

      {rows.length === 0 ? (
        <EmptyAudit hasLocks={lockedIds.length > 0} />
      ) : (
        <ol className="space-y-2">
          {rows.map((row) => (
            <AuditRow key={row.patient_id} row={row} onOpen={onOpenPatient} />
          ))}
        </ol>
      )}
    </div>
  );
}

function AuditRow({ row, onOpen }: { row: LockedRow; onOpen: (pid: string) => void }) {
  return (
    <li
      className={cn(
        "group grid grid-cols-[28px_1fr_auto] items-baseline gap-3 rounded-md border border-border bg-card px-4 py-3",
        "transition-colors hover:border-border/90",
      )}
    >
      <span className="seal" aria-hidden>
        <Lock size={10} strokeWidth={2.5} />
      </span>
      <div>
        <div className="flex items-center gap-2">
          <code className="font-mono text-[12.5px] text-foreground">{row.patient_id}</code>
          {row.display_name && row.display_name !== row.patient_id && (
            <>
              <span className="text-muted-foreground">·</span>
              <span className="text-[13px] text-foreground">{row.display_name}</span>
            </>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
          {row.locked_by && <span>by {row.locked_by}</span>}
          {row.locked_at && <span className="tabular-nums">{row.locked_at.slice(0, 19).replace("T", " ")}</span>}
          {row.lock_task_sha && (
            <span>
              sha <code className="font-mono text-[10.5px]">{row.lock_task_sha.slice(0, 8)}</code>
            </span>
          )}
        </div>
      </div>
      <Button variant="ghost" size="sm" onClick={() => onOpen(row.patient_id)}>
        Open
      </Button>
    </li>
  );
}

function EmptyAudit({ hasLocks }: { hasLocks: boolean }) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-border bg-paper/40 p-8">
      <History size={22} className="text-muted-foreground/60" strokeWidth={1.25} />
      <div className="font-display text-[16px]">{hasLocks ? "No matches" : "No locked records yet"}</div>
      <div className="max-w-[58ch] text-[12.5px] text-muted-foreground">
        {hasLocks
          ? "Adjust the filter above. Locked records are matched on patient id, locker, or task SHA."
          : "Lock a validated record from the Patient view (Validate → 🔒 Lock). The audit page collects every locked record at this task SHA."}
      </div>
    </div>
  );
}

function Stat({ label, value, accent = false, mute = false }: { label: string; value: string; accent?: boolean; mute?: boolean }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">{label}</div>
      <div
        className={cn(
          "mt-1 font-display text-[34px] leading-none tabular-nums",
          accent && "text-[hsl(var(--oxblood))]",
          mute && "text-muted-foreground",
        )}
        style={{ fontVariationSettings: '"opsz" 60, "SOFT" 50' }}
      >
        {value}
      </div>
    </div>
  );
}
