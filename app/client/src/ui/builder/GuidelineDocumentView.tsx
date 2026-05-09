import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  bucketByLayer,
  classifyField,
  ExpressionWithRefs,
  extractRefs,
  LAYER_META,
  LAYER_ORDER,
  SchemaInline,
  type GuidelineLikeField,
} from "../guideline-logic";
import { studioHash } from "../useHashRoute";

interface Props {
  taskId: string;
  token: string;
  /** When the agent's turn ends (busy flips false), re-fetch — the agent
   *  may have just Written new files in that turn. */
  busy: boolean;
}

interface CriterionDoc {
  path: string;     // e.g. "references/criteria/received_30d_visit.md"
  raw: string;      // raw file content (markdown w/ frontmatter, or YAML)
  parsed: any;      // best-effort parsed: frontmatter merged with body sections
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;
const SECTION_RE = /^##\s+(.+?)\s*\n([\s\S]*?)(?=\n##\s|$(?![\s\S]))/gm;

/** Parse a `.md` file with YAML frontmatter and `## Heading` body sections.
 *  Returns the merged shape used by Preview cards: frontmatter fields plus
 *  `extraction_guidance` and `guidance_prose.{definition,examples,…}` lifted
 *  from the markdown body. Mirrors `loadPhenotypeCriteria` on the server. */
async function parseCriterionMarkdown(raw: string): Promise<any> {
  const m = FRONTMATTER_RE.exec(raw);
  const { parse } = await import("yaml");
  if (!m) {
    // Fall back: treat whole file as YAML (legacy `criteria/*.yaml`).
    try { return parse(raw); } catch { return null; }
  }
  let front: any = {};
  try { front = parse(m[1]) ?? {}; } catch { front = {}; }
  const body = m[2] ?? "";
  const sections: Record<string, string> = {};
  for (const sm of body.matchAll(SECTION_RE)) {
    sections[sm[1].trim().toLowerCase()] = (sm[2] ?? "").trim();
  }
  // Field-id ↔ id alias so downstream consumers (CriteriaFlowSection) work.
  if (typeof front.field_id === "string" && !front.id) front.id = front.field_id;
  // Lift body sections onto the parsed shape under the keys CriterionCard reads.
  if (sections["extraction guidance"]) front.extraction_guidance = sections["extraction guidance"];
  const guidance: Record<string, string> = front.guidance_prose ?? {};
  if (sections["definition"]) guidance.definition = guidance.definition ?? sections["definition"];
  if (sections["examples"]) guidance.examples = guidance.examples ?? sections["examples"];
  if (sections["satisfying examples"]) guidance.satisfying_examples = guidance.satisfying_examples ?? sections["satisfying examples"];
  if (sections["non-satisfying examples"]) guidance.non_satisfying_examples = guidance.non_satisfying_examples ?? sections["non-satisfying examples"];
  if (sections["boundary examples"]) guidance.boundary_examples = guidance.boundary_examples ?? sections["boundary examples"];
  if (sections["failure modes"]) guidance.failure_modes = guidance.failure_modes ?? sections["failure modes"];
  if (Object.keys(guidance).length > 0) front.guidance_prose = guidance;
  // Preserve the full body so the code_set / keyword_set / edge_case
  // renderers can show whatever the author wrote in markdown sections
  // (e.g. an ICD list as bullets) when the frontmatter doesn't carry
  // a structured `codes` / `terms` array.
  if (body.trim()) front.__body = body.trim();
  return front;
}

function FileEditor({
  taskId, token, path, initial, onSaved, onDeleted,
}: {
  taskId: string;
  token: string;
  path: string;
  initial: string;
  onSaved: () => void;
  /** When provided, renders a Delete button. Caller is responsible for the
   *  confirm prompt + the DELETE request. */
  onDeleted?: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = draft !== initial;

  // Reset draft when initial changes (e.g. agent rewrote the file)
  useEffect(() => { setDraft(initial); setError(null); }, [initial]);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/builder/sessions/${taskId}/edit`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ target: path, before: initial, after: draft }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) {
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      onSaved();
    } catch (e: any) {
      setError(e?.message ?? "save failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!onDeleted) return;
    if (!confirm(`Delete ${path}? This cannot be undone.`)) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/builder/sessions/${taskId}/files?path=${encodeURIComponent(path)}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      const body = await res.json();
      if (!res.ok || !body.ok) {
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      onDeleted();
    } catch (e: any) {
      setError(e?.message ?? "delete failed");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="rounded border border-border bg-paper/40 p-3">
      <div className="flex items-center justify-between mb-2">
        <code className="font-mono text-xs">{path}</code>
        <div className="flex items-center gap-3 text-[11px]">
          {dirty ? (
            <span className="italic text-ochre">modified</span>
          ) : (
            <span className="italic text-muted-foreground">saved</span>
          )}
          <button
            onClick={handleSave}
            disabled={saving || !dirty}
            className="rounded bg-oxblood px-2 py-0.5 text-paper disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
          {onDeleted && (
            <button
              onClick={handleDelete}
              disabled={deleting || saving}
              className="rounded border border-border px-2 py-0.5 text-muted-foreground hover:text-foreground hover:border-border/90 disabled:opacity-50"
              title={`Delete ${path}`}
            >
              {deleting ? "Deleting…" : "Delete"}
            </button>
          )}
        </div>
      </div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        className="w-full h-[40vh] resize-y rounded border border-border bg-card px-3 py-2 font-mono text-xs leading-relaxed"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
      />
      {error && <div className="mt-1 text-xs text-ochre">Error: {error}</div>}
    </div>
  );
}

/** Stub YAML body for a freshly-created criterion. The agent will normally
 *  flesh these fields out via chat; the manual path is for users who want
 *  to scaffold a placeholder and edit the YAML directly. */
function newCriterionStub(slug: string): string {
  return `---
field_id: ${slug}
prompt: ""
answer_schema:
  enum: ["yes", "no", "unknown"]
cardinality: one
---

# Criterion: ${slug}

## Definition

## Extraction guidance

## Examples

## Failure modes
`;
}

export function GuidelineDocumentView({ taskId, token, busy }: Props) {
  const [meta, setMeta] = useState<{ raw: string; parsed: any } | null>(null);
  const [criteria, setCriteria] = useState<CriterionDoc[]>([]);
  const [edgeCases, setEdgeCases] = useState<CriterionDoc[]>([]);
  const [codeSets, setCodeSets] = useState<CriterionDoc[]>([]);
  const [keywordSets, setKeywordSets] = useState<CriterionDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"preview" | "edit">("preview");

  async function loadAll() {
    setLoading(true);
    setError(null);
    try {
      const fetchFile = async (relPath: string): Promise<string | null> => {
        const r = await fetch(
          `/api/builder/sessions/${taskId}/files?path=${encodeURIComponent(relPath)}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (!r.ok) return null;
        return await r.text();
      };

      const fetchDirList = async (relDir: string): Promise<string[]> => {
        const r = await fetch(
          `/api/builder/sessions/${taskId}/list?prefix=${encodeURIComponent(relDir)}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (!r.ok) return [];
        const body = await r.json();
        return body.files ?? [];
      };

      // meta.yaml
      const metaRaw = await fetchFile("meta.yaml");
      if (metaRaw !== null) {
        const { parse } = await import("yaml");
        try {
          setMeta({ raw: metaRaw, parsed: parse(metaRaw, { uniqueKeys: false }) });
        } catch {
          setMeta({ raw: metaRaw, parsed: null });
        }
      }

      // Canonical bundle layout:
      //   references/{criteria,code_sets,keyword_sets,edge_cases}/<id>.md
      // Legacy fallback (only kept so partially-broken drafts still preview):
      //   {criteria,code_sets,keyword_sets}/<id>.yaml + edge_cases.yaml
      const loadDir = async (
        canonicalDir: string,
        legacyDir: string | null,
      ): Promise<CriterionDoc[]> => {
        const docs: CriterionDoc[] = [];
        const canonicalFiles = await fetchDirList(canonicalDir);
        for (const fname of canonicalFiles) {
          if (!fname.endsWith(".md")) continue;
          const path = `${canonicalDir}/${fname}`;
          const raw = await fetchFile(path);
          if (raw === null) continue;
          docs.push({ path, raw, parsed: await parseCriterionMarkdown(raw) });
        }
        if (docs.length === 0 && legacyDir) {
          const legacyFiles = await fetchDirList(legacyDir);
          for (const fname of legacyFiles) {
            if (!fname.endsWith(".yaml")) continue;
            const path = `${legacyDir}/${fname}`;
            const raw = await fetchFile(path);
            if (raw === null) continue;
            docs.push({ path, raw, parsed: await parseCriterionMarkdown(raw) });
          }
        }
        return docs;
      };

      setCriteria(await loadDir("references/criteria", "criteria"));
      setCodeSets(await loadDir("references/code_sets", "code_sets"));
      setKeywordSets(await loadDir("references/keyword_sets", "keyword_sets"));
      setEdgeCases(await loadDir("references/edge_cases", null));
    } catch (e: any) {
      setError(e?.message ?? "load failed");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadAll(); }, [taskId]);

  // Re-fetch every time the agent finishes a turn — the just-finished turn
  // may have included Write calls that produced new YAML files we need to
  // pick up. (Without this, mark_drafted's phase_change can mount the view
  // BEFORE the agent's first Write completes, so the initial load returns
  // 404s and we'd be stuck on "No guideline files yet".)
  useEffect(() => {
    if (!busy) loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

  if (loading) return <div className="p-6 text-sm italic text-muted-foreground">Loading guideline…</div>;
  if (error) return <div className="p-6 text-sm text-ochre">Error: {error}</div>;
  if (!meta) return <div className="p-6 text-sm italic text-muted-foreground">No guideline files yet — agent hasn't drafted.</div>;

  const m = meta.parsed ?? {};

  const header = (
    <header className="flex h-11 shrink-0 items-center border-b border-border px-4 justify-between">
      <span className="font-serif text-sm uppercase tracking-wide">
        Drafted guideline: <code className="font-mono">{taskId}</code>
      </span>
      <div className="flex items-center gap-3 text-xs">
        <div className="flex rounded border border-border overflow-hidden">
          <button
            onClick={() => setMode("preview")}
            className={mode === "preview" ? "bg-oxblood text-paper px-2 py-0.5" : "px-2 py-0.5 hover:bg-muted"}
          >
            Preview
          </button>
          <button
            onClick={() => setMode("edit")}
            className={mode === "edit" ? "bg-oxblood text-paper px-2 py-0.5" : "px-2 py-0.5 hover:bg-muted"}
          >
            Edit
          </button>
        </div>
        <button onClick={loadAll} className="text-muted-foreground underline">refresh</button>
      </div>
    </header>
  );

  if (mode === "edit") {
    const files: Array<{ path: string; raw: string; deletable?: boolean }> = [
      ...(meta ? [{ path: "meta.yaml", raw: meta.raw, deletable: false }] : []),
      ...criteria.map((c) => ({ path: c.path, raw: c.raw, deletable: true })),
      ...codeSets.map((c) => ({ path: c.path, raw: c.raw, deletable: true })),
      ...keywordSets.map((k) => ({ path: k.path, raw: k.raw, deletable: true })),
      ...edgeCases.map((e) => ({ path: e.path, raw: e.raw, deletable: true })),
    ];

    async function addCriterion() {
      const raw = window.prompt(
        "New criterion slug (lowercase letters, digits, underscores; e.g. has_documented_diagnosis):",
        "",
      );
      const slug = raw?.trim() ?? "";
      if (!slug) return;
      if (!/^[a-z][a-z0-9_]*$/.test(slug)) {
        alert("Slug must be lowercase letters/digits/underscores starting with a letter.");
        return;
      }
      const target = `references/criteria/${slug}.md`;
      if (criteria.some((c) => c.path === target)) {
        alert(`${target} already exists.`);
        return;
      }
      const res = await fetch(`/api/builder/sessions/${taskId}/edit`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          target,
          before: "",
          after: newCriterionStub(slug),
        }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) {
        alert(`Failed to create: ${body.error ?? `HTTP ${res.status}`}`);
        return;
      }
      loadAll();
    }

    return (
      <section className="flex flex-1 flex-col min-h-0 overflow-hidden border-r border-border bg-card">
        {header}
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="space-y-6 p-6">
            <div className="flex items-center justify-between">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">
                {files.length} files
              </span>
              <button
                onClick={addCriterion}
                className="rounded border border-oxblood/30 bg-oxblood/5 px-2.5 py-1 text-xs text-foreground hover:bg-oxblood/10"
              >
                + New criterion
              </button>
            </div>
            {files.map((f) => (
              <FileEditor
                key={f.path}
                taskId={taskId}
                token={token}
                path={f.path}
                initial={f.raw}
                onSaved={() => {
                  // After a user-initiated save, return directly to the
                  // workspace — no confirmation prompt. The Edit / "Edit
                  // guideline" CTA in the workspace is the entry point and
                  // saving is the implicit exit.
                  window.location.hash = studioHash(taskId);
                }}
                onDeleted={f.deletable ? loadAll : undefined}
              />
            ))}
          </div>
        </div>
      </section>
    );
  }

  // Preview mode — structured render, no foldables, no Edit YAML links.
  return (
    <section className="flex flex-1 flex-col min-h-0 overflow-hidden border-r border-border bg-card">
      {header}
      <div className="flex-1 min-h-0 overflow-y-auto p-6 space-y-6">
        {/* Meta — title + full metadata */}
        <div>
          <h1 className="font-serif text-2xl text-foreground">{m.task_id ?? taskId}</h1>
          <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-muted-foreground">
            {m.task_type && <div>task_type: <code className="font-mono">{String(m.task_type)}</code></div>}
            {m.review_unit && <div>review_unit: <code className="font-mono">{String(m.review_unit)}</code></div>}
            {m.output_shape && <div>output_shape: <code className="font-mono">{String(m.output_shape)}</code></div>}
            {m.manual_version && <div>manual_version: <code className="font-mono">{String(m.manual_version)}</code></div>}
            {m.index_anchor && <div>index_anchor: <code className="font-mono">{String(m.index_anchor)}</code></div>}
            {m.final_output && <div>final_output: <code className="font-mono">{String(m.final_output)}</code></div>}
          </div>

          {m.overview_prose && (
            <div className="mt-4 text-sm [&_p]:my-2 [&_p]:leading-relaxed">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{String(m.overview_prose)}</ReactMarkdown>
            </div>
          )}

          {(m.denominator || m.index_event) && (
            <div className="mt-3 rounded border border-border bg-paper/40 p-3 space-y-1 text-sm">
              {m.denominator && (
                <div><span className="font-semibold">Denominator: </span>{String(m.denominator)}</div>
              )}
              {m.index_event && (
                <div><span className="font-semibold">Index event: </span>{String(m.index_event)}</div>
              )}
            </div>
          )}

          {Array.isArray(m.time_windows) && m.time_windows.length > 0 && (
            <div className="mt-3">
              <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Time windows</div>
              <ul className="text-sm space-y-1">
                {m.time_windows.map((tw: any, i: number) => (
                  <li key={i}>
                    <code className="font-mono text-xs">{String(tw.id ?? "?")}</code>
                    {tw.label ? <span className="text-muted-foreground"> — {String(tw.label)}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {Array.isArray(m.source_document_priority) && m.source_document_priority.length > 0 && (
            <div className="mt-3">
              <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Source priority (when sources conflict)</div>
              <ol className="text-sm space-y-0.5 list-decimal list-inside">
                {m.source_document_priority.map((src: any, i: number) => (
                  <li key={i}>{String(src)}</li>
                ))}
              </ol>
            </div>
          )}
        </div>

        {criteria.length > 0 && (
          <CriteriaFlowSection criteria={criteria} />
        )}

        {/* Code sets */}
        {codeSets.length > 0 && (
          <div>
            <h2 className="font-serif text-lg text-foreground border-b border-border pb-1">Code sets</h2>
            <div className="mt-3 space-y-2">
              {codeSets.map((c) => {
                const p = c.parsed ?? {};
                const codes = Array.isArray(p.codes) ? p.codes : [];
                return (
                  <div key={c.path} className="rounded border border-border bg-paper/40 p-3">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-mono text-sm">{p.id ?? c.path}</span>
                      {p.system && (
                        <span className="text-[11px] text-muted-foreground">system: <code className="font-mono">{String(p.system)}</code></span>
                      )}
                    </div>
                    {p.description && (
                      <div className="mt-1 text-xs text-muted-foreground">{String(p.description)}</div>
                    )}
                    {codes.length > 0 ? (
                      <ul className="mt-1 text-xs font-mono text-muted-foreground space-y-0.5">
                        {codes.map((code: any, i: number) => (
                          <li key={i}>{typeof code === "string" ? code : (code.code ?? code.concept_name ?? JSON.stringify(code))}</li>
                        ))}
                      </ul>
                    ) : p.__body ? (
                      <div className="mt-1 text-xs [&_p]:my-1 [&_ul]:list-disc [&_ul]:pl-5">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{String(p.__body)}</ReactMarkdown>
                      </div>
                    ) : null}
                    {p.source && (
                      <div className="mt-1 text-xs italic text-muted-foreground">source: {String(p.source)}</div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Keyword sets */}
        {keywordSets.length > 0 && (
          <div>
            <h2 className="font-serif text-lg text-foreground border-b border-border pb-1">Keyword sets</h2>
            <div className="mt-3 space-y-2">
              {keywordSets.map((k) => {
                const p = k.parsed ?? {};
                const terms = Array.isArray(p.terms) ? p.terms
                  : Array.isArray(p.keywords) ? p.keywords
                  : [];
                return (
                  <div key={k.path} className="rounded border border-border bg-paper/40 p-3">
                    <span className="font-mono text-sm">{p.id ?? k.path}</span>
                    {p.description && (
                      <div className="mt-1 text-xs text-muted-foreground">{String(p.description)}</div>
                    )}
                    {terms.length > 0 ? (
                      <ul className="mt-1 text-xs italic text-muted-foreground space-y-0.5">
                        {terms.map((kw: any, i: number) => (
                          <li key={i}>{typeof kw === "string" ? kw : JSON.stringify(kw)}</li>
                        ))}
                      </ul>
                    ) : p.__body ? (
                      <div className="mt-1 text-xs [&_p]:my-1 [&_ul]:list-disc [&_ul]:pl-5">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{String(p.__body)}</ReactMarkdown>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Edge cases — one file per case under references/edge_cases/<id>.md */}
        {edgeCases.length > 0 && (
          <div>
            <h2 className="font-serif text-lg text-foreground border-b border-border pb-1">Edge cases</h2>
            <div className="mt-3 space-y-2">
              {edgeCases.map((ec) => {
                const p = ec.parsed ?? {};
                return (
                  <div key={ec.path} className="text-sm border-l-2 border-ochre pl-3">
                    <div className="font-mono text-xs text-muted-foreground">
                      {String(p.id ?? p.field_id ?? ec.path)}
                    </div>
                    {p.pattern && <div className="mt-0.5 italic">{String(p.pattern)}</div>}
                    {(p.why || p.failure_mode) && (
                      <div className="mt-0.5">{String(p.why ?? p.failure_mode)}</div>
                    )}
                    {p.correct_answer_hint && (
                      <div className="mt-0.5 text-xs">
                        <span className="font-semibold">Correct answer hint: </span>
                        {String(p.correct_answer_hint)}
                      </div>
                    )}
                    {p.guidance_prose?.definition && (
                      <div className="mt-1 text-xs [&_p]:my-0.5">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {String(p.guidance_prose.definition)}
                        </ReactMarkdown>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

// ─── Layered criteria render (used in Preview mode) ──────────────────────

/** Group the parsed criteria by logical layer (Inputs → Conditional →
 *  Computed → Final), and render each as a rich card with clickable field
 *  refs in gate/derivation expressions. Mirrors the Guideline tab's logic
 *  flow so the same mental model applies whether you're reading the locked
 *  rubric or watching the agent draft a new one. */
function CriteriaFlowSection({ criteria }: { criteria: CriterionDoc[] }) {
  // Promote each parsed YAML criterion to the structural shape used by the
  // shared classifier + ref extractor.
  const fields: Array<GuidelineLikeField & { __doc: CriterionDoc; parsed: any }> = useMemo(
    () =>
      criteria
        .filter((c) => c.parsed && typeof c.parsed.id === "string")
        .map((c) => ({
          id: String(c.parsed.id),
          derivation: c.parsed.derivation ? String(c.parsed.derivation) : undefined,
          is_applicable_when: c.parsed.is_applicable_when
            ? String(c.parsed.is_applicable_when)
            : undefined,
          is_final_output: c.parsed.is_final_output === true,
          answer_schema: c.parsed.answer_schema,
          __doc: c,
          parsed: c.parsed,
        })),
    [criteria],
  );
  const fieldIds = useMemo(() => new Set(fields.map((f) => f.id)), [fields]);
  const layers = useMemo(() => bucketByLayer(fields), [fields]);

  function jumpToCriterion(id: string) {
    const el = document.getElementById(`crit-card-${id}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  return (
    <div>
      <h2 className="font-serif text-lg text-foreground border-b border-border pb-1">Logic flow</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        How a chart runs through this guideline: ask the inputs, then the
        conditional inputs whose gate fires, then compute the derived fields,
        then the final output.
      </p>
      <div className="mt-4 space-y-6">
        {LAYER_ORDER.map((layer, idx) => {
          const items = layers[layer];
          if (items.length === 0) return null;
          const meta = LAYER_META[layer];
          const Icon = meta.icon;
          return (
            <div key={layer}>
              <div className="flex items-baseline gap-2">
                <Icon size={13} className={meta.tone} strokeWidth={1.75} />
                <h3 className="font-display text-[15.5px] tracking-tight">
                  {meta.label}
                  <span className="ml-2 text-[11px] font-sans tabular-nums text-muted-foreground">
                    {items.length}
                  </span>
                </h3>
                <span className="text-[11.5px] text-muted-foreground">{meta.caption}</span>
              </div>
              <div className="mt-2 space-y-3">
                {items.map((f) => (
                  <CriterionCard
                    key={f.id}
                    field={f}
                    parsed={f.parsed}
                    fieldIds={fieldIds}
                    onSelectField={jumpToCriterion}
                  />
                ))}
              </div>
              {idx < LAYER_ORDER.length - 1 && layers[LAYER_ORDER[idx + 1]].length > 0 && (
                <div className="mt-3 ml-1 h-3 border-l border-border/60" aria-hidden />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CriterionCard({
  field,
  parsed,
  fieldIds,
  onSelectField,
}: {
  field: GuidelineLikeField;
  parsed: any;
  fieldIds: Set<string>;
  onSelectField: (id: string) => void;
}) {
  const layer = classifyField(field);
  const layerMeta = LAYER_META[layer];
  const LayerIcon = layerMeta.icon;
  const gateRefs = extractRefs(field.is_applicable_when, fieldIds);
  const derivRefs = extractRefs(field.derivation, fieldIds);

  return (
    <div
      id={`crit-card-${field.id}`}
      className="rounded border border-border bg-paper/40 p-4 scroll-mt-4"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <code className="font-mono text-sm text-foreground">{field.id}</code>
        <span className={`inline-flex items-center gap-1 text-[10.5px] ${layerMeta.tone}`}>
          <LayerIcon size={11} strokeWidth={1.75} />
          {layerMeta.label.toLowerCase()}
        </span>
        <span className="ml-auto"><SchemaInline schema={field.answer_schema} /></span>
      </div>

      {parsed.prompt && (
        <p className="mt-2 text-sm leading-relaxed text-foreground">
          {String(parsed.prompt)}
        </p>
      )}

      {(parsed.cardinality || parsed.time_window || parsed.group) && (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-muted-foreground">
          {parsed.cardinality && (
            <span>
              cardinality: <code className="font-mono">{String(parsed.cardinality)}</code>
            </span>
          )}
          {parsed.time_window && (
            <span>
              time_window: <code className="font-mono">{String(parsed.time_window)}</code>
            </span>
          )}
          {parsed.group && (
            <span>
              group: <code className="font-mono">{String(parsed.group)}</code>
            </span>
          )}
        </div>
      )}

      {field.is_applicable_when && (
        <div className="mt-3">
          <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            only ask this when
          </div>
          <div className="mt-1">
            <ExpressionWithRefs
              expr={field.is_applicable_when}
              fieldIds={fieldIds}
              tone="ochre"
              onSelect={onSelectField}
            />
          </div>
          {gateRefs.length > 0 && (
            <p className="mt-1 text-[10.5px] text-muted-foreground/80">
              depends on: {gateRefs.join(", ")}
            </p>
          )}
        </div>
      )}

      {field.derivation && (
        <div className="mt-3">
          <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            computed from
          </div>
          <div className="mt-1">
            <ExpressionWithRefs
              expr={field.derivation}
              fieldIds={fieldIds}
              tone="oxblood"
              onSelect={onSelectField}
            />
          </div>
          {derivRefs.length > 0 && (
            <p className="mt-1 text-[10.5px] text-muted-foreground/80">
              depends on: {derivRefs.join(", ")}
            </p>
          )}
        </div>
      )}

      {parsed.guidance_prose?.definition && (
        <div className="mt-3 text-sm">
          <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            Definition
          </div>
          <div className="mt-0.5 [&_p]:my-1">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {String(parsed.guidance_prose.definition)}
            </ReactMarkdown>
          </div>
        </div>
      )}

      {parsed.extraction_guidance && (
        <div className="mt-3 text-sm">
          <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            Where to look in the chart
          </div>
          <div className="mt-0.5 [&_p]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {String(parsed.extraction_guidance)}
            </ReactMarkdown>
          </div>
        </div>
      )}

      {parsed.guidance_prose?.examples && (
        <div className="mt-3 text-sm">
          <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            Examples
          </div>
          <pre className="mt-0.5 text-xs font-mono bg-card rounded p-2 whitespace-pre-wrap">
            {String(parsed.guidance_prose.examples)}
          </pre>
        </div>
      )}
    </div>
  );
}
