# Embed the vendored workbench reviewer view in the VALIDATE tab (restyled)

**Date:** 2026-07-01
**Status:** design — approved in brainstorming, not yet implemented. **Supersedes** the native-React reviewer approach (`2026-07-01-native-reviewer-validate-tab-design.md`, tasks R1–R3), which is reverted.
**Scope:** For `bso-ad-ner-sdk`, the VALIDATE tab embeds the benchmark's **reviewer** annotation view (the real Curation Workbench, vendored) in an iframe, restyled to the platform's palette/fonts via a cosmetic "embed mode". The annotate FLOW is byte-identical to the original (it *is* the workbench JS); only layout/color/font change. Reviewer role only, single reviewer, no second user.

> **STANDING INSTRUCTION — DO NOT COMMIT.** All changes stay local.

## Why (and why not React)

The owner requires the annotate flow to be **exactly** the workbench reviewer flow — only cosmetics (layout/color/font) may change. A from-scratch React re-implementation (R1–R3) already drifted (wrong verdict options, no mapped/novel branching). To *guarantee* identical flow, embed the real workbench reviewer view and restyle it in place, rather than re-implement it.

## Decisions (brainstorming, 2026-07-01)

1. **Approach = embed + restyle** (not React re-port). Iframe the vendored workbench's reviewer view inside the VALIDATE tab.
2. **Restyle via a cosmetic "embed mode" inside the vendored workbench** (not parent CSS injection — a cross-origin iframe can't be styled from the parent). The mode overrides the workbench `:root` CSS variables to the platform palette/fonts, hides the sidebar/nav, and fixes the reviewer identity to `reviewer_1` (no login name-picker). **The verdict/annotate JS is untouched.**
3. **Revert R1–R3** (the React port): delete `review_op.py`, `ner-sdk-review-routes.ts`, `NativeReviewerPanel.tsx`. Re-establish a route that ensures the batch + workbench and returns the embed URL.
4. Reviewer role only; single reviewer `reviewer_1`; no adjudicator/maintainer, no 2nd user.

## Verified facts (2026-07-01)

- The workbench (`vendor/bso-ad-sdk/pipeline/workbench.py`) is a FastAPI app on :18090; a `.shell` grid (220px sidebar + main) with 3 views (review/adjudicate/ontology); login is a cookie name-picker; **fully themed via `:root` CSS variables** — `--bg #fafbfc, --bg-card #fff, --bg-muted, --border #d0d7de, --text #1f2328, --text-muted #57606a, --accent #0969da, --accent-bg #ddf4ff, --success #1a7f37, --success-bg, --danger #b1361b, --danger-bg, --font-sans, --font-mono`.
- The reviewer view's flow (mapped vs novel branch, forms, keyboard c/1/2/3/4, ontology proposal) is the workbench's own JS — the source of truth for "identical flow".
- FastAPI sets no `X-Frame-Options`, so the workbench can be iframed. Inside the iframe, its `/api/review/*` fetches are same-origin (:18090) and work.
- Platform design tokens (`client/src/index.css` `:root`): `--paper/--background 36 30% 96%` (#FAF7F2), `--ink/--foreground 24 15% 8%` (#14110F), `--muted-foreground 24 12% 38%`, `--primary 353 60% 31%` (#7E1F2A oxblood), `--border 34 18% 84%` (#E8E1D6), `--accent 32 25% 88%`; ok `#15803d`, err `#b91c1c`; fonts: body system-sans, mono "IBM Plex Mono". (Tailwind: `config/tailwind.config.js`.)
- The batch already builds from the run's predictions via the vendored `batch_init.py` (the retired annotate route's `ensureBatch` logic + `--include-note-id`). Batch dir `var/annotate/review/batches/<session>/`.

## Theme mapping (workbench var → platform value)

Applied by the embed mode as an injected `:root { … }` override:
```
--bg, --bg-app        → #FAF7F2   (cream paper)
--bg-card, --bg-subtle→ #FFFDFA / #FAF7F2
--bg-muted            → #EFE9DF   (paper crease)
--border,--border-muted→ #E8E1D6  (warm divider)
--text                → #14110F   (deep ink)
--text-muted          → #6B6157   (warm graphite)
--accent, --accent-hover → #7E1F2A (oxblood)   --accent-bg → #F3E7E4
--success,--success-hover → #7E1F2A (oxblood; decisive) --success-bg → #EDE3DD
--danger → #b91c1c   --danger-bg → #fee2e2
--font-sans → the platform body stack; --font-mono → "IBM Plex Mono", ui-monospace, monospace
```
(Exact hexes finalized in the plan from `index.css`; the point is: cosmetic-only var overrides — no structural/flow change.)

## Architecture

```
VALIDATE tab (bso-ad-ner-sdk)              server                                vendored workbench (:18090, embed mode)
─────────────────────────────             ──────                                ───────────────────────────────────────
<AnnotateEmbedPanel sessionId>
  POST /api/ner-sdk/annotate {session_id} ─▶  ensureBatch(session)  (batch_init if missing)
                                              ensure workbench up on :18090 (spawn detached if down)
                                          ◀── { url: "http://127.0.0.1:18090/?embed=1&reviewer=reviewer_1&batch=<session>#review" }
  <iframe src={url} class="w-full h-[80vh]"> ───────────────────────────────────▶  embed mode:
                                                                                     · inject platform :root theme override
                                                                                     · hide .sidebar / collapse .shell to 1 col
                                                                                     · fix reviewer=reviewer_1 (skip login)
                                                                                     · open the review view on <batch>
                                                                                     · (all verdict JS unchanged)
```

### Components

1. **`vendor/bso-ad-sdk/pipeline/workbench.py` — add a cosmetic embed mode (flow untouched):**
   - Accept `?embed=1&reviewer=<id>&batch=<batch_id>` on the shell route.
   - When `embed=1`: (a) treat the request's reviewer as `reviewer=<id>` (default reviewer_1) so `require_reviewer` / the identity resolution passes without the login name-picker (e.g. set the same cookie/context the login sets, server-side, for that name); (b) inject an extra `<style>` after the base CSS that re-declares the platform `:root` vars + hides `.sidebar`/sets `.shell` to a single column; (c) auto-navigate the SPA to the review view for `batch` (the existing client bootstrap + a small `if (EMBED) showReview(batch)` hook). Do NOT change any verdict/form/handler code.
   - Everything else (the review card, buttons, forms, keyboard, submit endpoints) is the unmodified workbench.

2. **`server/ner-sdk-annotate-routes.ts` — recreate** (was deleted in R2): `POST /api/ner-sdk/annotate {session_id}` → `ensureBatch(sessionId)` (the notes-CSV + `batch_init --include-note-id` logic) → ensure workbench running on :18090 (TCP check; detached spawn `python3 pipeline/workbench.py --review-root var/annotate/review --ontology-root vendor/bso-ad-sdk/ontology` if down) → return `{ url: "http://127.0.0.1:18090/?embed=1&reviewer=reviewer_1&batch=<sessionId>#review" }`. Register in `server/index.ts`.

3. **`client/src/ui/Workspace/AnnotateEmbedPanel.tsx` — create:** on mount, `POST /api/ner-sdk/annotate {session_id}`; on `{url}`, render `<iframe src={url} title="reviewer" className="w-full h-[78vh] rounded-md border border-border" />`. Loading + error states. (Platform chrome around a pixel-faithful, restyled workbench.)

4. **`PhaseValidate.tsx`** — the NER-gated early return renders `<AnnotateEmbedPanel sessionId={sessionId} />` instead of `<NativeReviewerPanel …>` (keep the gate + `sessionId` prop from R3).

5. **Reverts:** delete `vendor/bso-ad-sdk/pipeline/review_op.py`, `server/ner-sdk-review-routes.ts`, `client/src/ui/Workspace/NativeReviewerPanel.tsx`; remove their registrations/imports. (`NerSdkRunPanel` stays as-is — its "Open annotate UI" button was already removed in R3; the run panel keeps only Run/Run-again.)

## Boundaries / non-goals

- Only `bso-ad-ner-sdk` (NER-gated). Phenotype/adherence VALIDATE untouched.
- The embed mode changes ONLY cosmetics (CSS vars, hide nav) + single-reviewer auth. The annotate flow, verdict kinds, forms, keyboard, and endpoints are the workbench's own, unchanged.
- Reviewer role only; no adjudicator/maintainer surfaces (the embed lands on the review view; nav to other roles is hidden).
- Cross-origin iframe (:18090 inside :5174) — acceptable; the workbench's own fetches are same-origin within the frame; no parent↔frame scripting needed (restyle is internal to the embed mode).

## Testing

- **Embed mode:** `curl -s "http://127.0.0.1:18090/?embed=1&reviewer=reviewer_1&batch=session_001"` returns the shell HTML containing the injected platform-theme `<style>` (e.g. `#FAF7F2` / oxblood `#7E1F2A`) and NOT requiring login; the sidebar is hidden (CSS). The non-embed workbench URL is unchanged (still themed default + nav).
- **Route:** `POST /api/ner-sdk/annotate {session_id:"session_001"}` → `{url:…embed=1…batch=session_001…}`; batch exists; `curl 127.0.0.1:18090` reachable.
- **Frontend:** NER VALIDATE renders the iframe (workbench reviewer view, platform-skinned); the reviewer flow (Confirm / concept-is-wrong / concept-is-novel / type-or-span-wrong / not-an-entity; novel: Yes-truly-novel / agent-missed-it / …) is present and identical; submitting advances (workbench behavior). Phenotype VALIDATE unchanged.
- **Reverts:** `review_op.py`, `ner-sdk-review-routes.ts`, `NativeReviewerPanel.tsx` gone; no dangling imports (grep).

## Self-review

- Placeholders: none — theme mapping, embed-mode requirements, route shape, iframe, and the explicit revert list are concrete. (Exact hexes finalized in the plan from index.css — a values pass, not a design gap.)
- Consistency: batch dir/reviewer/`ensureBatch` reuse match prior specs; NER gate reuses the R3 PhaseValidate gate + sessionId prop.
- Scope: cosmetic embed mode + 1 route + 1 iframe panel + reverts; flow untouched; NER-only.
- Ambiguity: "identical flow" guaranteed by reusing the workbench JS; only CSS vars + nav-hide + fixed reviewer change — explicit.
