import { useEffect, useState } from "react";
import { authFetch } from "./auth";

interface Field {
  id: string;
  prompt?: string;
  group?: string;
  derivation?: string;
  is_applicable_when?: string;
  is_final_output?: boolean;
  answer_schema?: Record<string, unknown>;
}

interface CompiledTask {
  task_id: string;
  task_type?: string;
  manual_version?: string;
  source_document_sha: string;
  final_output?: string;
  overview_prose?: string;
  fields: Field[];
}

export function TaskView({ taskId }: { taskId: string }) {
  const [task, setTask] = useState<CompiledTask | null>(null);

  useEffect(() => {
    authFetch(`/api/tasks/${taskId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setTask);
  }, [taskId]);

  if (!task) {
    return (
      <div className="p-4 text-sm text-muted-foreground/70">
        Loading task <code>{taskId}</code>…
      </div>
    );
  }

  const fields = task.fields ?? [];
  const groups: Record<string, Field[]> = {};
  for (const f of fields) {
    const k = f.group ?? "ungrouped";
    (groups[k] ??= []).push(f);
  }

  return (
    <div className="p-4 overflow-auto bg-card">
      <header className="mb-3 pb-3 border-b border-border">
        <h3 className="font-semibold text-foreground text-base">
          {task.task_id}
        </h3>
        <div className="text-[11px] text-muted-foreground mt-1 flex gap-3 flex-wrap">
          {task.task_type && <span>type: {task.task_type}</span>}
          {task.manual_version && <span>manual: {task.manual_version}</span>}
          <span>{fields.length} fields</span>
          {task.final_output && (
            <span>
              final → <code>{task.final_output}</code>
            </span>
          )}
          <span title={task.source_document_sha}>
            sha: {task.source_document_sha.slice(0, 19)}…
          </span>
        </div>
        {task.overview_prose && (
          <p className="text-xs text-muted-foreground mt-2 whitespace-pre-wrap leading-relaxed">
            {task.overview_prose.split("\n").slice(0, 3).join(" ")}
          </p>
        )}
      </header>
      {Object.entries(groups).map(([group, fs]) => (
        <section key={group} className="mb-4">
          <h4 className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
            {group}
          </h4>
          <ul className="space-y-2">
            {fs.map((f) => (
              <FieldCard key={f.id} field={f} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function FieldCard({ field }: { field: Field }) {
  const kind = field.derivation
    ? "derived"
    : field.is_applicable_when
      ? "gated"
      : "leaf";
  const schema = describeSchema(field.answer_schema);
  return (
    <li className="border border-border rounded p-2 text-xs">
      <div className="flex items-center gap-2 flex-wrap">
        <code className="font-medium text-foreground text-[12px]">{field.id}</code>
        <span
          className={`px-1.5 py-0.5 rounded text-[10px] ${
            kind === "derived"
              ? "bg-purple-100 text-purple-700"
              : kind === "gated"
                ? "bg-[hsl(var(--ochre)/0.15)] text-[hsl(var(--ochre))]"
                : "bg-muted text-muted-foreground"
          }`}
        >
          {kind}
        </span>
        {field.is_final_output && (
          <span className="px-1.5 py-0.5 rounded bg-blue-100 text-foreground text-[10px]">
            final
          </span>
        )}
        <span className="text-muted-foreground">{schema}</span>
      </div>
      {field.prompt && (
        <p className="text-foreground mt-1">{field.prompt}</p>
      )}
      {field.is_applicable_when && (
        <p className="text-[hsl(var(--ochre))] mt-1 font-mono text-[11px]">
          only when: {field.is_applicable_when}
        </p>
      )}
      {field.derivation && (
        <p className="text-purple-700 mt-1 font-mono text-[11px] break-all">
          = {field.derivation}
        </p>
      )}
    </li>
  );
}

function describeSchema(s: unknown): string {
  if (!s || typeof s !== "object") return "";
  const obj = s as Record<string, unknown>;
  if (Array.isArray(obj.enum))
    return `enum: ${(obj.enum as string[]).join(" | ")}`;
  if (obj.type === "boolean") return "boolean";
  if (Array.isArray(obj.type)) return (obj.type as string[]).join(" | ");
  if (typeof obj.type === "string") return obj.type;
  return "";
}
