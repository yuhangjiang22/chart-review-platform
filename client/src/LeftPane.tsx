import { useState } from "react";
import type { CompiledField, ReviewState, CrossCriterionAlert } from "./types";
import { Pill, StatusIcon, AlertsSheet, Icon } from "./atoms";
import { fieldApplicability } from "./contractEvalClient";

export interface LeftPaneProps {
  fields: CompiledField[];
  reviewState: ReviewState | null;
  selectedFieldId: string | null;
  onSelectField: (id: string) => void;
}

export function LeftPane({ fields, reviewState, selectedFieldId, onSelectField }: LeftPaneProps) {
  const [alertsOpen, setAlertsOpen] = useState(false);
  const alerts: CrossCriterionAlert[] = reviewState?.cross_criterion_alerts ?? [];
  const errorCount = alerts.filter((a) => a.severity === "error").length;

  // Build a flat answers map from current field assessments
  const answers: Record<string, unknown> = {};
  for (const fa of reviewState?.field_assessments ?? []) {
    if (fa.answer !== undefined) answers[fa.field_id] = fa.answer;
  }

  return (
    <aside className="w-[280px] border-r border-border bg-muted/50 flex flex-col">
      {/* Header */}
      <div className="p-3 border-b border-border flex items-center justify-between">
        <span className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
          Criteria
        </span>
        {alerts.length > 0 && (
          <button
            onClick={() => setAlertsOpen(true)}
            className={`text-[11px] px-2 py-0.5 rounded inline-flex items-center gap-1 ${
              errorCount > 0
                ? "bg-[hsl(var(--oxblood)/0.10)] text-[hsl(var(--oxblood))]"
                : "bg-[hsl(var(--ochre)/0.10)] text-[hsl(var(--ochre))]"
            }`}
          >
            <Icon name="alert" size={11} />
            {alerts.length} {alerts.length === 1 ? "alert" : "alerts"}
          </button>
        )}
      </div>

      {/* Criterion list — leaf fields only (no derivation) */}
      <ul className="flex-1 overflow-y-auto">
        {fields
          .filter((f) => !f.derivation)
          .map((f) => {
            const fa = reviewState?.field_assessments.find(
              (x) => x.field_id === f.id
            );
            const app = fieldApplicability({ fields }, answers, f.id);
            const greyed = app !== "applicable";
            const flagged = (fa as { flagged?: boolean })?.flagged === true;
            return (
              <li key={f.id}>
                <button
                  onClick={() => onSelectField(f.id)}
                  className={`w-full text-left px-3 py-2 text-[12.5px] flex items-center gap-2 ${
                    selectedFieldId === f.id
                      ? "bg-card border-l-2 border-indigo-500"
                      : "hover:bg-muted"
                  } ${greyed ? "opacity-50" : ""}`}
                >
                  <StatusIcon status={fa?.status ?? "pending"} />
                  <span className="flex-1 truncate">{f.id}</span>
                  {flagged && <Pill tone="warn">&#9876;</Pill>}
                  {greyed && (
                    <Pill tone="ghost">{app === "unknown" ? "?" : "N/A"}</Pill>
                  )}
                </button>
              </li>
            );
          })}
      </ul>

      {/* Alerts slide-over sheet */}
      <AlertsSheet open={alertsOpen} onClose={() => setAlertsOpen(false)}>
        <div className="text-[14px] font-semibold mb-3">
          Cross-criterion alerts
        </div>
        <ul className="space-y-2">
          {alerts.map((a) => (
            <li
              key={a.id}
              className={`p-2 rounded border ${
                a.severity === "error"
                  ? "border-[hsl(var(--oxblood)/0.25)] bg-[hsl(var(--oxblood)/0.10)]"
                  : "border-[hsl(var(--ochre)/0.25)] bg-[hsl(var(--ochre)/0.10)]"
              }`}
            >
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                {a.kind} &middot; {a.severity} &middot; {a.source ?? "live"}
              </div>
              <div className="text-[12.5px] mt-1">{a.message}</div>
              <div className="text-[11px] text-muted-foreground mt-1">
                fields: {a.fields.join(", ")}
              </div>
            </li>
          ))}
        </ul>
      </AlertsSheet>
    </aside>
  );
}
