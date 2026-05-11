// chart-review form-gen adapter — uses v1's compiled task store.
//
// v1 already has the full machinery: methodologist hand-authors a
// markdown phenotype doc + per-criterion YAMLs under
// .claude/skills/chart-review-<task>/, the platform compiles them
// into a compiled_task.json that v1's `tasks.ts:loadCompiledTask`
// reads back as CompiledTask {fields: CompiledField[]}.
//
// The CompiledField shape already carries answer_schema, applicability,
// derivation, and schema_hash — exactly what v2's FormSpec needs.

import { createHash } from "node:crypto";
import type { FormGenModule, FormSpec, TaskSpec, CompiledField } from "../../shared/types.js";
import { loadCompiledTask } from "../../../chart-review-platform/app/server/tasks.js";

function hashField(f: CompiledField): string {
  // v1's CompiledField doesn't carry schema_hash directly; compute one
  // from its structural fields (mirror of v1's criterion-hash.ts).
  const payload = JSON.stringify({
    answer_schema: f.answer_schema ?? null,
    is_applicable_when: f.is_applicable_when ?? null,
    derivation: f.derivation ?? null,
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

export function makeChartReviewFormGen(): FormGenModule {
  return {
    async generate(spec: TaskSpec): Promise<FormSpec> {
      const compiled = loadCompiledTask(spec.task_id);
      if (!compiled) {
        throw new Error(
          `chart-review form-gen: no compiled task for ${spec.task_id}. ` +
          "Author the phenotype skill at .claude/skills/chart-review-<task>/ first.",
        );
      }
      return {
        task_id: compiled.task_id,
        schema_hash: combinedHash(compiled.fields.map((f) => hashField(f))),
        criteria: compiled.fields,
      };
    },
  };
}

function combinedHash(hashes: string[]): string {
  return createHash("sha256").update(hashes.join("|")).digest("hex").slice(0, 16);
}
