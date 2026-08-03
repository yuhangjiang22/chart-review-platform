import type { Evidence, NoteFocus, SelectedEvidence } from "./types";

export function SelectedEvidencePanel({
  items,
  onJumpToSource,
  onRemove,
}: {
  items: SelectedEvidence[];
  onJumpToSource: (focus: NoteFocus | null) => void;
  onRemove: (id: string) => Promise<void>;
}) {
  return (
    <section className="mb-4 border border-[hsl(var(--ochre)/0.25)] bg-[hsl(var(--ochre)/0.10)]/40 rounded p-3">
      <header className="flex items-center justify-between gap-2 mb-2">
        <h4 className="text-xs font-semibold text-[hsl(var(--ochre))]">
          Selected evidence
        </h4>
        <span className="text-[10px] text-[hsl(var(--ochre))]/70">{items.length}</span>
      </header>
      <ul className="space-y-2">
        {items.map((item) => (
          <SelectedEvidenceCard
            key={item.id}
            item={item}
            onJumpToSource={onJumpToSource}
            onRemove={onRemove}
          />
        ))}
      </ul>
    </section>
  );
}

function SelectedEvidenceCard({
  item,
  onJumpToSource,
  onRemove,
}: {
  item: SelectedEvidence;
  onJumpToSource: (focus: NoteFocus | null) => void;
  onRemove: (id: string) => Promise<void>;
}) {
  const ev = item.evidence;
  const isNote = ev.source === "note";
  const categoryClass =
    item.category === "supporting"
      ? "bg-[hsl(var(--sage)/0.15)] text-[hsl(var(--sage))]"
      : item.category === "contradicting"
        ? "bg-red-100 text-[hsl(var(--oxblood))]"
        : "bg-muted text-muted-foreground";

  return (
    <li className="border border-[hsl(var(--ochre)/0.25)] bg-card rounded p-2 text-xs">
      <div className="flex items-center gap-1.5 flex-wrap mb-1">
        {item.category && (
          <span
            className={`text-[10px] px-1.5 py-0.5 rounded ${categoryClass}`}
          >
            {item.category}
          </span>
        )}
        {item.field_id && (
          <code className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-foreground">
            {item.field_id}
          </code>
        )}
        <span className="text-[10px] text-muted-foreground/70 ml-auto">
          by {item.added_by.startsWith("agent_") ? "agent" : item.added_by}
        </span>
      </div>
      {isNote ? (
        <blockquote className="text-foreground border-l-2 border-[hsl(var(--ochre)/0.25)] pl-2 italic">
          "{(ev as Extract<Evidence, { source: "note" }>).verbatim_quote}"
        </blockquote>
      ) : (
        <div className="text-foreground font-mono text-[11px]">
          {(() => {
            const se = ev as Extract<Evidence, { source: "omop" | "structured" }>;
            return (
              <>
                {se.source}:{se.table}#{se.row_id}
                {se.concept_name ? ` · ${se.concept_name}` : ""}
                {se.value !== undefined ? ` = ${String(se.value)} ${se.unit ?? ""}` : ""}
              </>
            );
          })()}
        </div>
      )}
      <div className="text-[11px] text-muted-foreground mt-1">
        {isNote
          ? (() => {
              const ne = ev as Extract<Evidence, { source: "note" }>;
              return `${ne.note_id} · offsets [${ne.span_offsets[0]}, ${ne.span_offsets[1]}]`;
            })()
          : (ev as Extract<Evidence, { source: "omop" | "structured" }>).evidence_date ?? ""}
      </div>
      {item.rationale && (
        <p className="text-muted-foreground mt-1">{item.rationale}</p>
      )}
      <div className="mt-2 flex gap-1">
        {isNote && (
          <button
            onClick={() => {
              const ne = ev as Extract<Evidence, { source: "note" }>;
              onJumpToSource({
                filename: ne.note_id,
                highlight: {
                  start: ne.span_offsets[0],
                  end: ne.span_offsets[1],
                },
              });
            }}
            className="text-[11px] px-2 py-0.5 rounded bg-amber-200 text-[hsl(var(--ochre))] hover:bg-amber-300"
          >
            jump to source
          </button>
        )}
        <button
          onClick={() => onRemove(item.id)}
          className="text-[11px] px-2 py-0.5 rounded bg-muted text-foreground hover:bg-secondary ml-auto"
          title="Remove this evidence pin"
        >
          ✕
        </button>
      </div>
    </li>
  );
}
