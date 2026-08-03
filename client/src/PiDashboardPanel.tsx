// app/client/src/PiDashboardPanel.tsx
//
// One-glance dashboard for the PI / lead reviewer (#30).
// Aggregates the per-task state across maturity, pilots, runs,
// rules, cohort feedback, and notifications into a single card.
// Pulls from existing endpoints; no new server work.

import { useEffect, useState } from "react";
import { authFetch } from "./auth";
import { MaturityBadge, type MaturityState } from "./MaturityPanel";

interface MaturityRecord { state: MaturityState; transitions: unknown[] }
interface PilotListing {
  iter_id: string;
  state: "running" | "ready_to_validate" | "complete" | "abandoned";
  run_status: string | null;
  n_complete: number;
  n_patients: number;
  critique?: { proposal_count: number } | null;
}
interface RuleProposal { rule_id: string; status: string; field_id: string; nl_rule: string }
interface RunListing {
  run_id: string;
  task_id: string;
  state: string;
  n_patients: number;
  n_complete: number;
  n_error: number;
  started_at: string;
}
interface CohortRunListing {
  run_id: string;
  generated_at: string;
  member_count: number | null;
}

export function PiDashboardPanel({ taskId }: { taskId: string | null }) {
  const [maturity, setMaturity] = useState<MaturityRecord | null>(null);
  const [pilots, setPilots] = useState<PilotListing[]>([]);
  const [pendingRules, setPendingRules] = useState<RuleProposal[]>([]);
  const [recentRuns, setRecentRuns] = useState<RunListing[]>([]);
  const [cohortRuns, setCohortRuns] = useState<CohortRunListing[]>([]);
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    if (!taskId) {
      setMaturity(null);
      setPilots([]);
      setPendingRules([]);
      setRecentRuns([]);
      setCohortRuns([]);
      return;
    }
    authFetch(`/api/guidelines/${taskId}/maturity`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setMaturity);
    authFetch(`/api/pilots/${taskId}`)
      .then((r) => (r.ok ? r.json() : []))
      .then(setPilots);
    authFetch(`/api/rules/${taskId}?status=pending_methodologist_review`)
      .then((r) => (r.ok ? r.json() : []))
      .then(setPendingRules);
    authFetch(`/api/runs?task_id=${encodeURIComponent(taskId)}&limit=5`)
      .then((r) => (r.ok ? r.json() : []))
      .then(setRecentRuns);
    authFetch(`/api/cohort/${taskId}/runs`)
      .then((r) => (r.ok ? r.json() : []))
      .then(setCohortRuns);
    authFetch(`/api/notifications/unread-count`)
      .then((r) => (r.ok ? r.json() : { count: 0 }))
      .then((b) => setUnread(b.count ?? 0));
  }, [taskId]);

  const latestPilot = pilots[0] ?? null;
  const latestCohort = cohortRuns[0] ?? null;

  return (
    <section className="bg-card border border-border rounded p-4">
      <header className="mb-3">
        <h3 className="font-semibold text-foreground text-sm">📋 PI overview</h3>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          One-glance summary for the active task. Pulls from maturity,
          pilots, runs, rules, cohort feedback, and notifications.
        </p>
      </header>

      {!taskId && <p className="text-[11px] text-muted-foreground/70">select a task</p>}

      {taskId && (
        <div className="space-y-2 text-[11px]">
          <Row label="maturity">
            {maturity ? (
              <span className="inline-flex items-center gap-2">
                <MaturityBadge state={maturity.state} compact />
                <span className="text-muted-foreground">{maturity.transitions.length} transitions</span>
              </span>
            ) : (
              <span className="text-muted-foreground/70">loading…</span>
            )}
          </Row>

          <Row label="latest pilot">
            {latestPilot ? (
              <span>
                <code className="font-mono text-foreground">{latestPilot.iter_id}</code>{" "}
                <span className="text-muted-foreground">
                  · {latestPilot.state.replace(/_/g, " ")}
                  {" · "}
                  {latestPilot.n_complete}/{latestPilot.n_patients} drafted
                  {latestPilot.critique != null && ` · 🤖 ${latestPilot.critique.proposal_count} proposals`}
                </span>
              </span>
            ) : (
              <span className="text-muted-foreground/70">no iterations yet</span>
            )}
          </Row>

          <Row label="pending rules">
            {pendingRules.length === 0 ? (
              <span className="text-muted-foreground/70">none</span>
            ) : (
              <span>
                <span className="font-semibold text-[hsl(var(--ochre))]">{pendingRules.length}</span>{" "}
                <span className="text-muted-foreground truncate">
                  ({pendingRules.slice(0, 3).map((r) => r.field_id).join(", ")}
                  {pendingRules.length > 3 ? ", …" : ""})
                </span>
              </span>
            )}
          </Row>

          <Row label="recent runs">
            {recentRuns.length === 0 ? (
              <span className="text-muted-foreground/70">no runs</span>
            ) : (
              <ul className="space-y-0.5">
                {recentRuns.slice(0, 3).map((r) => (
                  <li key={r.run_id} className="flex justify-between text-[10.5px]">
                    <code className="font-mono text-foreground truncate">{r.run_id.slice(0, 24)}</code>
                    <span className="text-muted-foreground whitespace-nowrap ml-2">
                      {r.n_complete}/{r.n_patients}
                      {r.n_error > 0 && <span className="text-[hsl(var(--oxblood))]"> · {r.n_error} err</span>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Row>

          <Row label="latest cohort feedback">
            {latestCohort ? (
              <span>
                <code className="font-mono text-foreground">{latestCohort.run_id.slice(0, 19)}</code>
                <span className="text-muted-foreground"> · {latestCohort.member_count ?? "?"} members</span>
              </span>
            ) : (
              <span className="text-muted-foreground/70">no runs yet</span>
            )}
          </Row>

          <Row label="notifications">
            {unread > 0 ? (
              <span className="text-[hsl(var(--oxblood))] font-semibold">{unread} unread</span>
            ) : (
              <span className="text-muted-foreground/70">all caught up</span>
            )}
          </Row>
        </div>
      )}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <span className="w-32 shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground mt-0.5">
        {label}
      </span>
      <span className="flex-1 min-w-0 text-foreground">{children}</span>
    </div>
  );
}
