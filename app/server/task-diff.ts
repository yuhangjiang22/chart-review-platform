export interface FieldDiff {
  field_id: string;
  status: "added" | "removed" | "changed" | "unchanged";
  changes?: Array<{ key: string; from: unknown; to: unknown }>;
}

export interface TaskDiff {
  from_sha: string;
  to_sha: string;
  fields: FieldDiff[];
  global_changes: Array<{ key: string; from: unknown; to: unknown }>;
}

const FIELD_KEYS_TO_DIFF = [
  "prompt",
  "guidance_prose",
  "answer_schema",
  "is_applicable_when",
  "derivation",
  "is_final_output",
  "requires_calibration",
];

const TASK_GLOBAL_KEYS_TO_DIFF = [
  "source_document_sha",
  "task_version",
  "review_unit",
  "stratify_by",
];

interface TaskShape {
  fields?: Array<Record<string, unknown> & { id: string }>;
  [k: string]: unknown;
}

export function computeTaskDiff(fromTask: unknown, toTask: unknown, fromSha = "", toSha = ""): TaskDiff {
  const from = (fromTask ?? {}) as TaskShape;
  const to = (toTask ?? {}) as TaskShape;

  const fromFields = new Map((from.fields ?? []).map((f) => [f.id, f]));
  const toFields = new Map((to.fields ?? []).map((f) => [f.id, f]));
  const allIds = new Set([...fromFields.keys(), ...toFields.keys()]);

  const fields: FieldDiff[] = [];
  for (const id of allIds) {
    const f = fromFields.get(id);
    const t = toFields.get(id);
    if (!f) {
      fields.push({ field_id: id, status: "added" });
    } else if (!t) {
      fields.push({ field_id: id, status: "removed" });
    } else {
      const changes: Array<{ key: string; from: unknown; to: unknown }> = [];
      for (const k of FIELD_KEYS_TO_DIFF) {
        const a = JSON.stringify(f[k]);
        const b = JSON.stringify(t[k]);
        if (a !== b) changes.push({ key: k, from: f[k], to: t[k] });
      }
      fields.push({
        field_id: id,
        status: changes.length === 0 ? "unchanged" : "changed",
        ...(changes.length > 0 && { changes }),
      });
    }
  }

  const global_changes: Array<{ key: string; from: unknown; to: unknown }> = [];
  for (const k of TASK_GLOBAL_KEYS_TO_DIFF) {
    const a = JSON.stringify(from[k]);
    const b = JSON.stringify(to[k]);
    if (a !== b) global_changes.push({ key: k, from: from[k], to: to[k] });
  }

  return { from_sha: fromSha, to_sha: toSha, fields, global_changes };
}
