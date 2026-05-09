import { ReactNode } from "react";

// Pill — small status chip used widely across the app. The tone palette is
// re-mapped to the editorial-scientific theme: sage for "ok", ochre for
// "warn", oxblood for "err", warm graphite for "neutral", inkless ghost,
// and a calm "info" tone that picks up the muted token.
//
// Same public API as before, so every legacy consumer (RulesPanel,
// MaturityPanel, WorkflowBar, etc.) inherits the new palette automatically.
export type PillTone = "ok" | "warn" | "err" | "neutral" | "ghost" | "info";

export interface PillProps {
  tone?: PillTone;
  children: ReactNode;
  className?: string;
  title?: string;
}

const TONES: Record<PillTone, string> = {
  ok: "bg-[hsl(var(--sage)/0.12)] text-[hsl(var(--sage))] border-[hsl(var(--sage)/0.25)]",
  warn: "bg-[hsl(var(--ochre)/0.12)] text-[hsl(var(--ochre))] border-[hsl(var(--ochre)/0.25)]",
  err: "bg-[hsl(var(--oxblood)/0.10)] text-[hsl(var(--oxblood))] border-[hsl(var(--oxblood)/0.25)]",
  neutral: "bg-secondary text-foreground border-border",
  ghost: "bg-transparent text-muted-foreground border-border",
  info: "bg-muted text-muted-foreground border-border",
};

export function Pill({ tone = "neutral", children, className = "", title }: PillProps) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11.5px] ${TONES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}
