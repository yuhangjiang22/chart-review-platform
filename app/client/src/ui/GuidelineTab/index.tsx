import { useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  BookOpen,
  GitCommitHorizontal,
} from "lucide-react";
import { authFetch } from "../../auth";
import { Markdown } from "../../markdown";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { EmptyHint, FigurePage, FigureStats, Stat } from "../figure-primitives";
import {
  bucketByLayer,
  buildUsageMap,
  classifyField,
  ExpressionWithRefs,
  exprStringOf,
  extractRefs,
  FieldChip,
  LAYER_META,
  LAYER_ORDER,
  SchemaInline,
  type BucketedLayers,
  type UsageEntry,
} from "../guideline-logic";

interface GuidelineField {
  id: string;
  prompt?: string;
  answer_schema?: unknown;
  cardinality?: string;
  time_window?: string;
  /** May be a plain DSL string OR `{kind, expr, ...}`. Normalize via
   *  `exprStringOf` before treating as a string. */
  derivation?: unknown;
  is_applicable_when?: unknown;
  is_final_output?: boolean;
  extraction_guidance?: string;
  group?: string;
  guidance_prose?: Record<string, string>;
}

interface GuidelineTask {
  task_id: string;
  task_type?: string;
  review_unit?: string;
  manual_version?: string;
  source_document_sha?: string;
  index_anchor?: string;
  time_windows?: Array<{
    id: string;
    anchor?: string;
    start_offset?: string;
    end_offset?: string;
  }>;
  final_output?: string;
  overview_prose?: string;
  fields: GuidelineField[];
}

interface GuidelineMaturity {
  state?: string;
  transitions?: Array<{ state?: string; at?: string; by?: string; reason?: string }>;
}

export function GuidelineFigure({
  taskId,
}: {
  taskId: string;
}) {
  const [task, setTask] = useState<GuidelineTask | null>(null);
  const [sha, setSha] = useState<string | null>(null);
  const [maturity, setMaturity] = useState<GuidelineMaturity | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      authFetch(`/api/tasks/${encodeURIComponent(taskId)}`).then((r) => (r.ok ? r.json() : null)),
      authFetch(`/api/guidelines/${encodeURIComponent(taskId)}/sha`).then((r) => (r.ok ? r.json() : null)),
      authFetch(`/api/guidelines/${encodeURIComponent(taskId)}/maturity`).then((r) => (r.ok ? r.json() : null)),
    ])
      .then(([taskBody, shaBody, maturityBody]) => {
        if (cancelled) return;
        setTask(taskBody);
        setSha(shaBody?.sha ?? null);
        setMaturity(maturityBody);
        const fields = taskBody?.fields ?? [];
        setSelectedId((current) => current ?? fields.find((f: GuidelineField) => !f.derivation)?.id ?? fields[0]?.id ?? null);
      })
      .catch(() => {
        if (!cancelled) {
          setTask(null);
          setSha(null);
          setMaturity(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  useEffect(() => {
    function onSelectCriterion(event: Event) {
      const fieldId = (event as CustomEvent<{ fieldId?: string }>).detail?.fieldId;
      if (fieldId) setSelectedId(fieldId);
    }
    window.addEventListener("ui:select-guideline-criterion", onSelectCriterion);
    return () => window.removeEventListener("ui:select-guideline-criterion", onSelectCriterion);
  }, []);

  const fields = task?.fields ?? [];
  const selected = fields.find((f) => f.id === selectedId) ?? fields[0] ?? null;
  const leafCount = fields.filter((f) => !f.derivation).length;
  const derivedCount = fields.length - leafCount;
  const gatedCount = fields.filter((f) => !!f.is_applicable_when).length;

  // The set of valid field IDs is the alphabet for our reference parser:
  // a token in a derivation/gate expression that matches a field id is a
  // dependency.
  const fieldIds = useMemo(() => new Set(fields.map((f) => f.id)), [fields]);

  // Group criteria into the four logical layers shown in the flow view.
  const layers = useMemo(() => bucketByLayer(fields), [fields]);

  // For the "Used by" section: precompute, for each criterion, which other
  // criteria reference it (via gate or derivation).
  const usedBy = useMemo(() => buildUsageMap(fields, fieldIds), [fields, fieldIds]);

  return (
    <FigurePage
      caption="Guideline"
      title="Current review guideline"
    >
      <FigureStats>
        <Stat label="Criteria" value={String(fields.length)} accent={fields.length > 0} />
        <Stat label="Leaf / derived" value={`${leafCount} / ${derivedCount}`} mute />
        <Stat label="Maturity" value={maturity?.state ?? "—"} mute={maturity?.state !== "locked"} />
      </FigureStats>

      <Separator className="my-8" />

      {loading ? (
        <div className="text-[12px] italic text-muted-foreground">loading guideline…</div>
      ) : !task ? (
        <EmptyHint
          icon={BookOpen}
          title="Guideline not found"
          body={
            <>
              No compiled guideline exists for{" "}
              <code className="font-mono text-[10.5px]">{taskId}</code>.
            </>
          }
        />
      ) : (
        <div className="space-y-8">
          <GuidelineHeader
            task={task}
            sha={sha}
            gatedCount={gatedCount}
            maturityState={maturity?.state ?? null}
          />

          <LogicFlowSection
            layers={layers}
            selectedId={selected?.id ?? null}
            onSelect={setSelectedId}
            fieldIds={fieldIds}
          />

          <section>
            {selected ? (
              <CriterionDetail
                field={selected}
                finalOutput={task.final_output}
                fieldIds={fieldIds}
                usedBy={usedBy.get(selected.id) ?? []}
                onSelectField={setSelectedId}
              />
            ) : (
              <EmptyHint
                icon={BookOpen}
                title="No criteria"
                body="This guideline has metadata, but no criteria were returned by the compiled task endpoint."
              />
            )}
          </section>
        </div>
      )}
    </FigurePage>
  );
}

function GuidelineHeader({
  task,
  sha,
  gatedCount,
  maturityState,
}: {
  task: GuidelineTask;
  sha: string | null;
  gatedCount: number;
  maturityState: string | null;
}) {
  void maturityState;
  return (
    <header className="space-y-5">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
        <code className="font-mono text-[13px] text-foreground">{task.task_id}</code>
        {task.task_type && <Badge variant="outline" className="!text-[10px]">{task.task_type}</Badge>}
        {task.review_unit && <Badge variant="outline" className="!text-[10px]">{task.review_unit}</Badge>}
        {task.manual_version && (
          <span className="text-[11.5px] text-muted-foreground">manual {task.manual_version}</span>
        )}
        {sha && (
          <span className="inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground">
            <GitCommitHorizontal size={12} strokeWidth={1.75} />
            {sha.slice(0, 16)}
          </span>
        )}
      </div>

      {task.overview_prose && (
        <Markdown
          source={task.overview_prose}
          className="max-w-[84ch] text-[13px] leading-relaxed text-foreground [&_p]:my-2 [&_ul]:my-2 [&_li]:my-1"
        />
      )}

      <dl className="grid grid-cols-1 gap-x-8 gap-y-3 md:grid-cols-3">
        <MetaCell label="Final output">
          {task.final_output ? <code className="font-mono text-[12px]">{task.final_output}</code> : "—"}
        </MetaCell>
        <MetaCell label="Index anchor">
          {task.index_anchor ? <code className="font-mono text-[12px]">{task.index_anchor}</code> : "—"}
        </MetaCell>
        <MetaCell label="Gated criteria">
          <span className="font-mono text-[12px] tabular-nums">{gatedCount}</span>
        </MetaCell>
        {task.source_document_sha && (
          <div className="md:col-span-3">
            <dt className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              Source document SHA
            </dt>
            <dd className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
              {task.source_document_sha}
            </dd>
          </div>
        )}
      </dl>

      {task.time_windows && task.time_windows.length > 0 && (
        <div>
          <div className="mb-2 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            Time windows
          </div>
          <ol className="flex flex-wrap gap-2">
            {task.time_windows.map((tw) => (
              <li key={tw.id} className="rounded-md border border-border bg-card px-3 py-2 text-[11.5px]">
                <code className="font-mono text-foreground">{tw.id}</code>
                <span className="ml-2 text-muted-foreground">
                  {tw.anchor ?? "anchor"} {tw.start_offset ?? "?"} to {tw.end_offset ?? "?"}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </header>
  );
}

function MetaCell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-[12.5px] text-foreground">{children}</dd>
    </div>
  );
}

// ─── Layered logic-flow rendering (compact list, paired with detail pane) ──

function LogicFlowSection({
  layers,
  selectedId,
  onSelect,
  fieldIds,
}: {
  layers: BucketedLayers;
  selectedId: string | null;
  onSelect: (id: string) => void;
  fieldIds: Set<string>;
}) {
  return (
    <section className="rounded-md border border-border bg-card/50 p-4">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
        <ArrowDown size={12} strokeWidth={1.75} />
        Logic flow — top to bottom
      </div>
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
              <ol className="mt-2 space-y-1.5">
                {items.map((field) => (
                  <FlowRow
                    key={field.id}
                    field={field}
                    active={field.id === selectedId}
                    onSelect={onSelect}
                    fieldIds={fieldIds}
                  />
                ))}
              </ol>
              {idx < LAYER_ORDER.length - 1 && layers[LAYER_ORDER[idx + 1]].length > 0 && (
                <div className="mt-3 ml-1 h-3 border-l border-border/60" aria-hidden />
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function FlowRow({
  field,
  active,
  onSelect,
  fieldIds,
}: {
  field: GuidelineField;
  active: boolean;
  onSelect: (id: string) => void;
  fieldIds: Set<string>;
}) {
  const gateRefs = extractRefs(field.is_applicable_when, fieldIds);
  const derivRefs = extractRefs(field.derivation, fieldIds);
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(field.id)}
        className={cn(
          "w-full rounded-md border px-3 py-2 text-left transition-colors",
          active
            ? "border-[hsl(var(--oxblood))]/50 bg-[hsl(var(--oxblood))]/5"
            : "border-border bg-card hover:border-border/90 hover:bg-muted/20",
        )}
      >
        <div className="flex min-w-0 items-baseline gap-2">
          <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground">
            {field.id}
          </code>
          <SchemaInline schema={field.answer_schema} />
        </div>
        {field.prompt && (
          <div className="mt-1 line-clamp-2 text-[11.5px] leading-relaxed text-muted-foreground">
            {field.prompt}
          </div>
        )}
        {gateRefs.length > 0 && (
          <div className="mt-1.5 flex flex-wrap items-baseline gap-1.5 text-[11px]">
            <span className="text-muted-foreground/80">only when</span>
            {gateRefs.map((id) => (
              <FieldChip
                key={id}
                id={id}
                tone="ochre"
                onSelect={(target) => onSelect(target)}
              />
            ))}
          </div>
        )}
        {derivRefs.length > 0 && (
          <div className="mt-1.5 flex flex-wrap items-baseline gap-1.5 text-[11px]">
            <span className="text-muted-foreground/80">from</span>
            {derivRefs.map((id) => (
              <FieldChip
                key={id}
                id={id}
                tone="oxblood"
                onSelect={(target) => onSelect(target)}
              />
            ))}
          </div>
        )}
      </button>
    </li>
  );
}

function CriterionDetail({
  field,
  finalOutput,
  fieldIds,
  usedBy,
  onSelectField,
}: {
  field: GuidelineField;
  finalOutput?: string;
  fieldIds: Set<string>;
  usedBy: UsageEntry[];
  onSelectField: (id: string) => void;
}) {
  const guidanceEntries = Object.entries(field.guidance_prose ?? {}).filter(([, v]) => String(v).trim());
  const layer = classifyField(field);
  const layerMeta = LAYER_META[layer];
  const LayerIcon = layerMeta.icon;

  return (
    <article className="rounded-md border border-border bg-card">
      <header className="border-b border-border px-5 py-4">
        <div className="flex flex-wrap items-baseline gap-2">
          <code className="font-mono text-[13px] text-foreground">{field.id}</code>
          <span className={cn("inline-flex items-center gap-1 text-[10.5px]", layerMeta.tone)}>
            <LayerIcon size={11} strokeWidth={1.75} />
            {layerMeta.label.toLowerCase()}
          </span>
          {field.id === finalOutput && (
            <Badge variant="validated" className="!text-[10px]">final output</Badge>
          )}
        </div>
        {field.prompt && (
          <p className="mt-2 text-[14px] leading-relaxed text-foreground">{field.prompt}</p>
        )}
      </header>

      <div className="space-y-5 px-5 py-5">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <DetailBlock label="Answer schema">
            <SchemaPreview schema={field.answer_schema} />
          </DetailBlock>
          <DetailBlock label="Scope">
            <div className="space-y-1 font-mono text-[11.5px] text-muted-foreground">
              <div>group: {field.group ?? "ungrouped"}</div>
              <div>cardinality: {field.cardinality ?? "single"}</div>
              <div>time_window: {field.time_window ?? "—"}</div>
            </div>
          </DetailBlock>
        </div>

        {exprStringOf(field.is_applicable_when) && (
          <DetailBlock label="Applicability gate · only ask this when">
            <ExpressionWithRefs
              expr={field.is_applicable_when}
              fieldIds={fieldIds}
              tone="ochre"
              onSelect={onSelectField}
            />
          </DetailBlock>
        )}

        {exprStringOf(field.derivation) && (
          <DetailBlock label="Derivation · computed from">
            <ExpressionWithRefs
              expr={field.derivation}
              fieldIds={fieldIds}
              tone="oxblood"
              onSelect={onSelectField}
            />
          </DetailBlock>
        )}

        {usedBy.length > 0 && (
          <DetailBlock label="Used by">
            <div className="flex flex-wrap gap-1.5">
              {usedBy.map((u) => (
                <FieldChip
                  key={`${u.via}-${u.role}`}
                  id={u.via}
                  tone={u.role === "gate" ? "ochre" : "oxblood"}
                  onSelect={onSelectField}
                />
              ))}
            </div>
            <p className="mt-1.5 text-[10.5px] text-muted-foreground/80">
              <span className="text-[hsl(var(--ochre))]">ochre</span> = used as a gate ·{" "}
              <span className="text-[hsl(var(--oxblood))]">oxblood</span> = used in a derivation
            </p>
          </DetailBlock>
        )}

        {field.extraction_guidance && (
          <DetailBlock label="Extraction guidance">
            <Markdown
              source={field.extraction_guidance}
              className="text-[12.5px] leading-relaxed text-foreground [&_p]:my-2 [&_ul]:my-2"
            />
          </DetailBlock>
        )}

        {guidanceEntries.map(([key, value]) => (
          <DetailBlock key={key} label={key.replace(/_/g, " ")}>
            <Markdown
              source={String(value)}
              className="text-[12.5px] leading-relaxed text-foreground [&_p]:my-2 [&_ul]:my-2"
            />
          </DetailBlock>
        ))}
      </div>
    </article>
  );
}

function DetailBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-1.5 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </div>
      {children}
    </section>
  );
}

function SchemaPreview({ schema }: { schema: unknown }) {
  if (!schema || typeof schema !== "object") {
    return <span className="text-[12px] text-muted-foreground">No schema declared.</span>;
  }
  const obj = schema as Record<string, unknown>;
  if (Array.isArray(obj.enum)) {
    return (
      <div className="flex flex-wrap gap-1.5">
        {obj.enum.map((v) => (
          <code key={String(v)} className="rounded-sm bg-paper px-1.5 py-0.5 font-mono text-[11px]">
            {String(v)}
          </code>
        ))}
      </div>
    );
  }
  const type = Array.isArray(obj.type) ? obj.type.join(" | ") : obj.type;
  return (
    <pre className="max-h-48 overflow-auto rounded-sm bg-paper px-3 py-2 text-[11.5px] leading-relaxed">
      {type ? `type: ${String(type)}` : JSON.stringify(schema, null, 2)}
    </pre>
  );
}
