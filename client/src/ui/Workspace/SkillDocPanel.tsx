// Read-only render of the vendored bso-ad SKILL.md (the agent's instructions).
// Replaces RubricPanel on the bso-ad-ner-sdk TRY page.
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { authFetch } from "../../auth";

export function SkillDocPanel() {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await authFetch("/api/ner-sdk/skill");
        if (!r.ok) { if (!cancelled) setError(`Skill load failed: ${r.status}`); return; }
        const { markdown } = (await r.json()) as { markdown: string };
        if (!cancelled) setMarkdown(markdown);
      } catch (e) { if (!cancelled) setError(String(e)); }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="rounded-md border border-border bg-paper/40 px-4 py-3">
      <button
        className="flex w-full items-center justify-between text-[10px] uppercase tracking-[0.14em] text-muted-foreground"
        onClick={() => setOpen((v) => !v)}
      >
        <span>Skill — BSO-AD NER (read-only)</span>
        <span>{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="mt-2 max-h-[60vh] overflow-y-auto text-[13px] leading-relaxed">
          {error && <div className="text-[12px] text-red-600">{error}</div>}
          {!markdown && !error && <div className="text-[12px] text-muted-foreground">Loading…</div>}
          {markdown && (
            <div className="mt-4 text-sm [&_p]:my-2 [&_p]:leading-relaxed [&_h1]:font-semibold [&_h1]:text-ink [&_h2]:font-semibold [&_h2]:text-ink [&_h3]:font-semibold [&_h3]:text-ink [&_li]:text-ink [&_code]:font-mono">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
