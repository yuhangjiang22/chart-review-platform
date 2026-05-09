// QueueView — the per-task patient queue.
//
// "What should I look at next?" is the question this answers. The previous
// app dumped 20 patients in a sidebar and offered three layout modes. This
// view presents one ordered list, grouped by status (Ready · Quick · Deep ·
// Locked), with a clear primary action ("Open") on each row.
//
// Aesthetic notes:
// - Hero heading uses Fraunces in a generous size (38px) with the SOFT axis
//   at 50 — gives the page a journal-article feel.
// - Each row is a card that lifts off the cream background; left edge gets
//   an oxblood spine when the patient is the user's next-up suggestion.
// - Counts are rendered with tabular-nums so the columns stay aligned.
// - Locked patients carry a small filled oxblood seal next to the id —
//   physical-document cue without a literal wax stamp.
// - Confidence pills use the editorial palette (sage / ochre / muted) so a
//   reviewer's eye can scan the queue at a glance.
import { useMemo } from "react";
import {
  ArrowRight,
  CircleDashed,
  ListChecks,
  Lock,
  TimerReset,
  Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { PatientSummary } from "../types";
import { cn } from "@/lib/utils";

export interface QueueViewProps {
  patients: PatientSummary[];
  /** Optional per-patient hint about how far along their review is. */
  status?: Record<string, "agent_proposed" | "in_progress" | "reviewer_validated" | "locked">;
  onOpen: (patientId: string) => void;
}

type Tier = "ready" | "quick" | "deep" | "locked";

function tierOf(p: PatientSummary, status: QueueViewProps["status"]): Tier {
  const s = status?.[p.patient_id];
  if (s === "locked") return "locked";
  if (s === "reviewer_validated") return "ready";
  if (p.difficulty === "easy") return "quick";
  if (p.difficulty === "hard") return "deep";
  return "ready";
}

const TIER_META: Record<Tier, { label: string; sub: string; icon: typeof Zap; tone: string }> = {
  ready: {
    label: "Ready",
    sub: "Review when you're warmed up — agent has high confidence",
    icon: ListChecks,
    tone: "text-foreground",
  },
  quick: {
    label: "Quick",
    sub: "Short charts, low ambiguity — knock these out first",
    icon: Zap,
    tone: "text-[hsl(var(--sage))]",
  },
  deep: {
    label: "Deep",
    sub: "Need careful reading — set aside time",
    icon: TimerReset,
    tone: "text-[hsl(var(--ochre))]",
  },
  locked: {
    label: "Locked",
    sub: "Already committed — read-only history",
    icon: Lock,
    tone: "text-[hsl(var(--oxblood))]",
  },
};

export function QueueView({ patients, status, onOpen }: QueueViewProps) {
  const tiers = useMemo(() => {
    const buckets: Record<Tier, PatientSummary[]> = {
      ready: [], quick: [], deep: [], locked: [],
    };
    for (const p of patients) buckets[tierOf(p, status)].push(p);
    return buckets;
  }, [patients, status]);

  const total = patients.length;
  const remaining = total - tiers.locked.length;

  return (
    <div className="animate-rise-in">
      {/* Hero — journal-article style heading + summary line. */}
      <header className="mb-8 flex items-end justify-between gap-8">
        <div>
          <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
            Today
          </div>
          <h1
            className="mt-1.5 text-[38px] leading-[1.05] tracking-tight"
            style={{ fontVariationSettings: '"opsz" 60, "SOFT" 50, "WONK" 0' }}
          >
            What should you review next?
          </h1>
          <p className="mt-3 max-w-[64ch] text-[14.5px] leading-relaxed text-muted-foreground">
            The agent has drafted answers for{" "}
            <span className="text-ink tabular-nums">{remaining}</span> chart
            {remaining === 1 ? "" : "s"}; <span className="text-ink tabular-nums">{tiers.locked.length}</span>{" "}
            already locked. Pick from the queue or jump in via{" "}
            <kbd>⌘K</kbd>. Estimated review time runs ~6 minutes per chart at current pace.
          </p>
        </div>

        <div className="hidden shrink-0 grid-cols-2 gap-x-8 gap-y-1 text-right md:grid">
          <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
            Remaining
          </div>
          <div className="font-display text-[28px] leading-none tabular-nums">
            {remaining}
          </div>
          <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
            Locked
          </div>
          <div className="font-display text-[28px] leading-none tabular-nums text-[hsl(var(--oxblood))]">
            {tiers.locked.length}
          </div>
        </div>
      </header>

      <Separator className="mb-6" />

      {/* Tier sections */}
      <div className="space-y-10">
        {(["quick", "ready", "deep", "locked"] as const).map((tier) => {
          const list = tiers[tier];
          if (list.length === 0) return null;
          return <TierBlock key={tier} tier={tier} items={list} onOpen={onOpen} />;
        })}
      </div>

      {patients.length === 0 && (
        <Card className="mt-6">
          <CardContent className="py-10 text-center text-muted-foreground">
            <CircleDashed className="mx-auto mb-3" size={28} />
            <div className="text-[15px] text-foreground">No patients in this corpus.</div>
            <div className="mt-1 text-[13px]">
              Run an agent batch from <span className="font-medium">Studio · Agent runs</span> to seed drafts.
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function TierBlock({
  tier,
  items,
  onOpen,
}: {
  tier: Tier;
  items: PatientSummary[];
  onOpen: (id: string) => void;
}) {
  const meta = TIER_META[tier];
  const Icon = meta.icon;
  return (
    <section>
      <div className="mb-3 flex items-baseline gap-3">
        <Icon size={14} className={meta.tone} strokeWidth={1.75} />
        <h2 className="font-display text-[18px] tracking-tight">
          {meta.label}
          <span className="ml-2 text-[12px] font-sans tabular-nums text-muted-foreground">
            {items.length}
          </span>
        </h2>
        <span className="text-[12px] text-muted-foreground">{meta.sub}</span>
      </div>

      <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
        {items.map((p, idx) => (
          <PatientRow
            key={p.patient_id}
            p={p}
            tier={tier}
            primary={tier !== "locked" && idx === 0}
            onOpen={onOpen}
          />
        ))}
      </div>
    </section>
  );
}

function PatientRow({
  p,
  tier,
  primary,
  onOpen,
}: {
  p: PatientSummary;
  tier: Tier;
  primary?: boolean;
  onOpen: (id: string) => void;
}) {
  const locked = tier === "locked";
  const display = p.display_name ?? p.patient_id.replace(/^patient_/, "").replace(/_/g, " ");
  return (
    <button
      onClick={() => onOpen(p.patient_id)}
      className={cn(
        "group relative flex items-stretch overflow-hidden rounded-lg border border-border bg-card text-left shadow-page transition-all",
        "hover:-translate-y-px hover:shadow-card hover:border-border/90",
        locked && "opacity-80",
      )}
    >
      {/* Left spine — oxblood for the next-up suggestion, faint border for the rest */}
      <span
        className={cn(
          "w-1 shrink-0 transition-colors",
          primary ? "bg-oxblood" : locked ? "bg-oxblood/40" : "bg-transparent",
        )}
        aria-hidden
      />

      <div className="flex flex-1 items-center gap-4 px-4 py-3">
        {/* Patient id + display */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2">
            {locked && <span className="seal" aria-hidden><Lock size={10} strokeWidth={2.5} /></span>}
            <span className="font-mono text-[12px] text-muted-foreground">{p.patient_id}</span>
            {p.phi && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant="locked" className="!text-[9.5px] !uppercase tracking-widest">PHI</Badge>
                </TooltipTrigger>
                <TooltipContent>This chart contains PHI; routes through the HIPAA-eligible model.</TooltipContent>
              </Tooltip>
            )}
          </div>
          <div className="mt-0.5 truncate font-display text-[15.5px] leading-tight tracking-tight text-ink">
            {display}
          </div>
          {p.headline && (
            <div className="mt-0.5 truncate text-[12px] text-muted-foreground">
              {p.headline}
            </div>
          )}
        </div>

        {/* Status pills */}
        <div className="flex shrink-0 items-center gap-1.5">
          {p.difficulty === "easy" && <Badge variant="conf-high">easy</Badge>}
          {p.difficulty === "medium" && <Badge variant="conf-medium">medium</Badge>}
          {p.difficulty === "hard" && <Badge variant="conf-low">hard</Badge>}
        </div>

        {/* Open arrow — fades in on hover, never crowded */}
        <ArrowRight
          size={16}
          strokeWidth={1.75}
          className={cn(
            "shrink-0 text-muted-foreground transition-all",
            "group-hover:translate-x-0.5 group-hover:text-ink",
            primary && "text-oxblood",
          )}
        />
      </div>
    </button>
  );
}
