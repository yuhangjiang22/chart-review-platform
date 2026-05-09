import type { KeywordSuggestions } from "./types";

const KEYWORD_GROUPS: Array<{
  key: keyof KeywordSuggestions;
  label: string;
  cls: string;
}> = [
  { key: "direct_terms", label: "direct", cls: "bg-blue-100 text-blue-800" },
  { key: "aliases", label: "aliases", cls: "bg-sky-100 text-sky-800" },
  {
    key: "abbreviations",
    label: "abbrev",
    cls: "bg-secondary text-foreground",
  },
  {
    key: "behavioral_clues",
    label: "clues",
    cls: "bg-[hsl(var(--ochre)/0.15)] text-fuchsia-800",
  },
  { key: "treatment_terms", label: "tx", cls: "bg-[hsl(var(--sage)/0.15)] text-[hsl(var(--sage))]" },
  {
    key: "negation_patterns",
    label: "negation",
    cls: "bg-[hsl(var(--ochre)/0.15)] text-[hsl(var(--ochre))]",
  },
];

function copyToClipboard(text: string) {
  if (typeof navigator !== "undefined" && navigator.clipboard) {
    navigator.clipboard.writeText(text);
  }
}

export function KeywordChipsPanel({ keywords }: { keywords: KeywordSuggestions }) {
  const total = KEYWORD_GROUPS.reduce(
    (n, g) => n + ((keywords[g.key] as string[] | undefined)?.length ?? 0),
    0,
  );
  if (total === 0) return null;
  return (
    <section className="mb-4 border border-fuchsia-200 bg-fuchsia-50/40 rounded p-3">
      <header className="flex items-center justify-between gap-2 mb-2">
        <h4 className="text-xs font-semibold text-fuchsia-800">
          Keyword suggestions
          {keywords.topic && (
            <span className="text-foreground font-normal ml-1">
              · {keywords.topic}
            </span>
          )}
        </h4>
        {keywords.updated_by && (
          <span className="text-[10px] text-[hsl(var(--ochre))]/70">
            by {keywords.updated_by}
          </span>
        )}
      </header>
      <ul className="space-y-1">
        {KEYWORD_GROUPS.map((g) => {
          const items = keywords[g.key] as string[] | undefined;
          if (!items || items.length === 0) return null;
          return (
            <li key={String(g.key)} className="flex flex-wrap gap-1 items-center">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground mr-1">
                {g.label}
              </span>
              {items.map((kw, i) => (
                <button
                  key={`${String(g.key)}-${i}`}
                  onClick={() => copyToClipboard(kw)}
                  title={`copy "${kw}"`}
                  className={`px-1.5 py-0.5 rounded text-[11px] font-mono ${g.cls} hover:opacity-80`}
                >
                  {kw}
                </button>
              ))}
            </li>
          );
        })}
      </ul>
      <div className="text-[10px] text-muted-foreground mt-2">
        click a chip to copy. paste into your search box or feed back to the agent
        ("now grep notes/ for these").
      </div>
    </section>
  );
}
