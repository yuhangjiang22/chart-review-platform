# Increment 3 — NER task kind (MVP) for concur

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Add the NER task kind to concur (currently phenotype-only): run entity extraction on a patient and validate the spans. First task = a verbatim port of v2's **bso-ad-ner** (BSO-AD social-determinants ontology). Extraction runs on **OpenRouter** (concur's main path).

**Program context:** Increment 3 of extending concur → v2 (judge ✅, providers deferred). See `2026-06-11-judge-phase.md`. Port FROM v2; concur shares v2's package lineage so most types already exist.

**Design (from the v2 NER study):**
- Batch NER = `extractSpansDirect` (direct 2-pass LLM call per note: identify spans → normalize each to an ontology concept). **No NER MCP server needed for the MVP** — the extractor reads the ontology + notes from disk and writes spans via `setSpanLabel`/`persistState` helpers.
- v2's extractor is hard-shaped for Azure's **Responses API** (`/responses`, `api-key` header, `input` messages). concur runs on **OpenRouter** → add an OpenAI **`/chat/completions`** path (`Authorization: Bearer`, `messages`, `choices[0].message.content`).
- **Already in concur:** `ReviewState.span_labels` / `task_kind:"ner"` / `validated_notes` union; generic span routes (PATCH/DELETE `/spans/:spanId`, POST `/notes/:noteId/validation`). **Must add:** the packages, the run-loop NER branch, the task bundle + a test patient, the SpanReview UI + routing.
- **MVP scope.** Deferred: NER MCP server stack, ner-calibration-routes + NerCalibrationFigure, span-stats, ner-{judge,calibrate,methods,cohort} skills, inline note highlighting.

**Reference (v2):** `packages/pipeline-extract-ner/src/{direct-llm-extract,normalize-span,index}.ts`, `packages/mcp-core-ner/src/index.ts` (helpers), `client/src/ui/SpanReview.tsx`, `.agents/skills/chart-review-{ner,bso-ad-ner}/`, run loop `packages/infra-batch-run/src/runs.ts:903-1266`.

---

## Task N1: Port NER packages + add the OpenRouter LLM adapter

**Files:** Create `packages/mcp-core-ner/`, `packages/pipeline-extract-ner/` in concur (copy from v2); add a shared LLM-call helper.

- [ ] **Step 1 — copy** `packages/mcp-core-ner/` and `packages/pipeline-extract-ner/` from v2 into concur. Add them to the workspace (root `package.json` workspaces + each one's deps). `@chart-review/platform-types` already has `SpanLabel` in concur — confirm; if not, port the `SpanLabel` interface.
- [ ] **Step 2 — keep only what the batch path needs** from `mcp-core-ner`: `setSpanLabel`, `readOrInitState`, `persistState`, `hashSpan`, `NerMcpSession`, `statePath`. (The MVP doesn't run the MCP server; these are the disk-write helpers `extractSpansDirect` calls.)
- [ ] **Step 3 — add the OpenRouter LLM adapter.** In `pipeline-extract-ner`, both `direct-llm-extract.ts` (identification pass) and `normalize-span.ts` (per-span normalize) call the LLM. v2 hardcodes Azure Responses (`${baseUrl}/responses`, `api-key`, `input:[{role,content:[{type:"input_text",text}]}]`, `max_output_tokens`, response `output[].content[].text`). Extract a shared helper:
  ```ts
  // llm-call.ts
  export type LlmEndpoint = { baseUrl: string; apiKey: string; model: string; mode: "openrouter" | "azure-responses" };
  export async function callLlm(ep: LlmEndpoint, system: string, user: string, maxTokens=4096): Promise<{text: string; usage?: any}> {
    if (ep.mode === "azure-responses") { /* v2's /responses shape verbatim */ }
    // openrouter / OpenAI chat-completions:
    const r = await fetch(`${ep.baseUrl}/chat/completions`, {
      method:"POST",
      headers:{ "Authorization":`Bearer ${ep.apiKey}`, "Content-Type":"application/json" },
      body: JSON.stringify({ model: ep.model, messages:[{role:"system",content:system},{role:"user",content:user}], max_tokens: maxTokens }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`LLM ${r.status}: ${JSON.stringify(j).slice(0,200)}`);
    return { text: j.choices?.[0]?.message?.content ?? "", usage: j.usage };
  }
  ```
  Replace the inline fetch in both files with `callLlm(...)`. `extractSpansDirect`'s opts gain `mode` (default `"openrouter"`); `normalize-span` uses the same endpoint. Keep the existing JSON-parsing (sentinel/array extraction) downstream — only the transport changes.
- [ ] **Step 4 — typecheck** (`npm run typecheck`) → 0 in the new packages. (No run-loop wiring yet.)
- [ ] **Step 5 — commit** `feat(concur): port NER extract packages + OpenRouter LLM adapter`.

## Task N2: Run-loop NER branch

**Files:** Modify `packages/infra-batch-run/src/runs.ts` (mirror v2's `isNerTask` branch ~903/1194, adapted).

- [ ] **Step 1 — read** v2 `runs.ts:1194-1266` (the `else if (isNerTask)` block: per-note loop over `listNotes(patientId)`, `extractSpansDirect(...)`, fold `{spans_written,error}` into the loud-fail tally, write spans to scratch). concur's loud-fail tally lives in its `runs.ts` (per the judge work it has `applyAgentEventToTally`/classify? — confirm; if concur lacks loud-fail, treat NER per the simpler concur model).
- [ ] **Step 2 — add the branch** in concur's `runOneAgent` (~line 830, before/around the phenotype `runAgent` call): `const isNerTask = task.task_kind === "ner";` then `if (isNerTask) { …extract per note… } else { …existing runAgent… }`.
- [ ] **Step 3 — resolve the OpenRouter endpoint from the model registry.** The agent's `spec.model` is a `python/models.json` KEY. Read its entry via concur's `server/lib/model-registry.ts` reader (or read models.json) to get `{base_url (VLLM_BASE_URL), api_key (VLLM_API_KEY), model}`. Pass to `extractSpansDirect({ ..., baseUrl, apiKey, model, mode:"openrouter", ontologyPath: resolveOntologyPath(task), reviewsRoot: scratchRoot, sessionId, noteId, task })`. (Ontology path: port v2's `resolveOntologyPath` from `mcp-server-ner-anthropic`, or inline: `<guidelineDir(taskId)>/references/ontology/concepts.json`.)
- [ ] **Step 4 — promote** the scratch spans to the per-agent draft exactly like phenotype (the scratch `review_state.json` with `span_labels` → `agents/<id>.json`). Reuse the existing promote logic.
- [ ] **Step 5 — typecheck + commit** `feat(concur): run-loop NER branch (extractSpansDirect on OpenRouter)`.

## Task N3: Port the bso-ad-ner task bundle + chart-review-ner skill + a test patient

**Files:** Create `.agents/skills/chart-review-bso-ad-ner/` + `.agents/skills/chart-review-ner/`; add a BSO-AD test patient to `corpus/patients/`; register the task.

- [ ] **Step 1 — copy** v2's `.agents/skills/chart-review-bso-ad-ner/` verbatim (meta.yaml `task_kind: ner` + `ontology_pin`, `references/ontology/concepts.json`, `references/entity_type_guidance/*.yaml`) and `.agents/skills/chart-review-ner/` (universal skill). Note: for the direct-extract path the skill prose isn't strictly required (the prompt is inlined), but copy it for parity/agentic-future.
- [ ] **Step 2 — ontology path:** ensure the ontology resolves where `resolveOntologyPath`/the run-loop expects (`references/ontology/concepts.json` under the skill dir, or `var/ontologies/<pin>/` — match what Step N2 Step 3 uses; pick the skill-dir location to keep it self-contained).
- [ ] **Step 3 — test patient:** the cancer corpus won't exercise a social-determinants ontology. Copy a BSO-AD-appropriate patient from v2's corpus (e.g. `corpus/patients/patient_real_acts_01/`) into concur's `corpus/patients/`, OR pick a cancer patient whose notes mention demographics/behavior/SDOH (most discharge summaries do). Confirm the task loads (`GET /api/tasks` lists `bso-ad-ner`).
- [ ] **Step 4 — register** the task if concur uses a task registry/`tasks.yaml`; otherwise confirm task discovery picks up the new skill dir.
- [ ] **Step 5 — commit** `feat(concur): bso-ad-ner task bundle + universal NER skill + test patient`.

## Task N4: SpanReview UI + task_kind routing

**Files:** Create `client/src/ui/SpanReview.tsx` (port); modify the validate router (`PatientReview` / Workspace) to mount it for `task_kind === "ner"`.

- [ ] **Step 1 — port** `client/src/ui/SpanReview.tsx` from v2 (table grouped by note: text · anchor · entity_type · concept_name · status + Accept/Reject + inline concept edit + per-note "mark validated"). It uses the generic span routes (already in concur) + `withSession`? — concur's session scoping: confirm whether span routes need `session_id` (match concur's other review calls).
- [ ] **Step 2 — route to it:** find where concur renders the per-patient review surface (PatientReview for phenotype). Branch on the task's `task_kind`: `ner` → `<SpanReview>`, else the phenotype review. (v2 does this in PatientReview / PhaseValidate — mirror it.)
- [ ] **Step 3 — typecheck + `npm run build:client` + commit** `feat(concur): SpanReview pane + NER validate routing`.

## Task N5: End-to-end verification (run the app)

- [ ] `npm run typecheck` 0 · `npx vitest run` green · `npm run build:client` builds.
- [ ] Run locally (server :3002 + client :5174, sidecar already rebuilt). Create a session on **bso-ad-ner** with the test patient + 1 agent on an OpenRouter model.
- [ ] TRY → Start iter → the NER branch runs `extractSpansDirect` per note on OpenRouter → spans written to the draft. Confirm spans in `agents/<id>.json` (`span_labels[]` with entity_type + concept_name).
- [ ] VALIDATE → the patient opens in **SpanReview** → spans render grouped by note; Accept/Reject + mark-note-validated work (writes via the generic span routes).
- [ ] Confirm a 0-span note doesn't error (valid empty result), and that an LLM/endpoint error surfaces (not silent).

## Self-review
- OpenRouter adapter used by BOTH passes (identify + normalize); Azure mode retained behind `mode`.
- review_state union + span routes reused (not re-created).
- NER MCP server NOT introduced (MVP).
- One commit per task; trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`; no --no-verify.
