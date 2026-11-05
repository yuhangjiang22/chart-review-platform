import { loadCompiledTask } from "@chart-review/tasks";
const t: any = loadCompiledTask("malo");
if (!t) { console.log("FAILED to load"); process.exit(1); }
console.log("task_id:", t.task_id, "| kind:", t.task_kind, "| uses_structured:", t.uses_structured_data);
console.log("fields:", t.fields.length);
const g: Record<string, number> = {};
for (const f of t.fields) g[f.group ?? "?"] = (g[f.group ?? "?"] || 0) + 1;
console.log("groups (criteria):", Object.keys(g).length);
console.log("missing prompt:", t.fields.filter((f: any) => !f.prompt).length,
            "| missing answer_schema:", t.fields.filter((f: any) => !f.answer_schema).length);
const ids = t.fields.map((f: any) => f.id);
console.log("duplicate field ids:", ids.length - new Set(ids).size);
console.log("sample:", JSON.stringify(t.fields[0]).slice(0, 240));
