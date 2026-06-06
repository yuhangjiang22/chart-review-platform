// EvidenceList.tsx — evidence items with click-to-jump and remove support.
// Reviewer-added evidence is visually distinguished; structured (OMOP) rows
// are shown with table + concept_name rather than a verbatim quote.
import type { Evidence, NoteEvidence, OmopEvidence } from "../types";
import { Icon, Pill } from "../atoms";

export interface EvidenceListProps {
  /** May be undefined when assessment has no evidence array yet. */
  evidence?: Evidence[];
  onJumpToSource: (note_id: string, span: [number, number]) => void;
  /** Click handler for OMOP/structured evidence — switches the right pane
   *  to the Structured tab and scrolls to the matching row. Optional;
   *  omit and OMOP cards stay non-interactive (display only). */
  onJumpToStructured?: (table: string, row_id: string | number) => void;
  /** Called with the index to remove; omit to hide remove buttons (read-only). */
  onRemove?: (idx: number) => void;
  /** Called with the index to "reuse" the cited span — copy this evidence
   *  into the active reviewer's annotation. Renders a "+" button on hover.
   *  Wired by the agent panes in CriterionCard so the reviewer can 1-click
   *  reuse an agent-cited quote without re-selecting it manually. */
  onAdd?: (idx: number) => void;
  /** Who cited this evidence. Drives the per-row provenance pill so the
   *  reviewer can tell agent-cited from human-cited at a glance. */
  citerLabel?: "agent" | "agent 1" | "agent 2" | "you" | "derived";
}

function isNoteEvidence(ev: Evidence): ev is NoteEvidence {
  return ev.source === "note";
}

function isOmopEvidence(ev: Evidence): ev is OmopEvidence {
  return ev.source === "omop" || ev.source === "structured";
}

interface NoteCardProps {
  ev: NoteEvidence;
  idx: number;
  onJump: () => void;
  onRemove?: () => void;
  onAdd?: () => void;
  citerLabel?: EvidenceListProps["citerLabel"];
}

function citerPillTone(label: EvidenceListProps["citerLabel"]): "neutral" | "info" | "ghost" {
  if (label === "you") return "info";
  if (label === "derived") return "ghost";
  return "neutral";
}

function NoteEvidenceCard({ ev, idx, onJump, onRemove, onAdd, citerLabel }: NoteCardProps) {
  const label = citerLabel ?? "agent";
  return (
    <div className="rounded-lg border border-border bg-card hover:border-slate-400 transition-colors group">
      <div className="px-2.5 pt-2 flex items-center gap-1.5 text-[11px]">
        <span className="inline-flex items-center justify-center w-5 h-5 rounded font-mono font-semibold text-[10.5px] bg-[hsl(var(--ochre)/0.10)] text-[hsl(var(--ochre))] border border-[hsl(var(--ochre)/0.25)]">
          {idx + 1}
        </span>
        <span className="text-foreground font-medium truncate">
          {ev.doc_type ?? "Note"}
        </span>
        {ev.evidence_date && (
          <>
            <span className="text-muted-foreground/70">·</span>
            <span className="text-muted-foreground">{ev.evidence_date}</span>
          </>
        )}
        <Pill tone={citerPillTone(label)} className="ml-auto">
          {label === "you" ? null : <Icon name="sparkles" size={9} />}
          {label}
        </Pill>
        <span className="opacity-0 group-hover:opacity-100 flex items-center gap-1">
          <button
            onClick={onJump}
            title="Jump to span"
            className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
          >
            <Icon name="arrowRight" size={12} />
          </button>
          {onAdd && (
            <button
              onClick={onAdd}
              title="Reuse this citation in your annotation"
              className="px-1.5 py-0.5 rounded hover:bg-[hsl(var(--oxblood)/0.10)] text-muted-foreground/70 hover:text-[hsl(var(--oxblood))] text-[14px] leading-none font-semibold"
              aria-label="Reuse"
            >
              +
            </button>
          )}
          {onRemove && (
            <button
              onClick={onRemove}
              title="Remove"
              className="p-1 rounded hover:bg-[hsl(var(--oxblood)/0.10)] text-muted-foreground/70 hover:text-[hsl(var(--oxblood))]"
            >
              <Icon name="x" size={12} />
            </button>
          )}
        </span>
      </div>
      <button onClick={onJump} className="block w-full text-left px-2.5 pb-2.5">
        <blockquote className="mt-1 pl-2 border-l-2 border-[hsl(var(--ochre)/0.25)] text-[13px] leading-snug text-foreground whitespace-pre-line">
          &ldquo;{ev.verbatim_quote}&rdquo;
        </blockquote>
        <div className="mt-1 text-[10.5px] text-muted-foreground/70 font-mono">
          offsets [{ev.span_offsets[0]}–{ev.span_offsets[1]}] · {ev.note_id}
        </div>
      </button>
    </div>
  );
}

interface OmopCardProps {
  ev: OmopEvidence;
  idx: number;
  onJump?: () => void;
  onRemove?: () => void;
  onAdd?: () => void;
  citerLabel?: EvidenceListProps["citerLabel"];
}

function OmopEvidenceCard({ ev, idx, onJump, onRemove, onAdd, citerLabel }: OmopCardProps) {
  const label = citerLabel ?? "agent";
  return (
    <div className="rounded-lg border border-border bg-card group hover:border-slate-400 transition-colors">
      <div className="px-2.5 pt-2 flex items-center gap-1.5 text-[11px]">
        <span className="inline-flex items-center justify-center w-5 h-5 rounded font-mono font-semibold text-[10.5px] bg-muted text-foreground border border-border">
          {idx + 1}
        </span>
        <Pill tone="neutral">{ev.table}</Pill>
        <span className="text-foreground truncate">{ev.concept_name ?? ""}</span>
        <Pill tone={citerPillTone(label)}>
          {label === "you" ? null : <Icon name="sparkles" size={9} />}
          {label}
        </Pill>
        <span className="ml-auto opacity-0 group-hover:opacity-100 flex items-center gap-1">
          {onJump && (
            <button
              onClick={onJump}
              title="Open in Structured tab"
              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
            >
              <Icon name="arrowRight" size={12} />
            </button>
          )}
          {onAdd && (
            <button
              onClick={onAdd}
              title="Reuse this citation in your annotation"
              className="px-1.5 py-0.5 rounded hover:bg-[hsl(var(--oxblood)/0.10)] text-muted-foreground/70 hover:text-[hsl(var(--oxblood))] text-[14px] leading-none font-semibold"
              aria-label="Reuse"
            >
              +
            </button>
          )}
          {onRemove && (
            <button
              onClick={onRemove}
              title="Remove"
              className="p-1 rounded hover:bg-[hsl(var(--oxblood)/0.10)] text-muted-foreground/70 hover:text-[hsl(var(--oxblood))]"
            >
              <Icon name="x" size={12} />
            </button>
          )}
        </span>
      </div>
      {onJump ? (
        <button
          onClick={onJump}
          className="block w-full text-left px-2.5 pb-2 pt-1"
        >
          <div className="text-[12px] text-foreground pl-[28px] flex items-center gap-2">
            <span className="text-muted-foreground">value</span>
            <span className="font-mono">{String(ev.value ?? "—")}</span>
            {ev.evidence_date && (
              <span className="text-muted-foreground/70">· {ev.evidence_date}</span>
            )}
          </div>
          <div className="mt-0.5 text-[10.5px] text-muted-foreground/70 pl-[28px] font-mono">
            {ev.table} · row {String(ev.row_id)}
          </div>
        </button>
      ) : (
        <div className="text-[12px] text-foreground px-2.5 pb-2 pt-1 pl-[calc(0.625rem+28px)] flex items-center gap-2">
          <span className="text-muted-foreground">value</span>
          <span className="font-mono">{String(ev.value ?? "—")}</span>
          {ev.evidence_date && (
            <span className="text-muted-foreground/70">· {ev.evidence_date}</span>
          )}
        </div>
      )}
    </div>
  );
}

export function EvidenceList({ evidence = [], onJumpToSource, onJumpToStructured, onRemove, onAdd, citerLabel }: EvidenceListProps) {
  if (evidence.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-muted/50 px-3 py-3.5 text-[12.5px] text-muted-foreground">
        <div className="font-medium text-foreground mb-1">No evidence cited</div>
        <div className="text-muted-foreground leading-snug">
          Agent did not cite evidence for this criterion.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.1em] text-muted-foreground font-semibold mb-2">
        <Icon name="quote" size={12} className="text-muted-foreground/70" />
        Evidence
        <span className="ml-auto font-mono normal-case tracking-normal">
          {evidence.length} item{evidence.length === 1 ? "" : "s"}
        </span>
      </div>
      <ul className="space-y-1.5">
        {evidence.map((ev, i) => (
          <li key={i}>
            {isNoteEvidence(ev) ? (
              <NoteEvidenceCard
                ev={ev}
                idx={i}
                onJump={() => onJumpToSource(ev.note_id, ev.span_offsets)}
                onRemove={onRemove ? () => onRemove(i) : undefined}
                onAdd={onAdd ? () => onAdd(i) : undefined}
                citerLabel={citerLabel}
              />
            ) : isOmopEvidence(ev) ? (
              <OmopEvidenceCard
                ev={ev}
                idx={i}
                onJump={
                  onJumpToStructured
                    ? () => onJumpToStructured(ev.table, ev.row_id)
                    : undefined
                }
                onRemove={onRemove ? () => onRemove(i) : undefined}
                onAdd={onAdd ? () => onAdd(i) : undefined}
                citerLabel={citerLabel}
              />
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
