// guideline-logic — shared primitives for rendering a guideline as a
// dependency-aware logic flow (Inputs → Conditional → Computed → Final).
//
// Used by:
//   - GuidelineTab/index.tsx (the read-only "current guideline" view)
//   - builder/GuidelineDocumentView.tsx (the live draft preview inside Builder)
//
// Two consumers, same conventions:
//   - ochre = "this is a gating dependency" (is_applicable_when)
//   - oxblood = "this is a computation dependency" (derivation)

import {
  Calculator,
  CornerDownRight,
  Sparkles,
  TextCursorInput,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

/** Minimum surface a guideline criterion needs to expose for the layer
 *  classification + ref-extraction primitives below. Both the compiled
 *  CompiledField shape (from /api/tasks/<id>) and the YAML-parsed shape
 *  in the Builder satisfy this. */
export interface GuidelineLikeField {
  id: string;
  /** May be a plain DSL string OR the structured form `{kind, expr, ...}`
   *  used by newer skills (e.g. cha2ds2-vasc). Normalize via `exprStringOf`
   *  before treating as a string. */
  derivation?: unknown;
  is_applicable_when?: unknown;
  is_final_output?: boolean;
  answer_schema?: unknown;
}

/** Normalize a derivation / is_applicable_when value to its DSL expression
 *  string. Accepts:
 *    - `"a == b"`                          → `"a == b"`
 *    - `{ kind: "expression", expr: "a" }` → `"a"`
 *    - anything else (null, object w/o expr, number, …) → undefined
 *  This is the single source of truth — every consumer that treats the value
 *  as a string MUST go through it. */
export function exprStringOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const expr = (value as { expr?: unknown }).expr;
    if (typeof expr === "string") return expr;
  }
  return undefined;
}

export type LogicLayer = "input" | "conditional" | "computed" | "final";

export interface BucketedLayers<F extends GuidelineLikeField = GuidelineLikeField> {
  input: F[];
  conditional: F[];
  computed: F[];
  final: F[];
}

export interface UsageEntry {
  /** id of the criterion that references this one */
  via: string;
  /** whether the reference is in a gate (is_applicable_when) or in a derivation */
  role: "gate" | "derivation";
}

export const LAYER_ORDER: LogicLayer[] = ["input", "conditional", "computed", "final"];

export const LAYER_META: Record<LogicLayer, {
  label: string;
  caption: string;
  icon: LucideIcon;
  tone: string;
}> = {
  input: {
    label: "Inputs",
    caption: "Read directly from the chart. No prerequisites.",
    icon: TextCursorInput,
    tone: "text-foreground",
  },
  conditional: {
    label: "Conditional inputs",
    caption: "Asked only when their gate evaluates true.",
    icon: CornerDownRight,
    tone: "text-[hsl(var(--ochre))]",
  },
  computed: {
    label: "Computed",
    caption: "Combined from earlier criteria — no chart reading.",
    icon: Calculator,
    tone: "text-[hsl(var(--oxblood))]",
  },
  final: {
    label: "Final output",
    caption: "The phenotype label this guideline produces.",
    icon: Sparkles,
    tone: "text-[hsl(var(--sage))]",
  },
};

export function classifyField(field: GuidelineLikeField): LogicLayer {
  if (field.is_final_output) return "final";
  if (field.derivation) return "computed";
  if (field.is_applicable_when) return "conditional";
  return "input";
}

export function bucketByLayer<F extends GuidelineLikeField>(fields: F[]): BucketedLayers<F> {
  const out: BucketedLayers<F> = { input: [], conditional: [], computed: [], final: [] };
  for (const f of fields) out[classifyField(f)].push(f);
  for (const k of LAYER_ORDER) {
    out[k].sort((a, b) => a.id.localeCompare(b.id));
  }
  return out;
}

/** Pull every snake_case token out of an expression that matches a known
 *  field id. Tokens that don't match (operators, literal strings, numbers,
 *  enum values) are ignored. */
export function extractRefs(
  expr: unknown,
  validIds: Set<string>,
): string[] {
  const s = exprStringOf(expr);
  if (!s) return [];
  const seen = new Set<string>();
  const tokens = s.match(/\b[a-z][a-z0-9_]*\b/g) ?? [];
  for (const t of tokens) {
    if (validIds.has(t)) seen.add(t);
  }
  return [...seen];
}

/** For each criterion, the list of OTHER criteria that reference it (with
 *  the reference role). Used to render the "Used by" section. */
export function buildUsageMap(
  fields: GuidelineLikeField[],
  validIds: Set<string>,
): Map<string, UsageEntry[]> {
  const m = new Map<string, UsageEntry[]>();
  function record(target: string, entry: UsageEntry) {
    const existing = m.get(target);
    if (existing) existing.push(entry);
    else m.set(target, [entry]);
  }
  for (const f of fields) {
    for (const ref of extractRefs(f.is_applicable_when, validIds)) {
      if (ref !== f.id) record(ref, { via: f.id, role: "gate" });
    }
    for (const ref of extractRefs(f.derivation, validIds)) {
      if (ref !== f.id) record(ref, { via: f.id, role: "derivation" });
    }
  }
  return m;
}

// ─── Render primitives ───────────────────────────────────────────────────

/** Tiny clickable chip for a field id reference. Stops propagation so a
 *  chip click doesn't bubble through to a parent row's click handler. */
export function FieldChip({
  id,
  tone,
  onSelect,
}: {
  id: string;
  tone: "ochre" | "oxblood";
  onSelect: (id: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onSelect(id);
      }}
      className={cn(
        "rounded-sm border px-1.5 py-0.5 font-mono text-[10.5px] transition-colors",
        tone === "ochre"
          ? "border-[hsl(var(--ochre))]/40 bg-[hsl(var(--ochre))]/10 text-[hsl(var(--ochre))] hover:bg-[hsl(var(--ochre))]/15"
          : "border-[hsl(var(--oxblood))]/40 bg-[hsl(var(--oxblood))]/10 text-[hsl(var(--oxblood))] hover:bg-[hsl(var(--oxblood))]/15",
      )}
    >
      {id}
    </button>
  );
}

/** Render a derivation/gate expression with field-id tokens turned into
 *  clickable chips. Non-id tokens (operators, literals, parens) stay as
 *  plain text so the structure of the expression remains readable. */
export function ExpressionWithRefs({
  expr,
  fieldIds,
  tone,
  onSelect,
}: {
  expr: unknown;
  fieldIds: Set<string>;
  tone: "ochre" | "oxblood";
  onSelect: (id: string) => void;
}) {
  const s = exprStringOf(expr);
  if (!s) return null;
  const re = /\b[a-z][a-z0-9_]*\b/g;
  const parts: Array<{ kind: "ref" | "text"; value: string }> = [];
  let last = 0;
  for (const m of s.matchAll(re)) {
    if (m.index! > last) parts.push({ kind: "text", value: s.slice(last, m.index!) });
    if (fieldIds.has(m[0])) parts.push({ kind: "ref", value: m[0] });
    else parts.push({ kind: "text", value: m[0] });
    last = m.index! + m[0].length;
  }
  if (last < s.length) parts.push({ kind: "text", value: s.slice(last) });

  return (
    <code
      className={cn(
        "block whitespace-pre-wrap rounded-sm bg-paper px-3 py-2 font-mono text-[11.5px]",
        tone === "ochre" ? "text-[hsl(var(--ochre))]" : "text-[hsl(var(--oxblood))]",
      )}
    >
      {parts.map((p, i) =>
        p.kind === "ref" ? (
          <FieldChip key={i} id={p.value} tone={tone} onSelect={onSelect} />
        ) : (
          <span key={i}>{p.value}</span>
        ),
      )}
    </code>
  );
}

/** One-line summary of an answer schema (e.g. `[yes | no | unknown]` or
 *  `boolean`). Returns null when there's nothing structured to show. */
export function SchemaInline({ schema }: { schema: unknown }) {
  if (!schema || typeof schema !== "object") return null;
  const obj = schema as Record<string, unknown>;
  if (Array.isArray(obj.enum)) {
    return (
      <code className="font-mono text-[10.5px] text-muted-foreground">
        [{obj.enum.map(String).join(" | ")}]
      </code>
    );
  }
  const type = Array.isArray(obj.type) ? obj.type.join(" | ") : obj.type;
  if (!type) return null;
  return (
    <code className="font-mono text-[10.5px] text-muted-foreground">{String(type)}</code>
  );
}
