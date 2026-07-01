# Native reviewer UI in the VALIDATE tab for bso-ad-ner-sdk

**Date:** 2026-07-01
**Status:** design — approved in brainstorming, not yet implemented
**Scope:** Replace the platform's default VALIDATE surface for `bso-ad-ner-sdk` with a native, platform-styled port of the benchmark **reviewer** annotation flow (the reviewer role only — not adjudicator/maintainer), single reviewer, no second user. Retire the "Open annotate UI" new-tab button.

> **STANDING INSTRUCTION — DO NOT COMMIT.** All changes stay local.

## Why

The platform's VALIDATE tab differs from the benchmark's reviewer annotation UX. Rather than open the separate workbench app (:18090, different styling) in a new tab, embed the reviewer flow **natively in the VALIDATE tab**, styled to match the platform (fonts + colors), single-reviewer. This makes VALIDATE for bso-ad-ner-sdk *be* the reviewer experience.

## Decisions (brainstorming, 2026-07-01)

1. **Bridge = thin Python CLI + shell (Option A):** a new vendored `review_op.py` exposes `next`/`submit`, wrapping the vendored `claude_agent.review.cli_review` functions. Platform routes shell to it per operation. Reuses the exact benchmark logic — zero drift. (~200ms/op; fine for one-mention-at-a-time review.)
2. **VALIDATE tab goes native:** the reviewer UI lives in the platform's VALIDATE phase (NER-gated), styled with platform components. Remove the "Open annotate UI" new-tab button and the annotate route's workbench-launch. The :18090 workbench is no longer part of this flow.
3. **Reviewer role only, single reviewer, no 2nd user:** `reviewer_id` fixed to `reviewer_1`. No adjudicator/maintainer, no IAA/adjudication surfaces.

## Verified facts (2026-07-01)

- Reviewer data model: batch `mentions.jsonl` (input) + `verdicts/<reviewer>.jsonl` (append-only output). `cli_review`:
  - `next_pending_mention(batch_dir, reviewer_id) -> MentionRecord | None` (first mention with no live verdict; None = done).
  - `build_simple_verdict(mention, reviewer_id, verdict_kind, notes, review_duration_ms, reviewed_at)` for `_SIMPLE_VERDICTS` (confirm, reject_not_entity, reject_duplicate, concept_name_novel, …).
  - `build_correction_verdict(mention, reviewer_id, kind, new_value, notes, review_duration_ms, reviewed_at)` — `kind` ∈ {concept, type, span}; `new_value` is a str for concept/type.
  - `submit_verdict(batch_dir, verdict)` — append; refuses duplicate live verdict (use `amend`).
  - `progress_string(batch_dir, reviewer_id)`.
- `MentionRecord`: `mention_id, note_id, person_id, text, anchor, start, end, entity_type, concept_name, status, match_kind, model, skill_version, ontology_version`.
- `VerdictKind` (schema): confirm / correct_concept / correct_type / correct_span / reject_not_entity / reject_duplicate / concept_name_novel / propose_split / propose_merge.
- Batch built by the vendored `batch_init.py` (already wired in the annotate route W2, incl. `--include-note-id` to skip status.json). Batch dir: `var/annotate/review/batches/<session_id>/`.
- Corpus note text for the highlight: `corpus/patients/patient_real_<person_id>/notes/<note_id>.txt`.
- Platform route pattern (`RouteEntry[]`, handler `(body, req, params, query)`, throw `Error & {status}`, register in `server/index.ts`). `PhaseValidate` is a shared component with a `taskKind?` prop (currently typed `"phenotype"`; widen to include `"ner"`), NER-gated early return like the PhaseTry change already in place.

## Architecture

```
VALIDATE tab (bso-ad-ner-sdk)                server                                   vendored python (cwd=vendor/bso-ad-sdk)
─────────────────────────────                ──────                                   ──────────────────────────────────────
<NativeReviewerPanel>
  GET next mention  ── GET ──▶  /api/ner-sdk/review/next?session_id=…
                                   │ ensure batch (batch_init if missing)
                                   │ shell: python3 pipeline/review_op.py next
                                   │          --batch-dir var/annotate/review/batches/<s> --reviewer reviewer_1
                                   │ attach note_text from corpus (person_id, note_id)
                                   ◀── { mention, note_text, progress:"X/N", done }
  render note + highlight(start,end) + concept/entity_type + actions
  [Confirm] [Reject▾] [Correct concept] [Mark novel]
  submit verdict   ── POST ─▶  /api/ner-sdk/review/verdict {session_id, mention_id, kind, new_value?, notes?}
                                   │ shell: python3 pipeline/review_op.py submit
                                   │          --batch-dir … --reviewer reviewer_1 --mention-id … --kind … [--new-value …] [--notes …]
                                   ◀── { ok:true }
  → auto-advance (GET next)
```

### Components

1. **`vendor/bso-ad-sdk/pipeline/review_op.py` (create, new thin CLI)** — stateless, JSON-on-stdout, wraps `cli_review`:
   - `next --batch-dir <dir> --reviewer <id>`: `m = next_pending_mention(...)`; print `{"done": m is None, "progress": progress_string(...), "mention": m.model_dump() if m else null}`.
   - `submit --batch-dir <dir> --reviewer <id> --mention-id <id> --kind <k> [--new-value <v>] [--notes <t>] [--duration-ms <n>]`: re-locate the mention by id (iterate mentions), build the verdict — simple kinds via `build_simple_verdict`; `correct_concept` via `build_correction_verdict(kind="concept", new_value=<v>)` — then `submit_verdict(...)`; print `{"ok": true}`. `reviewed_at` = now (ISO).
   - Mirrors the `sys.path.insert(parent.parent)` the other vendored pipeline scripts use so `claude_agent` resolves.

2. **`server/ner-sdk-review-routes.ts` (create)** — `export const nerSdkReviewRoutes: RouteEntry[]`:
   - `GET /api/ner-sdk/review/next` (query `session_id`): validate id; batchDir = `var/annotate/review/batches/<session_id>`; if missing, build it (reuse the notes-CSV + `batch_init` logic — factor a shared `ensureBatch(sessionId)` helper, moved out of the annotate route). `spawnSync` `review_op.py next`; parse JSON; if a mention is returned, read its note text from `corpus/patients/patient_real_<person_id>/notes/<note_id>.txt` and attach as `note_text`. Return `{ mention, note_text, progress, done }`.
   - `POST /api/ner-sdk/review/verdict` (body `{ session_id, mention_id, kind, new_value?, notes? }`): validate; `spawnSync` `review_op.py submit` with the args; return the parsed `{ ok }` or a 500 with stderr on failure.
   - `reviewer_id` constant `reviewer_1`. Register in `server/index.ts`.

3. **`client/src/ui/Workspace/NativeReviewerPanel.tsx` (create)** — the reviewer UI:
   - State: current `mention`, `noteText`, `progress`, `done`, `busy`, `error`, and a `correcting` toggle with a concept input.
   - Fetches `GET …/review/next`. Renders: progress `X / N`; the note text with the `[start,end)` span highlighted (slice the note into before / span / after; highlight the middle); a header with `entity_type` + `concept_name` (+ `status`/`match_kind` as muted metadata).
   - Actions (platform `<Button>`s): **Confirm** (`kind:"confirm"`), **Reject** with a small menu → `reject_not_entity` / `reject_duplicate`, **Correct concept** (reveals a text input → submit `kind:"correct_concept", new_value:<input>`), **Mark novel** (`kind:"concept_name_novel"`). Each POSTs the verdict, then re-fetches next.
   - `done` state: "All N mentions reviewed" + a "Re-review" affordance is out of scope (verdicts are append-only; amend deferred).
   - Styling: uses the same `@/components/ui/*` + Tailwind tokens the other Workspace panels use (font + color parity is automatic via shared components/tokens).

4. **`PhaseValidate.tsx` (modify)** — widen `taskKind?` to `"phenotype" | "ner"`; add an early NER-gated return rendering `<NativeReviewerPanel sessionId={…} />` (mirrors the PhaseTry NER gate). Non-NER path unchanged. `client/src/ui/Workspace/index.tsx` already passes an NER-aware `taskKind` to phase components (as done for PhaseTry) — confirm PhaseValidate gets `task?.task_type === "ner" ? "ner" : "phenotype"`.

5. **Retire the new-tab hook:** remove the "Open annotate UI" button from `NerSdkRunPanel.tsx`; drop the workbench-launch from `server/ner-sdk-annotate-routes.ts` (keep/rename its batch-build as the shared `ensureBatch` helper the review route uses, or delete the route if `ensureBatch` moves into the review route). The `pipeline/workbench.py` vendor file may stay (unused) — not deleted, just not launched.

## Boundaries / non-goals

- Only `bso-ad-ner-sdk` (NER-gated). Phenotype/adherence VALIDATE untouched; `PhaseValidate` non-NER path unchanged.
- Reviewer role only. No adjudicator/maintainer, no IAA/gold/adjudication UI, no second reviewer (fixed `reviewer_1`).
- MVP verdicts: confirm / reject_not_entity / reject_duplicate / correct_concept / concept_name_novel. `correct_type`, `correct_span`, `propose_split/merge`, and verdict amend/undo are deferred.
- No live multi-user; one reviewer, append-only verdicts.

## Testing

- **review_op.py:** on the `session_001` batch — `next` returns a mention JSON + `progress "0/33"` + `done:false`; after a `submit --kind confirm`, `next` advances (progress `1/33`); an invalid `--kind` errors cleanly; `next` at end → `done:true`.
- **Routes:** `GET /api/ner-sdk/review/next?session_id=session_001` → `{mention, note_text, progress, done}` with `note_text` non-empty and `note_text.slice(start,end) === mention.text` (offset faithfulness); `POST …/verdict` with `kind:"confirm"` → `{ok:true}` and the next GET advances; bad session → 400.
- **Frontend:** NER VALIDATE renders the reviewer panel (not the default span review); the highlighted slice matches `mention.text`; each action advances; `done` shows the completion state. Non-NER VALIDATE unchanged (a phenotype task still shows its normal validate UI).
- **Retirement:** the "Open annotate UI" button no longer renders; NerSdkRunPanel on complete shows only "Run again".

## Self-review

- Placeholders: none — cli_review signatures, verdict kinds, MentionRecord fields, batch/corpus paths, route shapes, component actions all concrete.
- Consistency: batch dir `var/annotate/review/batches/<session>`, reviewer `reviewer_1`, `correct_concept`→`build_correction_verdict(kind="concept")`, NER-gate mirrors PhaseTry — consistent.
- Scope: reviewer-only, single-user, MVP verdict set; adjudicator/maintainer/amend deferred; retirement of the new-tab hook explicit.
- Ambiguity: verdict kind mapping (simple vs correction) pinned in review_op.py; note-text highlight via `[start,end)` slice pinned; `ensureBatch` reuse of batch_init pinned.
