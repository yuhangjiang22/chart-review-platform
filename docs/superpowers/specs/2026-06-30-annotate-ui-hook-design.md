# One-click hook to the benchmark annotate UI (Curation Workbench) for bso-ad-ner-sdk

**Date:** 2026-06-30
**Status:** design — approved in brainstorming, not yet implemented
**Scope:** Add a one-click "Open annotate UI" button to the bso-ad-ner-sdk run panel that opens the benchmark's **Curation Workbench** (the annotate UI the user prefers over the platform VALIDATE) on the current session's run. Fully vendored — no external benchmark repo dependency. Platform VALIDATE is kept (augment, not replace).

> **STANDING INSTRUCTION — DO NOT COMMIT.** All changes stay local.

## Why

The platform's VALIDATE phase differs from the benchmark's annotate UX. The benchmark ships a **Curation Workbench** (`pipeline/workbench.py`, FastAPI on :18090) — review + adjudicate + ontology in one app, the UI the user wants for annotating NER mentions. This adds a one-click hook from the platform NER tab to that workbench, on the bso-ad-ner-sdk run's results.

## Decisions (brainstorming, 2026-06-30)

1. **One-click button:** a platform button → `POST /api/ner-sdk/annotate` that builds the review batch + ensures the workbench is running, returns its URL; the frontend opens it in a new tab.
2. **Augment, not replace:** keep the platform VALIDATE; add an "Open annotate UI" button alongside (in the NER-SDK run panel / on run-complete).
3. **Vendored:** copy `pipeline/workbench.py` + `pipeline/batch_init.py` into `vendor/bso-ad-sdk/pipeline/` (their only deps are `claude_agent.review.*`, already vendored). No external benchmark dependency.

## Verified facts (2026-06-30)

- Annotate flow: per-note write_ner predictions → `batch_init` → `review/batches/<id>/` (manifest.json + mentions.jsonl) → workbench reads it.
- `init_batch(results_root, review_root, batch_id, reviewers, include_note_ids?, notes_csv?)` — **requires ≥2 reviewers** (`len(reviewers) < 2` raises); raises `FileExistsError` if the batch_id dir already exists.
- `_iter_ner_outputs` reads `results_root/predictions.json` OR (fallback) per-note `<note_id>.json` files. Our run writes per-note `<note_id>.json` under `var/benchmark-sdk/<session>/` → usable directly as `--results-root`.
- `workbench.py` args: `--batch`, `--review-root` (default `review`), `--ontology-root` (default `ontology`), `--results-ner-root` (default `results/ner`), `--host`; serves on :18090. Login is a cookie name-picker (no CLI reviewer needed). It imports only `claude_agent.review.*` + `uvicorn`/`fastapi` (all vendored/installed).
- `batch_init.py` / `workbench.py` have NO `pipeline.*` internal imports → copying the 2 files is sufficient.
- The run leaves 5 per-note prediction JSONs under `var/benchmark-sdk/session_001/` (verified). Corpus notes live at `corpus/patients/<pid>/notes/<note_id>.txt`.

## Architecture

```
NerSdkRunPanel (run complete)                 server                                  vendored python (cwd=vendor/bso-ad-sdk)
─────────────────────────────                 ──────                                  ──────────────────────────────────────
[Open annotate UI]  ── POST ──▶  /api/ner-sdk/annotate {session_id}
                                     │ 1. build notes CSV from the session cohort's corpus notes
                                     │ 2. batch_init (spawn) if batch missing:
                                     │      python3 pipeline/batch_init.py
                                     │        --results-root var/benchmark-sdk/<s>
                                     │        --review-root  var/annotate/review
                                     │        --batch-id <s> --reviewers reviewer_1 reviewer_2
                                     │        --notes-csv <built csv>
                                     │ 3. ensure workbench up on :18090 (TCP check; spawn detached if down):
                                     │      python3 pipeline/workbench.py
                                     │        --review-root var/annotate/review
                                     │        --ontology-root vendor/bso-ad-sdk/ontology
                                     │ return { url: "http://127.0.0.1:18090", batch_id: <s> }
   window.open(url, "_blank")  ◀─────┘
```

All python spawns use `cwd = vendor/bso-ad-sdk` (so `import claude_agent…` resolves) with the vendored `.env` injected (same as the run CLI).

### Components

1. **Vendor (copy):** `vendor/bso-ad-sdk/pipeline/workbench.py`, `vendor/bso-ad-sdk/pipeline/batch_init.py` (verbatim from the benchmark). Add `vendor/bso-ad-sdk/pipeline/__init__.py` only if needed for import (they're run as scripts, so likely not).

2. **`server/ner-sdk-annotate-routes.ts` (create)** — `export const nerSdkAnnotateRoutes: RouteEntry[]`:
   - `POST /api/ner-sdk/annotate` body `{ session_id }`:
     a. Resolve cohort via `getSessionManifest("bso-ad-ner-sdk", session_id)`.
     b. Build a notes CSV at `var/annotate/<session_id>-notes.csv` with header `note_id,person_id,note_text` — one row per cohort note (read `corpus/patients/<pid>/notes/<note_id>.txt`); CSV-quote every field (wrap in `"`, double internal `"`) so clinical note commas/quotes/newlines are safe.
     c. If `var/annotate/review/batches/<session_id>/manifest.json` does NOT exist, spawn (await) `batch_init.py` with the args above; treat `FileExistsError` as "already built" (idempotent).
     d. TCP-check `127.0.0.1:18090`; if down, spawn **detached** `workbench.py --review-root <abs var/annotate/review> --ontology-root <abs vendor/bso-ad-sdk/ontology>` (cwd=vendor/bso-ad-sdk, env from vendored `.env`), `unref()`, log to `var/annotate/workbench.log`. Give it ~1s to bind.
     e. Return `{ url: "http://127.0.0.1:18090", batch_id: session_id }`.
   - Guards: validate `session_id` (simple-id regex); 400 on missing/empty cohort.
   - Register in `server/index.ts` (import + `...nerSdkAnnotateRoutes`).

3. **`NerSdkRunPanel.tsx` (modify)** — when `status.state === "complete"`, add an **"Open annotate UI"** button next to "Go to VALIDATE". onClick: `POST /api/ner-sdk/annotate {session_id}` → `window.open(resp.url, "_blank")`. Show a small spinner/disabled state while the POST is in flight (batch_init + workbench spawn take a couple seconds). On error, show the message.

### Paths / config
- Review root (batches live here): `var/annotate/review/` (gitignored under `var/`).
- Ontology root for workbench: `vendor/bso-ad-sdk/ontology` (the vendored copy).
- Results root for batch_init: `var/benchmark-sdk/<session_id>/` (the run's per-note predictions).
- Reviewers: `reviewer_1 reviewer_2` (≥2 required; the user picks one at the workbench login).

## Boundaries / non-goals

- Additive only: vendor 2 python files + 1 new route file + 1 index import + 1 button. No platform-core / other-task / provider changes. Platform VALIDATE untouched (kept alongside).
- The workbench is a SEPARATE app (its own login/cookies) opened in a new tab — not embedded (iframe + its HttpOnly cookie/login is messier). 
- No auto-IAA/adjudication setup beyond what batch_init creates; the user annotates as one reviewer.
- Port 18090 is assumed free for the workbench (matches the benchmark default). If taken by something else, that's surfaced as a failed TCP bind in the log (future: make the port configurable).

## Testing

- **Vendor import:** `cd vendor/bso-ad-sdk && python3 -c "import ast; ast.parse(open('pipeline/workbench.py').read()); ast.parse(open('pipeline/batch_init.py').read())"` parses; a dry `python3 pipeline/batch_init.py --help` works (imports `claude_agent.review.batch`).
- **Route (no real workbench needed for wiring):** POST with the existing `session_001` → builds `var/annotate/review/batches/session_001/` (manifest + mentions.jsonl present), returns `{url, batch_id}`. Re-POST is idempotent (no FileExistsError surfaced). Invalid session → 400.
- **Workbench up:** after POST, TCP `127.0.0.1:18090` is listening; `curl -s 127.0.0.1:18090` returns HTML (the login/name-picker). (Owner does the actual annotate clicks.)
- **Frontend:** button shows on run-complete; clicking opens 18090 in a new tab. Component test mirrors existing patterns (mock authFetch + window.open).

## Self-review

- Placeholders: none — init_batch signature (incl. ≥2-reviewer requirement + FileExistsError idempotency), workbench args, paths, CSV-quoting requirement all concrete.
- Consistency: vendor path `vendor/bso-ad-sdk`, results root `var/benchmark-sdk/<session>`, review root `var/annotate/review`, task `bso-ad-ner-sdk` — consistent with the run CLI + prior specs.
- Scope: 2 vendored files + 1 route + 1 button; VALIDATE kept; self-contained.
- Ambiguity: idempotent batch build (FileExistsError = already built); reviewers fixed at `reviewer_1/2`; new-tab link (not iframe) — all explicit.
