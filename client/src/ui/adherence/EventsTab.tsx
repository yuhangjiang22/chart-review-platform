// EventsTab — the adherence event chronology, in the source pane beside
// Notes / Structured / Timeline.
//
// Deliberately separate from TimelineTab: that tab is a view of what the chart
// RECORDS (notes, encounters, labs), and mixing rule verdicts into it made both
// harder to read. This tab lists only the events the instrument judged, newest
// first, grouped by month — the same chronological shape, so the two read the
// same way when a reviewer flips between them.
//
// Presentational only. Every mode-dependent decision (blind emits no verdict
// text at all, compare pairs A/H) already happened in buildAdherenceDays, so
// there is nothing here that could leak agent output into a blind view.
import { useMemo } from "react";
import type { AdherenceDay } from "./build-days";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;
const validDate = (d?: string): d is string =>
  !!d && ISO_DATE.test(d) && !Number.isNaN(new Date(d).getTime());

/** "2021-09" → "SEPTEMBER 2021". */
export function monthLabel(key: string): string {
  const [y, m] = key.split("-");
  return `${(MONTHS[Number(m) - 1] ?? m).toUpperCase()} ${y}`;
}

/** How far a date sits from the index date: "index" / "-28d" / "-2mo".
 *  Matches TimelineTab's format so the two chronologies read alike. */
export function relativeToIndex(date?: string, indexDate?: string): string | null {
  if (!validDate(date) || !validDate(indexDate)) return null;
  const days = Math.round((new Date(date).getTime() - new Date(indexDate).getTime()) / 86_400_000);
  if (days === 0) return "index";
  if (Math.abs(days) < 30) return `${days > 0 ? "+" : ""}${days}d`;
  return `${days > 0 ? "+" : ""}${Math.round(days / 30)}mo`;
}

interface MonthGroup { key: string; label: string; days: AdherenceDay[] }

/** Bucket days into month groups, preserving the newest-first order
 *  buildAdherenceDays produced. */
export function groupDaysByMonth(days: AdherenceDay[]): MonthGroup[] {
  const out: MonthGroup[] = [];
  for (const d of days) {
    const key = d.date.slice(0, 7);
    const last = out[out.length - 1];
    if (last?.key === key) last.days.push(d);
    else out.push({ key, label: monthLabel(key), days: [d] });
  }
  return out;
}

interface Props {
  days: AdherenceDay[];
  indexDate?: string;
  selectedEventId?: string | null;
  onSelectEvent?: (eventId: string) => void;
}

export function EventsTab({ days, indexDate, selectedEventId, onSelectEvent }: Props) {
  const groups = useMemo(() => groupDaysByMonth(days), [days]);
  const ruleCount = useMemo(
    () => days.reduce((n, d) => n + d.rules.length, 0),
    [days],
  );

  if (days.length === 0) {
    return (
      <div className="px-4 py-6 text-[12px] text-muted-foreground" data-testid="events-tab">
        No dated events. Per-encounter rules produce events from the patient's
        asthma visits, steroid courses and controller obligations; a patient with
        none is judged on the whole-window rules alone.
      </div>
    );
  }

  return (
    <div className="px-4 py-3" data-testid="events-tab">
      <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Events</div>
      <div className="text-[12px] text-muted-foreground mt-0.5">
        {indexDate && <>Index date: {indexDate} · </>}
        {ruleCount} {ruleCount === 1 ? "judgment" : "judgments"} across {days.length}{" "}
        {days.length === 1 ? "day" : "days"} of care
      </div>

      <div className="mt-3">
        {groups.map((g) => (
          <div key={g.key}>
            <div className="sticky top-0 z-10 -mx-4 px-4 py-1 bg-paper/90 backdrop-blur-sm border-y border-border/60 text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
              {g.label}
            </div>
            {g.days.map((d) => {
              const rel = relativeToIndex(d.date, indexDate);
              return (
                <div key={d.date} className="relative pl-[120px] pr-2 py-2">
                  {/* Rail dot, aligned with TimelineTab's so the two tabs line up. */}
                  <div
                    className="absolute left-[82px] top-3.5 w-3 h-3 rounded-full border-2 border-white"
                    style={{ background: "hsl(var(--oxblood))" }}
                    aria-hidden="true"
                  />
                  {/* Date + offset gutter: the spacing BETWEEN days of care is
                      what a reader scans for, and a bare date column hides it. */}
                  <div className="absolute left-0 top-2 w-[80px] text-right text-[11px] font-mono tabular-nums text-muted-foreground">
                    <div>{d.date}</div>
                    {rel && <div className="text-[10px] text-muted-foreground/70">{rel}</div>}
                  </div>
                  {/* What happened that day, in clinical words — never a rule id. */}
                  <div className="text-[12.5px] text-foreground">
                    {d.kinds.join(" · ") || "Day of care"}
                  </div>
                  <div className="mt-1 space-y-0.5">
                    {d.rules.map((r) => (
                      <button
                        key={r.event_id}
                        type="button"
                        onClick={() => onSelectEvent?.(r.event_id)}
                        aria-current={selectedEventId === r.event_id}
                        title={r.event_id}
                        className={`w-full text-left flex items-center gap-2 rounded px-1.5 py-1 text-[11.5px] hover:bg-muted/60 ${
                          selectedEventId === r.event_id
                            ? "bg-muted ring-1 ring-[hsl(var(--oxblood))]"
                            : ""
                        }`}
                      >
                        <span className="flex-1 truncate">{r.label}</span>
                        {r.validated && (
                          <span className="shrink-0 text-[9px] uppercase tracking-wider text-[hsl(var(--sage))]">
                            validated
                          </span>
                        )}
                        {r.verdict && (
                          <span
                            className={`shrink-0 rounded px-1.5 py-px text-[10px] ${
                              r.muted
                                ? "bg-muted text-muted-foreground"
                                : r.verdict === "CONCORDANT"
                                  ? "bg-[hsl(var(--sage))]/15 text-[hsl(var(--sage))]"
                                  : "bg-[hsl(var(--oxblood))]/12 text-[hsl(var(--oxblood))]"
                            }`}
                          >
                            {r.verdict}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
