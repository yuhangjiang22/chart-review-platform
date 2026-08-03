import type { EligibilityResult } from "./types";

export function EligibilityPip({ eligibility }: { eligibility: EligibilityResult }) {
  const dots: JSX.Element[] = [];
  for (let i = 0; i < eligibility.required_consecutive; i++) {
    const filled = i < eligibility.consecutive_passing;
    dots.push(
      <span
        key={i}
        aria-hidden
        className={
          filled
            ? "block h-2.5 w-2.5 rounded-full bg-[hsl(var(--sage))]"
            : "block h-2.5 w-2.5 rounded-full border border-border bg-paper"
        }
      />
    );
  }
  return (
    <div className="flex items-center justify-center gap-3 text-[12px] text-muted-foreground">
      <span className="text-[10px] uppercase tracking-[0.18em]">Lock-test eligibility</span>
      <span className="inline-flex items-center gap-1.5">{dots}</span>
      <span className="font-mono">
        {eligibility.consecutive_passing} of {eligibility.required_consecutive} consecutive iters
      </span>
    </div>
  );
}
