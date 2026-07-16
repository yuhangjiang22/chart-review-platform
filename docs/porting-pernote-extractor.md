# Porting the per-note annotation function to your server

How to equip a standalone / earlier-version platform with the note-level
phenotype extractor (`extractLabelsForNote`) from concur. This is the
"per-note annotation" engine: **one LLM round-trip per note**, returning for
each rubric field an answer (from the field's enum / a number / free text / an
entity list) plus a faithfulness-checked evidence quote and a rationale.

It is deliberately small and decoupled from the pilot / session / run
orchestration — you can lift it out and call it directly.

---

## 1. Where the code lives

| Piece | Path | Role |
|---|---|---|
| **`extractLabelsForNote`** (the function) | `packages/pipeline-extract-pernote/src/index.ts` | the per-note extractor + all parsing/grounding |
| `vaccine-classify.ts` | `packages/pipeline-extract-pernote/src/vaccine-classify.ts` | ACTS-only deterministic vaccine categorization (**optional** — skip unless you label vaccines) |
| `callLlm`, `LlmEndpoint`, `LlmMode` | `packages/pipeline-extract-ner/src/llm-call.ts` | the direct LLM transport (OpenRouter / Azure Responses) |
| `verifyEvidence`, `NoteEvidence` | `packages/faithfulness/src/index.ts` | quote-in-note check + offset auto-correction |
| `readNote` | `packages/patients/src/index.ts` | **the only corpus coupling — you replace this** |
| `CompiledTask` (type only) | `packages/tasks/src/index.ts` | the rubric shape it reads fields off |

So the transitive dependency set is just: **`pipeline-extract-pernote` →
{`pipeline-extract-ner` (callLlm), `faithfulness` (verifyEvidence),
`patients` (readNote), `tasks` (type)}**. No MCP, no deepagents, no server.

---

## 2. Interface

```ts
extractLabelsForNote(opts: {
  patientId: string;
  noteId: string;              // note key (concur strips ".txt")
  task: CompiledTask;          // your rubric — only `task.fields` is read
  endpoint: LlmEndpoint;       // { baseUrl, apiKey, model, mode }
  promptPreamble: string;      // the per-note SYSTEM prompt (see §6)
  vaccineCatalog?: VaccineCatalog;   // optional, ACTS vaccines only
  call?: typeof callLlm;       // injectable (tests)
}): Promise<{
  fields: Array<{
    field_id: string;
    answer?: string | number | EntityRecord[];   // absent = "not documented in this note"
    confidence?: "low" | "medium" | "high";
    evidence?: Array<{ source:"note"; note_id; span_offsets:[number,number]; verbatim_quote }>;
    rationale?: string;
    evidence_quote?: string;    // raw model quote before faithfulness resolution
  }>;
  usage?: { input_tokens?; output_tokens?; cached_input_tokens? };
  error?: string;              // set on read/LLM/parse failure; fields will be []
}>
```

**One call = one note.** You loop your own notes and call it per note.

---

## 3. What it does internally (so you trust the output)

1. `fieldsFromTask(task)` — pulls the **extractable leaf fields**: categorical
   (has `answer_schema.enum`), numeric (`type: integer|number`), free-text
   (`type: string`), or entity-list (`type: array`). **Fields with a
   `derivation` are skipped** — the model never labels a computed field; you
   recompute those from their leaves afterward.
2. Reads the note text (via `readNote` — see §5).
3. Builds a strict JSON user prompt (per-field type + allowed values + the note
   body) and calls the model once (`callLlm`), with a truncation retry that
   doubles the output budget (8192 → 16384 tokens).
4. Parses the JSON; for **each** field:
   - **Categorical/free-text:** resolves the model's `evidence_quote` against
     the note bytes (`resolveEvidence` → `verifyEvidence`). Quote truly absent →
     evidence dropped, answer kept (transparency, not fabrication).
   - **Numeric:** the value must appear **verbatim** in the note
     (`numericValueInNote`) or the answer is dropped to "not documented" — this
     is what stops the model returning a *computed* number (e.g.
     `duration = quit_age − start_age`) that the rubric forbids.
   - **Entity list (`array`):** one record per distinct item, each with its own
     `Supporting_Evidence`; each entity's evidence is resolved independently
     (anti-fabrication per item).
   - **Vaccines (ACTS only):** if `vaccineCatalog` is supplied, the vaccine's
     `Category`/`Disease` are re-assigned **deterministically from the CDC
     table**, overwriting the model's inline guess.

The faithfulness guarantee (offsets never fabricated; absent quotes dropped) is
the reason to reuse this rather than re-prompt yourself — keep it.

---

## 4. Minimal port recipe

1. Copy these source files into your server:
   - `pipeline-extract-pernote/src/index.ts`
   - `pipeline-extract-pernote/src/vaccine-classify.ts` *(only if labeling vaccines)*
   - `pipeline-extract-ner/src/llm-call.ts` (the `callLlm` + `LlmEndpoint` + `LlmMode`)
   - `faithfulness/src/index.ts` (the `verifyEvidence` + `NoteEvidence`)
2. Rewire the imports at the top of `index.ts` to your local paths.
3. **Replace the note source** (§5) — the only filesystem coupling.
4. Provide a **rubric object** shaped like `CompiledTask.fields` (§7). You do
   **not** need concur's task loader — a plain JSON object works.
5. Provide an **`LlmEndpoint`** with your model creds (§6).
6. Provide the **per-note prompt** string (§6).
7. Loop your notes → call `extractLabelsForNote` → persist `result.fields`
   however your platform stores annotations (§8).

---

## 5. The one thing you must replace: `readNote`

Note text is obtained in **two** places, both through the same function
`readNote(patientId, filename)` from `@chart-review/patients`:

- once at the top of `extractLabelsForNote` (to get the note body), and
- once inside `verifyEvidence` (to re-check each quote against the note bytes).

**So a single shim covers both.** Point `readNote` at your own note store:

```ts
// your @chart-review/patients replacement
export function readNote(patientId: string, filename: string): string {
  // filename is `${noteId}.txt` by concur convention; strip if you key differently
  const noteId = filename.replace(/\.txt$/, "");
  return myNoteStore.getText(patientId, noteId);   // DB row, S3 object, request body…
}
```

That is the entire filesystem decoupling. `resolveEvidence` and
`numericValueInNote` already operate on the passed-in text, so nothing else
touches disk.

*(Alternative if you prefer no shim: add a `noteText` field to the opts, use it
instead of the top-level `readNote`, and pass a text-based verify — but the
`readNote` shim is less invasive and keeps `verifyEvidence` unchanged.)*

---

## 6. LLM endpoint + prompt

```ts
const endpoint: LlmEndpoint = {
  baseUrl: process.env.LLM_BASE_URL!,   // e.g. https://openrouter.ai/api/v1
  apiKey:  process.env.LLM_API_KEY!,
  model:   "gpt-4o",                    // or your served model id
  mode:    "openrouter",                // "openrouter" (OpenAI /chat/completions) | "azure-responses"
};
```

- `mode: "openrouter"` → POSTs `${baseUrl}/chat/completions`, `Authorization:
  Bearer`, reads `choices[0].message.content`. Use this for any
  OpenAI-compatible server.
- `mode: "azure-responses"` → POSTs `${baseUrl}/responses`, `api-key` header,
  reads `output[].content[].text`. Use for Azure's Responses API.

**Prompt (`promptPreamble`)** = the per-note *system* prompt. In concur it is
`.claude/skills/chart-review-<task>/references/pernote_prompt.md`. Copy the one
for your phenotype (e.g. `chart-review-acts/references/pernote_prompt.md`) or
write your own. You do **not** build the user prompt — `buildUserPrompt()`
generates it (field list + enums + note text + the strict-JSON contract).

---

## 7. The rubric object (`task.fields`)

`extractLabelsForNote` only reads `task.fields`. Build a plain object:

```ts
const task = {
  fields: [
    // categorical leaf
    { field_id: "impaired_cognition", answer_schema: { enum: ["yes","no","no_info"] } },
    // numeric leaf (must appear verbatim in the note)
    { field_id: "moca_score", answer_schema: { type: "integer", minimum: 0, maximum: 30 } },
    // entity-list leaf
    { field_id: "allergen", answer_schema: {
        type: "array",
        entity: { value_key: "value", attributes: { Reaction: {} } } } },
    // derived field — INCLUDE it in your rubric but it is SKIPPED for extraction
    { field_id: "disease_extent", derivation: "…", answer_schema: { enum: [...] } },
  ],
} as CompiledTask;
```

Rules `fieldsFromTask` applies: `derivation` present → skipped; `enum` present →
categorical; `type` integer/number → numeric; `string` → free-text; `array` →
entity list; anything else → dropped.

---

## 8. Persisting results

Concur writes results via `writePerNoteAssessments` (domain-review) into
`review_state.note_answers` keyed by `noteId`. On your server, persist
`result.fields` in whatever shape you use — each field gives you
`{ field_id, answer, evidence:[{ note_id, span_offsets:[start,end],
verbatim_quote }], rationale, confidence }`. Offsets index into the note text
you supplied via `readNote`. Recompute any **derived** fields from the labeled
leaves yourself.

---

## 9. Smallest working loop

```ts
import { extractLabelsForNote } from "./pernote/index.js";

const endpoint = { baseUrl, apiKey, model: "gpt-4o", mode: "openrouter" } as const;
const task = { fields: [ /* §7 */ ] };
const promptPreamble = fs.readFileSync("pernote_prompt.md", "utf8");

for (const note of myNotes) {                 // note.patientId, note.id, note.text
  const r = await extractLabelsForNote({
    patientId: note.patientId, noteId: note.id, task, endpoint, promptPreamble,
  });
  if (r.error) { logError(note.id, r.error); continue; }
  for (const f of r.fields) {
    if (f.answer === undefined) continue;       // not documented in this note
    saveAnnotation(note.patientId, note.id, f); // your store
  }
}
```
(With the `readNote` shim from §5 returning `note.text`.)

## Gotchas

- **Only leaf fields are extracted.** Derived fields are recomputed, never asked.
- **Numeric grounding is strict** — a number not written in the note is dropped.
  If your rubric expects computed numerics, that guard will null them.
- **Truncation retry** doubles the token budget once; a still-truncated response
  returns an all-empty `fields` (not a false "nothing found") — check `r.error`.
- **Vaccines:** omit `vaccineCatalog` entirely unless you port the ACTS CDC
  tables (`vaccine-classify.ts` + the catalog loader).
