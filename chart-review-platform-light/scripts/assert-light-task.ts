import { loadCompiledTask } from "@chart-review/tasks";

const t = loadCompiledTask("lung-cancer-phenotype-light");
if (!t) throw new Error("task not found: lung-cancer-phenotype-light");
if (t.task_kind !== "phenotype") {
  throw new Error(`expected task_kind=phenotype, got ${t.task_kind}`);
}
const ids = t.fields.map((f: any) => f.field_id).sort();
const expected = ["cancer_type", "disease_extent"];
if (JSON.stringify(ids) !== JSON.stringify(expected)) {
  throw new Error(`unexpected fields: ${ids.join(",")}`);
}
for (const f of t.fields as any[]) {
  const enumVals = f.answer_schema?.enum;
  if (!Array.isArray(enumVals) || enumVals.length < 2) {
    throw new Error(`field ${f.field_id} missing answer_schema.enum`);
  }
}
console.log(
  "OK: lung-cancer-phenotype-light compiled with",
  ids.join(", "),
  "| task_kind=" + t.task_kind,
);
