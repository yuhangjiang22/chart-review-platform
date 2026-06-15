import type { AssessmentStatus } from "../types";

const ICONS: Record<AssessmentStatus, { ch: string; cls: string; label: string }> = {
  pending: { ch: "○", cls: "text-slate-400", label: "pending" },
  agent_proposed: { ch: "◔", cls: "text-indigo-500", label: "agent proposed" },
  approved: { ch: "✓", cls: "text-emerald-600", label: "approved" },
  overridden: { ch: "✎", cls: "text-amber-600", label: "overridden" },
  not_applicable: { ch: "—", cls: "text-slate-400", label: "not applicable" },
};

export interface StatusIconProps {
  status: AssessmentStatus;
}

export function StatusIcon({ status }: StatusIconProps) {
  const i = ICONS[status];
  return (
    <span
      className={`inline-block w-4 text-center font-mono ${i.cls}`}
      title={i.label}
      aria-label={i.label}
    >
      {i.ch}
    </span>
  );
}
