#!/usr/bin/env python3
"""BSO-AD Curation Workbench — review + adjudicate + ontology in one app.

One FastAPI app on port 18090 with a sidebar nav between the three roles. Login
is a name picker (no password); the chosen name persists in an HttpOnly cookie
so reopening the tab keeps the session. The same logged-in user can use all
three views — actor identity comes from the cookie, not CLI args.

Usage:
    python3 workbench.py --batch 2026-05-29-sdoh-demo
    # then open http://127.0.0.1:18090
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Optional

# Ensure the vendor root (parent of this pipeline/ dir) is on sys.path so
# that `claude_agent.*` resolves when this script is run directly.
sys.path.insert(0, str(Path(__file__).parent.parent))

import uvicorn
from fastapi import APIRouter, Depends, FastAPI, Form, HTTPException, Request, Response
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from pydantic import BaseModel

from claude_agent.review.adjudicate import (
    _load_adjudicated_ids,
    _load_merged,
    clear_adjudication,
    defer_decision,
    next_pending_disagreement,
    take_reviewer_decision,
    write_adjudication,
)
from claude_agent.review.adjudicate import latest_decision_for as latest_adjud_decision
from claude_agent.review.cli_review import (
    amend_verdict,
    attach_ontology_proposal,
    build_correction_verdict,
    build_simple_verdict,
    clear_verdict,
    next_pending_mention,
    progress_string,
    submit_verdict,
)
from claude_agent.review.ontology import (
    clear_decision as clear_ontology_decision,
)
from claude_agent.review.ontology import (
    latest_decision_for as latest_ontology_decision,
)
from claude_agent.review.ontology import (
    load_live_decisions,
    load_proposals,
    write_decision,
)
from claude_agent.review.schema import (
    AdjudicationFinal,
    AdjudicationRecord,
    MentionRecord,
    OntologyProposalAttachment,
    ReviewerVerdict,
    Span,
)

# ── Globals (set by CLI args at startup) ──────────────────────────────────────
REVIEW_ROOT: Path = Path("review")          # parent dir under which batches live
ONTOLOGY_ROOT: Path = Path("ontology")
DEFAULT_BATCH_ID: Optional[str] = None      # used when cookie has no batch
COOKIE_USER = "ner_workbench_user"
COOKIE_BATCH = "ner_workbench_batch"
SESSION_DAYS = 30

# CLI role overrides — applied additively to every batch's role table.
CLI_REVIEWERS: list[str] = []
CLI_ADJUDICATORS: list[str] = []
CLI_MAINTAINERS: list[str] = []

# Per-batch caches (key = batch_id)
_ROLES_CACHE: dict[str, dict[str, set[str]]] = {}

_CONCEPTS_CACHE: Optional[dict] = None
_ENTITY_TYPES_CACHE: Optional[list[dict]] = None

# ── Embed constants (cosmetic/auth only) ──────────────────────────────────────
_EMBED_STYLE = """
<style id="platform-embed-theme">
:root {
  --bg:#FAF7F2; --bg-app:#FAF7F2; --bg-card:#FFFDFA; --bg-muted:#EFE9DF; --bg-subtle:#F7F4EE;
  --border:#E8E1D6; --border-muted:#EDE7DC;
  --text:#14110F; --text-muted:#6B6157; --text-subtle:#8B8378;
  --accent:#7E1F2A; --accent-hover:#6A1A24; --accent-bg:#F3E7E4;
  --success:#7E1F2A; --success-hover:#6A1A24; --success-bg:#EDE3DD;
  --danger:#B91C1C; --danger-bg:#FEE2E2;
  --font-sans:"IBM Plex Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
  --font-mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
}
.shell { grid-template-columns: 1fr !important; }
.sidebar { display: none !important; }
</style>
"""
_EMBED_SCRIPT = """
<script>if (location.hash !== "#/review") location.hash = "#/review";</script>
"""


def _build_roles_config(
    batch_dir: Path,
    cli_reviewers: list[str],
    cli_adjudicators: list[str],
    cli_maintainers: list[str],
) -> dict[str, set[str]]:
    """Merge role assignments from CLI flags, batch manifest, and (for
    adjudicator/maintainer only) inference over existing data files.

    Reviewer role is STRICT: only the names in `manifest.reviewers` plus any
    `--reviewer` CLI overrides. We DO NOT infer reviewer from
    verdicts/<name>.jsonl file presence — that would let stale orphan files
    (eve.jsonl from a prior test) silently become reviewers and corrupt IAA.

    Reviewer count is bounded — downstream merge_iaa.py requires exactly 2:
      * >2 → raise SystemExit (startup fails)
      * <2 → print a warning (batch may be mid-setup; adjudicator/maintainer
              can still use the workbench until reviewers are assigned)

    Adjudicator and maintainer can grow over time (handover scenarios), so for
    those roles we union CLI + manifest + data inference.
    """
    roles: dict[str, set[str]] = defaultdict(set)

    # Read manifest once (may be missing for fresh batches).
    manifest: dict = {}
    manifest_path = batch_dir / "manifest.json"
    if manifest_path.exists():
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            manifest = {}

    # ── Reviewers: STRICT (manifest + CLI only). ──────────────────────────
    manifest_reviewers = manifest.get("reviewers", []) or []
    if not isinstance(manifest_reviewers, list):
        raise SystemExit(
            f"manifest.reviewers must be a list (got {type(manifest_reviewers).__name__}: "
            f"{manifest_reviewers!r}). Fix {manifest_path}."
        )
    reviewer_names: set[str] = {r for r in (set(cli_reviewers) | set(manifest_reviewers)) if r}
    if len(reviewer_names) > 2:
        raise SystemExit(
            f"too many reviewers configured for batch {batch_dir.name} "
            f"({len(reviewer_names)}): {sorted(reviewer_names)}. v1 supports exactly 2."
        )
    for r in reviewer_names:
        roles[r].add("reviewer")

    # Surface orphan verdict files (filenames not in the manifest set).
    vdir = batch_dir / "verdicts"
    if vdir.is_dir():
        for f in vdir.glob("*.jsonl"):
            if f.stem not in reviewer_names:
                print(f"  ⚠ [{batch_dir.name}] orphan verdict file {f.name}: "
                      f"reviewer {f.stem!r} not in manifest; ignored")

    # ── Adjudicators: CLI + manifest + inference. ─────────────────────────
    for a in cli_adjudicators:                       roles[a].add("adjudicator")
    for a in manifest.get("adjudicators", []):       roles[a].add("adjudicator")
    adj_path = batch_dir / "adjudication.jsonl"
    if adj_path.exists():
        for line in adj_path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                try:
                    roles[json.loads(line)["adjudicator_id"]].add("adjudicator")
                except (KeyError, json.JSONDecodeError):
                    pass

    # ── Maintainers: CLI + manifest + inference. ─────────────────────────
    for m in cli_maintainers:                        roles[m].add("maintainer")
    for m in manifest.get("maintainers", []):        roles[m].add("maintainer")
    dec_path = ONTOLOGY_ROOT / "decisions.jsonl"
    if dec_path.exists():
        for line in dec_path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                try:
                    roles[json.loads(line)["maintainer_id"]].add("maintainer")
                except (KeyError, json.JSONDecodeError):
                    pass

    return dict(roles)


def _list_batches() -> list[dict]:
    """Scan REVIEW_ROOT/batches/* for batches with a valid mentions.jsonl.
    Returns a list of {batch_id, n_mentions, reviewers, note_ids, created_at}."""
    root = REVIEW_ROOT / "batches"
    if not root.is_dir():
        return []
    out = []
    for d in sorted(root.iterdir()):
        if not d.is_dir():
            continue
        m_path = d / "mentions.jsonl"
        manifest_path = d / "manifest.json"
        if not m_path.exists():
            continue
        info = {
            "batch_id": d.name,
            "n_mentions": sum(1 for line in m_path.read_text().splitlines() if line.strip()),
            "reviewers": [], "adjudicators": [], "maintainers": [],
            "note_ids": [], "created_at": None,
        }
        if manifest_path.exists():
            try:
                man = json.loads(manifest_path.read_text(encoding="utf-8"))
                info["reviewers"] = man.get("reviewers", [])
                info["adjudicators"] = man.get("adjudicators", [])
                info["maintainers"] = man.get("maintainers", [])
                info["note_ids"] = man.get("note_ids", [])
                info["created_at"] = man.get("created_at")
            except json.JSONDecodeError:
                pass
        out.append(info)
    return out


# Batch IDs must be safe for filesystem use (no slashes, dots, traversal).
import re as _re
_BATCH_ID_RE = _re.compile(r"^[A-Za-z0-9_\-]+$")


def _current_batch_dir(request: Request) -> Path:
    """Resolve which batch the request is for: cookie > CLI default."""
    batch_id = request.cookies.get(COOKIE_BATCH) or DEFAULT_BATCH_ID
    if not batch_id:
        raise HTTPException(409, "no batch selected; POST /api/select_batch first")
    if not _BATCH_ID_RE.match(batch_id):
        raise HTTPException(400, f"invalid batch_id in cookie: {batch_id!r}")
    bd = REVIEW_ROOT / "batches" / batch_id
    if not (bd / "mentions.jsonl").exists():
        raise HTTPException(404, f"batch {batch_id!r} not found")
    return bd


def _roles_for(batch_dir: Path) -> dict[str, set[str]]:
    """Memoized per-batch role table. Refreshed when CLI restarts."""
    if batch_dir.name not in _ROLES_CACHE:
        _ROLES_CACHE[batch_dir.name] = _build_roles_config(
            batch_dir, CLI_REVIEWERS, CLI_ADJUDICATORS, CLI_MAINTAINERS,
        )
    return _ROLES_CACHE[batch_dir.name]


# ── Helpers ───────────────────────────────────────────────────────────────────
def _now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _load_concepts() -> dict:
    global _CONCEPTS_CACHE
    if _CONCEPTS_CACHE is None:
        _CONCEPTS_CACHE = json.loads(
            (ONTOLOGY_ROOT / "concepts.json").read_text(encoding="utf-8")
        )
    return _CONCEPTS_CACHE


def _resolve_accept_entity_type(parent: str, entity_type: Optional[str]) -> str:
    """Validate (parent, entity_type) for an ontology accept decision.

    If `entity_type` is unset, infer it by walking concepts.json: the parent
    must match a top-level entity_type key OR a concept label under exactly
    one such block. If `entity_type` IS set, validate that `parent` exists
    within that block (or equals the block name for a top-level child).

    Raises HTTPException(400) with a precise message on any failure. Returns
    the resolved entity_type string.
    """
    data = _load_concepts()
    known_types = [k for k in data.keys() if not k.startswith("_")]

    if entity_type:
        if entity_type not in known_types:
            raise HTTPException(
                400,
                f"entity_type {entity_type!r} not found in concepts.json; "
                f"valid types: {known_types}",
            )
        if parent == entity_type:
            return entity_type
        block = data.get(entity_type) or {}
        if any(c.get("label") == parent for c in block.get("concepts", [])):
            return entity_type
        raise HTTPException(
            400,
            f"parent {parent!r} not found under entity_type {entity_type!r}",
        )

    # entity_type unset → infer from parent
    matches: list[str] = []
    for et in known_types:
        if et == parent:
            matches.append(et)
            continue
        block = data.get(et) or {}
        if any(c.get("label") == parent for c in block.get("concepts", [])):
            matches.append(et)
    if not matches:
        raise HTTPException(
            400,
            f"parent {parent!r} not found in any entity_type subtree; "
            f"please pick a valid existing concept or specify entity_type explicitly",
        )
    if len(matches) > 1:
        raise HTTPException(
            400,
            f"parent {parent!r} is ambiguous across entity_types {matches}; "
            f"please specify entity_type explicitly",
        )
    return matches[0]


RESULTS_NER_ROOT: Path = Path("results/ner")

_NOTES_CSV_CACHE: dict[Path, dict[str, str]] = {}


def _load_notes_csv(notes_csv: Path) -> dict[str, str]:
    cached = _NOTES_CSV_CACHE.get(notes_csv)
    if cached is not None:
        return cached
    table: dict[str, str] = {}
    try:
        with notes_csv.open("r", encoding="utf-8", newline="") as f:
            reader = csv.DictReader(f)
            for row in reader:
                nid = row.get("note_id")
                if nid:
                    table[nid] = row.get("note_text", "") or ""
    except OSError:
        table = {}
    _NOTES_CSV_CACHE[notes_csv] = table
    return table


def _resolve_notes_csv(batch_dir: Path) -> Optional[Path]:
    manifest_path = batch_dir / "manifest.json"
    if manifest_path.exists():
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            csv_path = manifest.get("notes_csv")
            if csv_path:
                p = Path(csv_path)
                if p.exists():
                    return p
        except json.JSONDecodeError:
            pass
    for p in Path("data").glob("*/notes.csv"):
        if p.exists():
            return p
    return None


def _read_source(batch_dir: Path, note_id: str) -> str:
    notes_csv = _resolve_notes_csv(batch_dir)
    if notes_csv is None:
        return ""
    return _load_notes_csv(notes_csv).get(note_id, "")


def _find_mention(batch_dir: Path, mention_id: str) -> MentionRecord:
    for line in (batch_dir / "mentions.jsonl").read_text().splitlines():
        if not line.strip():
            continue
        r = MentionRecord.model_validate_json(line)
        if r.mention_id == mention_id:
            return r
    raise HTTPException(404, f"mention_id {mention_id} not in batch {batch_dir.name}")


# ── Auth + role guards ────────────────────────────────────────────────────────
def get_user(request: Request) -> str:
    user = request.cookies.get(COOKIE_USER)
    if not user:
        raise HTTPException(401, "not logged in")
    return user


def get_batch_dir(request: Request) -> Path:
    return _current_batch_dir(request)


def _require_role(role: str):
    def dep(
        user: str = Depends(get_user),
        batch_dir: Path = Depends(get_batch_dir),
    ) -> str:
        if role not in _roles_for(batch_dir).get(user, set()):
            raise HTTPException(
                403,
                f"user {user!r} does not have role {role!r} for batch {batch_dir.name}",
            )
        return user
    return dep


require_reviewer = _require_role("reviewer")
require_adjudicator = _require_role("adjudicator")
require_maintainer = _require_role("maintainer")


def require_any_role(
    user: str = Depends(get_user),
    batch_dir: Path = Depends(get_batch_dir),
) -> str:
    """Permit downloads/IAA reads to anyone who is a reviewer, adjudicator,
    or maintainer on the current batch. Zero-role users (e.g. eve who's never
    been assigned) still get 403 — the artifacts contain reviewer notes etc."""
    if not _roles_for(batch_dir).get(user, set()):
        raise HTTPException(
            403,
            f"user {user!r} has no role on batch {batch_dir.name}",
        )
    return user


app = FastAPI(title="BSO-AD Curation Workbench")


# ── Root + login ─────────────────────────────────────────────────────────────
@app.get("/", response_class=HTMLResponse)
def index(request: Request) -> HTMLResponse:
    embed = request.query_params.get("embed")
    if embed:
        user = request.query_params.get("reviewer") or "reviewer_1"
        batch_id = request.query_params.get("batch") or DEFAULT_BATCH_ID or "(none)"
        html = SHELL_HTML.replace("__BATCH__", batch_id).replace("__USER__", user)
        html = html.replace("</head>", _EMBED_STYLE + "</head>")
        html = html.replace("</body>", _EMBED_SCRIPT + "</body>")
        resp = HTMLResponse(html)
        resp.set_cookie(COOKIE_USER, user, httponly=True, samesite="lax")
        resp.set_cookie(COOKIE_BATCH, batch_id, httponly=True, samesite="lax")
        return resp
    user = request.cookies.get(COOKIE_USER)
    if not user:
        return RedirectResponse(url="/login", status_code=303)
    batch_id = request.cookies.get(COOKIE_BATCH) or DEFAULT_BATCH_ID or "(none)"
    html = SHELL_HTML.replace("__BATCH__", batch_id).replace("__USER__", user)
    return HTMLResponse(html)


@app.get("/login", response_class=HTMLResponse)
def login_page(request: Request) -> HTMLResponse:
    # Build a union of role assignments across ALL batches, so the picker shows
    # every known user along with where they have access.
    by_role: dict[str, set[str]] = defaultdict(set)
    for binfo in _list_batches():
        bd = REVIEW_ROOT / "batches" / binfo["batch_id"]
        for user, roles in _roles_for(bd).items():
            for r in roles:
                by_role[r].add(user)
    blocks = []
    for role_key, label in (("reviewer", "Reviewers"),
                            ("adjudicator", "Adjudicators"),
                            ("maintainer", "Maintainers")):
        users = sorted(by_role.get(role_key, []))
        if users:
            opts = "".join(f'<option value="{u}">{u}</option>' for u in users)
            blocks.append(f'<optgroup label="{label}">{opts}</optgroup>')
    options = "\n".join(blocks)
    batch_id = DEFAULT_BATCH_ID or "(pick after login)"
    html = LOGIN_HTML.replace("__OPTIONS__", options).replace("__BATCH__", batch_id)
    return HTMLResponse(html)


@app.post("/login")
def do_login(name: str = Form(""), new_name: str = Form("")) -> Response:
    final = (new_name.strip() or name.strip())
    if not final:
        return RedirectResponse(url="/login", status_code=303)
    resp = RedirectResponse(url="/", status_code=303)
    resp.set_cookie(
        COOKIE_USER, final, max_age=SESSION_DAYS * 86400,
        httponly=True, samesite="lax",
    )
    # If a default batch was set at CLI launch and no batch cookie exists, seed it.
    if DEFAULT_BATCH_ID:
        resp.set_cookie(
            COOKIE_BATCH, DEFAULT_BATCH_ID, max_age=SESSION_DAYS * 86400,
            httponly=True, samesite="lax",
        )
    return resp


@app.post("/logout")
def do_logout() -> Response:
    resp = RedirectResponse(url="/login", status_code=303)
    resp.delete_cookie(COOKIE_USER)
    resp.delete_cookie(COOKIE_BATCH)
    return resp


@app.get("/api/me")
def api_me(request: Request, user: str = Depends(get_user)) -> dict:
    batch_id = request.cookies.get(COOKIE_BATCH) or DEFAULT_BATCH_ID
    # Validate the cookie value against the same whitelist as _current_batch_dir.
    # If the cookie is malformed (e.g., path-traversal attempt), treat it as if
    # no batch were selected — don't echo attacker-controlled content back.
    if batch_id and not _BATCH_ID_RE.match(batch_id):
        batch_id = None
    roles: list[str] = []
    if batch_id:
        bd = REVIEW_ROOT / "batches" / batch_id
        if (bd / "mentions.jsonl").exists():
            roles = sorted(_roles_for(bd).get(user, set()))
    return {"user_id": user, "batch_id": batch_id, "roles": roles}


# ── Batch selection ───────────────────────────────────────────────────────────
@app.get("/api/batches")
def api_batches(request: Request, user: str = Depends(get_user)) -> dict:
    """List all batches in REVIEW_ROOT, with this user's roles per batch."""
    out = []
    for binfo in _list_batches():
        bd = REVIEW_ROOT / "batches" / binfo["batch_id"]
        user_roles = sorted(_roles_for(bd).get(user, set()))
        out.append({**binfo, "your_roles": user_roles})
    return {
        "batches": out,
        "current": request.cookies.get(COOKIE_BATCH) or DEFAULT_BATCH_ID,
    }


class SelectBatchRequest(BaseModel):
    batch_id: str


@app.post("/api/select_batch")
def api_select_batch(req: SelectBatchRequest, user: str = Depends(get_user)) -> Response:
    if not _BATCH_ID_RE.match(req.batch_id):
        raise HTTPException(400, f"invalid batch_id: {req.batch_id!r}")
    bd = REVIEW_ROOT / "batches" / req.batch_id
    if not (bd / "mentions.jsonl").exists():
        raise HTTPException(404, f"batch {req.batch_id!r} not found")
    resp = JSONResponse({"ok": True, "batch_id": req.batch_id})
    resp.set_cookie(
        COOKIE_BATCH, req.batch_id, max_age=SESSION_DAYS * 86400,
        httponly=True, samesite="lax",
    )
    return resp


# ── Downloads ─────────────────────────────────────────────────────────────────
DOWNLOAD_KINDS = {
    # batch-scoped artifacts (under review/batches/<batch>/)
    "mentions":      ("batch", "mentions.jsonl"),
    "manifest":      ("batch", "manifest.json"),
    "merged":        ("batch", "merged.jsonl"),
    "iaa":           ("batch", "iaa.json"),
    "adjudication":  ("batch", "adjudication.jsonl"),
    "gold":          ("batch", "gold.jsonl"),
    "restructuring": ("batch", "restructuring_needed.jsonl"),
    # ontology-scoped artifacts (under ontology/)
    "proposals":     ("ontology", "proposals.jsonl"),
    "decisions":     ("ontology", "decisions.jsonl"),
    "concepts":      ("ontology", "concepts.json"),
    "changelog":     ("ontology", "changelog.jsonl"),
}

# Per-kind role requirement for /api/download/{kind}. "any_role" means any
# user with at least one role on the batch may download; "adjudicator_or_maintainer"
# blocks plain reviewers from artifacts containing peers' notes or merged data;
# "maintainer_only" reserves global ontology artifacts to maintainers.
ARTIFACT_ROLE_REQUIREMENTS: dict[str, str] = {
    "mentions":      "any_role",
    "manifest":      "any_role",
    "iaa":           "adjudicator_or_maintainer",
    "merged":        "adjudicator_or_maintainer",
    "adjudication":  "adjudicator_or_maintainer",
    "gold":          "adjudicator_or_maintainer",
    "restructuring": "adjudicator_or_maintainer",
    # ontology artifacts are global (not batch-scoped) — gate to maintainer
    "proposals":     "maintainer_only",
    "decisions":     "maintainer_only",
    "concepts":      "any_role",      # public concepts.json, harmless to read
    "changelog":     "any_role",
}


def _check_artifact_role(kind: str, user: str, batch_dir: Path) -> None:
    """403 unless `user` holds a role on `batch_dir` sufficient for `kind`."""
    user_roles = _roles_for(batch_dir).get(user, set())
    requirement = ARTIFACT_ROLE_REQUIREMENTS.get(kind)
    if requirement is None:
        # Unknown kind handled by caller via 404; do not 403 here.
        return
    if requirement == "any_role":
        if not user_roles:
            raise HTTPException(
                403,
                f"user {user!r} has no role on batch {batch_dir.name}",
            )
        return
    if requirement == "adjudicator_or_maintainer":
        if not (user_roles & {"adjudicator", "maintainer"}):
            raise HTTPException(
                403,
                f"download of {kind!r} requires adjudicator or maintainer role; "
                f"user {user!r} has {sorted(user_roles)}",
            )
        return
    if requirement == "maintainer_only":
        if "maintainer" not in user_roles:
            raise HTTPException(
                403,
                f"download of {kind!r} requires maintainer role; "
                f"user {user!r} has {sorted(user_roles)}",
            )
        return
    # Defensive: unknown requirement string → deny
    raise HTTPException(500, f"server misconfigured: unknown role requirement {requirement!r}")


@app.get("/api/download/{kind}")
def api_download(
    kind: str,
    reviewer: Optional[str] = None,
    user: str = Depends(get_user),
    batch_dir: Path = Depends(get_batch_dir),
):
    user_roles = _roles_for(batch_dir).get(user, set())
    if kind == "verdicts":
        # By default, the caller downloads their own verdicts file. Adjudicators
        # and maintainers on the batch may pass ?reviewer=<name> to fetch a
        # specific reviewer's file. Plain reviewers may only download their own.
        target = reviewer or user
        if target != user and not (user_roles & {"adjudicator", "maintainer"}):
            raise HTTPException(
                403,
                f"reviewer {user!r} may only download their own verdicts file",
            )
        if not user_roles:
            raise HTTPException(
                403,
                f"user {user!r} has no role on batch {batch_dir.name}",
            )
        f = batch_dir / "verdicts" / f"{target}.jsonl"
        if not f.exists():
            raise HTTPException(404, f"no verdicts written yet for {target}")
        return FileResponse(f, filename=f"{target}.jsonl", media_type="application/jsonl")
    if kind not in DOWNLOAD_KINDS:
        raise HTTPException(404, f"unknown download kind: {kind!r}")
    _check_artifact_role(kind, user, batch_dir)
    scope, fname = DOWNLOAD_KINDS[kind]
    f = (batch_dir if scope == "batch" else ONTOLOGY_ROOT) / fname
    if not f.exists():
        raise HTTPException(404, f"{fname} not generated yet")
    media = "application/json" if fname.endswith(".json") else "application/jsonl"
    # Prefix the batch_id into filename for batch-scoped artifacts, so multiple
    # downloads don't collide.
    final_name = (f"{batch_dir.name}__{fname}" if scope == "batch" else fname)
    return FileResponse(f, filename=final_name, media_type=media)


@app.get("/api/artifacts")
def api_artifacts(user: str = Depends(require_any_role), batch_dir: Path = Depends(get_batch_dir)) -> dict:
    """Tell the UI which downloadable files exist for the current batch +
    the ontology, so it can show enabled/disabled download buttons."""
    out: dict[str, dict] = {}
    for kind, (scope, fname) in DOWNLOAD_KINDS.items():
        f = (batch_dir if scope == "batch" else ONTOLOGY_ROOT) / fname
        out[kind] = {"exists": f.exists(), "size": (f.stat().st_size if f.exists() else 0),
                     "scope": scope}
    # User verdicts
    vf = batch_dir / "verdicts" / f"{user}.jsonl"
    out["verdicts"] = {"exists": vf.exists(), "size": (vf.stat().st_size if vf.exists() else 0),
                       "scope": "user"}
    return out


# ── Shared concepts API ───────────────────────────────────────────────────────
@app.get("/api/concepts/entity_types")
def api_entity_types(user: str = Depends(get_user)) -> dict:
    global _ENTITY_TYPES_CACHE
    if _ENTITY_TYPES_CACHE is None:
        data = _load_concepts()
        _ENTITY_TYPES_CACHE = [
            {"name": k, "n_concepts": v.get("n_concepts", len(v.get("concepts", [])))}
            for k, v in data.items() if not k.startswith("_")
        ]
    return {"entity_types": _ENTITY_TYPES_CACHE}


@app.get("/api/concepts/subtree/{entity_type}")
def api_subtree(entity_type: str, user: str = Depends(get_user)) -> dict:
    """Return the subtree under one entity_type in both ASCII (for read-only
    display) and structured nodes (for click-to-pick tree pickers)."""
    data = _load_concepts()
    if entity_type not in data or entity_type.startswith("_"):
        raise HTTPException(404, f"unknown entity_type: {entity_type}")
    concepts = data[entity_type].get("concepts", [])
    children_of: dict[str, list[dict]] = defaultdict(list)
    for c in concepts:
        if c.get("parent_label"):
            children_of[c["parent_label"]].append(c)

    # ASCII tree (existing format) for the read-only `view subtree` panel.
    lines = [entity_type]

    def walk_ascii(parent: str, prefix: str = "") -> None:
        kids = children_of.get(parent, [])
        for i, c in enumerate(kids):
            last = i == len(kids) - 1
            lines.append(f"{prefix}{'└── ' if last else '├── '}{c['label']}")
            walk_ascii(c["label"], prefix + ("    " if last else "│   "))

    walk_ascii(entity_type)

    # Structured nodes for click-to-pick UIs. Root included at depth 0.
    nodes: list[dict] = [{"label": entity_type, "depth": 0, "parent_label": None}]

    def walk_structured(parent: str, depth: int) -> None:
        for c in children_of.get(parent, []):
            nodes.append({"label": c["label"], "depth": depth, "parent_label": parent})
            walk_structured(c["label"], depth + 1)

    walk_structured(entity_type, 1)
    return {
        "name": entity_type,
        "n_concepts": len(concepts),
        "ascii": "\n".join(lines),
        "nodes": nodes,
    }


# ── Review API (verdicts written as the logged-in user) ───────────────────────
review = APIRouter(prefix="/api/review", dependencies=[Depends(require_reviewer)])


def _live_verdicts(batch_dir: Path, user: str) -> dict[str, dict]:
    path = batch_dir / "verdicts" / f"{user}.jsonl"
    if not path.exists():
        return {}
    out: dict[str, dict] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        rec = json.loads(line)
        if rec.get("superseded_at"):
            continue
        out[rec["mention_id"]] = rec
    return out


def _build_verdict_from_payload(batch_dir: Path, req: "VerdictRequest", user: str) -> ReviewerVerdict:
    m = _find_mention(batch_dir, req.mention_id)
    now = _now_iso()
    dur = req.review_duration_ms

    if req.verdict == "confirm":
        v = ReviewerVerdict(
            mention_id=m.mention_id, reviewer_id=user, verdict="confirm",
            notes=req.notes, reviewed_at=now, review_duration_ms=dur,
        )
    elif req.verdict == "correct_concept":
        if not req.new_concept:
            raise HTTPException(400, "correct_concept requires new_concept")
        v = build_correction_verdict(
            mention=m, reviewer_id=user, kind="concept",
            new_value=req.new_concept, notes=req.notes,
            review_duration_ms=dur, reviewed_at=now,
        )
    elif req.verdict == "correct_type":
        if not req.new_type:
            raise HTTPException(400, "correct_type requires new_type")
        v = build_correction_verdict(
            mention=m, reviewer_id=user, kind="type",
            new_value=req.new_type, notes=req.notes,
            review_duration_ms=dur, reviewed_at=now,
        )
    elif req.verdict == "correct_span":
        if not req.new_span or len(req.new_span) != 2:
            raise HTTPException(400, "correct_span requires new_span=[start, end]")
        v = build_correction_verdict(
            mention=m, reviewer_id=user, kind="span",
            new_value=(req.new_span[0], req.new_span[1]), notes=req.notes,
            review_duration_ms=dur, reviewed_at=now,
        )
    elif req.verdict in {"reject_not_entity", "reject_duplicate",
                         "concept_name_novel",
                         "propose_split", "propose_merge"}:
        v = build_simple_verdict(
            mention=m, reviewer_id=user, verdict_kind=req.verdict,
            notes=req.notes, review_duration_ms=dur, reviewed_at=now,
        )
    else:
        raise HTTPException(400, f"unknown verdict {req.verdict!r}")

    if req.ontology_proposal:
        v = attach_ontology_proposal(
            verdict=v, attachment=OntologyProposalAttachment(**req.ontology_proposal),
        )
    return v


class VerdictRequest(BaseModel):
    mention_id: str
    verdict: str
    notes: str = ""
    new_concept: Optional[str] = None
    new_type: Optional[str] = None
    new_span: Optional[list[int]] = None
    ontology_proposal: Optional[dict] = None
    review_duration_ms: int = 0


class ClearMentionRequest(BaseModel):
    mention_id: str


def _iter_batch_mentions(batch_dir: Path):
    """Iterate every MentionRecord in this batch in mentions.jsonl order."""
    path = batch_dir / "mentions.jsonl"
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        yield MentionRecord.model_validate_json(line)


def _next_pending_in_note(batch_dir: Path, reviewer_id: str, note_id: str):
    """First mention in this note that the reviewer hasn't produced a live
    verdict for, or None if every mention in the note is done."""
    reviewed: set[str] = set(_live_verdicts(batch_dir, reviewer_id).keys())
    for m in _iter_batch_mentions(batch_dir):
        if m.note_id != note_id:
            continue
        if m.mention_id not in reviewed:
            return m
    return None


@review.get("/next")
def review_next(
    user: str = Depends(get_user),
    batch_dir: Path = Depends(get_batch_dir),
    note_id: Optional[str] = None,
) -> dict:
    progress = progress_string(batch_dir=batch_dir, reviewer_id=user)
    if note_id:
        m = _next_pending_in_note(batch_dir, user, note_id)
        if m is None:
            return {"done": True, "progress": progress, "note_id": note_id}
    else:
        m = next_pending_mention(batch_dir=batch_dir, reviewer_id=user)
        if m is None:
            return {"done": True, "progress": progress}
    return {
        "done": False, "progress": progress,
        "mention": m.model_dump(mode="json"),
        "source": _read_source(batch_dir, m.note_id),
    }


@review.get("/prev")
def review_prev(
    user: str = Depends(get_user),
    batch_dir: Path = Depends(get_batch_dir),
    note_id: Optional[str] = None,
) -> dict:
    verdicts = _live_verdicts(batch_dir, user)
    if not verdicts:
        return {"none": True}
    if note_id:
        # Restrict to mentions in this note. Walk verdicts sorted by
        # reviewed_at desc, take the first whose mention belongs to note_id.
        candidates = sorted(verdicts.values(), key=lambda v: v.get("reviewed_at", ""), reverse=True)
        prior = None
        target_mention = None
        for v in candidates:
            try:
                m_candidate = _find_mention(batch_dir, v["mention_id"])
            except HTTPException:
                continue
            if m_candidate.note_id == note_id:
                prior = v
                target_mention = m_candidate
                break
        if prior is None:
            return {"none": True}
        m = target_mention
    else:
        prior = max(verdicts.values(), key=lambda v: v.get("reviewed_at", ""))
        m = _find_mention(batch_dir, prior["mention_id"])
    return {
        "mention": m.model_dump(mode="json"),
        "source": _read_source(batch_dir, m.note_id),
        "prior_verdict": prior,
        "progress": progress_string(batch_dir=batch_dir, reviewer_id=user),
    }


@review.get("/note_index")
def review_note_index(
    user: str = Depends(get_user),
    batch_dir: Path = Depends(get_batch_dir),
) -> dict:
    """Return per-note mention counts for the note-filter dropdown.
    [{note_id, n_mentions, n_reviewed}, ...] preserving mentions.jsonl order."""
    reviewed_ids = set(_live_verdicts(batch_dir, user).keys())
    order: list[str] = []
    n_total: dict[str, int] = {}
    n_done: dict[str, int] = {}
    grand_total = 0
    for m in _iter_batch_mentions(batch_dir):
        nid = m.note_id
        if nid not in n_total:
            order.append(nid)
            n_total[nid] = 0
            n_done[nid] = 0
        n_total[nid] += 1
        grand_total += 1
        if m.mention_id in reviewed_ids:
            n_done[nid] += 1
    notes = [
        {"note_id": nid, "n_mentions": n_total[nid], "n_reviewed": n_done[nid]}
        for nid in order
    ]
    return {"notes": notes, "total": grand_total}


@review.get("/mentions")
def review_mentions(user: str = Depends(get_user), batch_dir: Path = Depends(get_batch_dir)) -> dict:
    verdicts = _live_verdicts(batch_dir, user)
    out = []
    for i, line in enumerate((batch_dir / "mentions.jsonl").read_text(encoding="utf-8").splitlines()):
        if not line.strip():
            continue
        m = MentionRecord.model_validate_json(line)
        out.append({
            "index": i, "mention_id": m.mention_id, "text": m.text,
            "note_id": m.note_id, "person_id": m.person_id,
            "entity_type": m.entity_type, "concept_name": m.concept_name,
            "status": m.status, "verdict": verdicts.get(m.mention_id),
        })
    return {"mentions": out, "progress": progress_string(batch_dir=batch_dir, reviewer_id=user)}


@review.get("/mention/{mention_id}")
def review_mention(mention_id: str, user: str = Depends(get_user), batch_dir: Path = Depends(get_batch_dir)) -> dict:
    m = _find_mention(batch_dir, mention_id)
    verdicts = _live_verdicts(batch_dir, user)
    return {
        "mention": m.model_dump(mode="json"),
        "source": _read_source(batch_dir, m.note_id),
        "prior_verdict": verdicts.get(mention_id),
        "progress": progress_string(batch_dir=batch_dir, reviewer_id=user),
    }


@review.post("/verdict")
def review_post_verdict(req: VerdictRequest, user: str = Depends(get_user), batch_dir: Path = Depends(get_batch_dir)) -> dict:
    submit_verdict(batch_dir=batch_dir, verdict=_build_verdict_from_payload(batch_dir, req, user))
    return {"ok": True}


@review.post("/amend")
def review_amend(req: VerdictRequest, user: str = Depends(get_user), batch_dir: Path = Depends(get_batch_dir)) -> dict:
    amend_verdict(batch_dir=batch_dir, verdict=_build_verdict_from_payload(batch_dir, req, user))
    return {"ok": True}


@review.post("/clear")
def review_clear(req: ClearMentionRequest, user: str = Depends(get_user), batch_dir: Path = Depends(get_batch_dir)) -> dict:
    clear_verdict(batch_dir=batch_dir, reviewer_id=user, mention_id=req.mention_id)
    return {"ok": True}


app.include_router(review)


# ── Adjudicate API ────────────────────────────────────────────────────────────
adjudicate = APIRouter(prefix="/api/adjudicate", dependencies=[Depends(require_adjudicator)])


def _adjud_progress(batch_dir: Path) -> str:
    merged = _load_merged(batch_dir)
    need_ids = {m.mention_id for m in merged if m.needs_adjudication}
    done = len(_load_adjudicated_ids(batch_dir) & need_ids)
    return f"{done}/{len(need_ids)} done"


def _disagreement_payload(batch_dir: Path, m, include_prior: bool = True) -> dict:
    payload = {
        "done": False, "progress": _adjud_progress(batch_dir),
        "mention_id": m.mention_id,
        "agent": m.agent.model_dump(mode="json"),
        "source": _read_source(batch_dir, m.agent.note_id),
        "disagreement_type": m.disagreement_type,
        "verdicts": [v.model_dump(mode="json") for v in m.verdicts],
    }
    if include_prior:
        prior = latest_adjud_decision(batch_dir, m.mention_id)
        payload["prior_decision"] = prior.model_dump(mode="json") if prior else None
    return payload


class DecisionRequest(BaseModel):
    mention_id: str
    action: str   # "take_a" | "take_b" | "new_value" | "defer"
    rationale: str = ""
    verdict: Optional[str] = None
    concept_name: Optional[str] = None
    entity_type: Optional[str] = None
    span: Optional[list[int]] = None


class ClearAdjudicationRequest(BaseModel):
    mention_id: str


@adjudicate.get("/next")
def adjud_next(user: str = Depends(get_user), batch_dir: Path = Depends(get_batch_dir)) -> dict:
    m = next_pending_disagreement(batch_dir)
    if m is None:
        return {"done": True, "progress": _adjud_progress(batch_dir)}
    return _disagreement_payload(batch_dir, m)


@adjudicate.get("/disagreements")
def adjud_list(user: str = Depends(get_user), batch_dir: Path = Depends(get_batch_dir)) -> dict:
    merged = _load_merged(batch_dir)
    rows = []
    for i, m in enumerate(merged):
        if not m.needs_adjudication:
            continue
        prior = latest_adjud_decision(batch_dir, m.mention_id)
        rows.append({
            "index": i, "mention_id": m.mention_id, "text": m.agent.text,
            "note_id": m.agent.note_id, "person_id": m.agent.person_id,
            "entity_type": m.agent.entity_type, "concept_name": m.agent.concept_name,
            "status": m.agent.status, "disagreement_type": m.disagreement_type,
            "verdicts": [
                {"reviewer_id": v.reviewer_id, "verdict": v.verdict,
                 "corrected": v.corrected.model_dump(mode="json") if v.corrected else None}
                for v in m.verdicts
            ],
            "decision": prior.model_dump(mode="json") if prior else None,
        })
    return {"disagreements": rows, "progress": _adjud_progress(batch_dir)}


@adjudicate.get("/disagreement/{mention_id}")
def adjud_get(mention_id: str, user: str = Depends(get_user), batch_dir: Path = Depends(get_batch_dir)) -> dict:
    m = next(
        (r for r in _load_merged(batch_dir) if r.mention_id == mention_id and r.needs_adjudication),
        None,
    )
    if m is None:
        raise HTTPException(404, f"mention_id {mention_id} is not a pending disagreement")
    return _disagreement_payload(batch_dir, m)


@adjudicate.get("/iaa")
def adjud_iaa(user: str = Depends(get_user), batch_dir: Path = Depends(get_batch_dir)) -> dict:
    """Return the IAA report (iaa.json) for context while adjudicating."""
    iaa_path = batch_dir / "iaa.json"
    if not iaa_path.exists():
        raise HTTPException(404, f"iaa.json not generated yet — run merge_iaa.py first")
    return json.loads(iaa_path.read_text(encoding="utf-8"))


@adjudicate.post("/decide")
def adjud_decide(req: DecisionRequest, user: str = Depends(get_user), batch_dir: Path = Depends(get_batch_dir)) -> dict:
    merged = next(
        (m for m in _load_merged(batch_dir) if m.mention_id == req.mention_id),
        None,
    )
    if merged is None:
        raise HTTPException(404, f"mention_id {req.mention_id} not in merged.jsonl")
    now = _now_iso()

    if req.action == "defer":
        rec = defer_decision(merged=merged, adjudicator_id=user, decided_at=now)
    elif req.action in ("take_a", "take_b"):
        pick = 0 if req.action == "take_a" else 1
        rec = take_reviewer_decision(
            merged=merged, pick_index=pick, adjudicator_id=user,
            rationale=req.rationale, decided_at=now,
        )
    elif req.action == "new_value":
        if not req.verdict:
            raise HTTPException(400, "new_value requires verdict")
        span_obj = None
        if req.span and len(req.span) == 2:
            span_obj = Span(start=req.span[0], end=req.span[1])
        rec = AdjudicationRecord(
            mention_id=merged.mention_id,
            reviewer_verdicts=merged.verdicts,
            disagreement_type=merged.disagreement_type,
            adjudicator_id=user,
            final=AdjudicationFinal(
                verdict=req.verdict,
                concept_name=req.concept_name or None,
                entity_type=req.entity_type or None,
                span=span_obj,
            ),
            rationale=req.rationale, decided_at=now, deferred=False,
        )
    else:
        raise HTTPException(400, f"unknown action {req.action!r}")

    write_adjudication(batch_dir=batch_dir, record=rec)
    return {"ok": True}


@adjudicate.post("/clear")
def adjud_clear(req: ClearAdjudicationRequest, user: str = Depends(get_user), batch_dir: Path = Depends(get_batch_dir)) -> dict:
    clear_adjudication(batch_dir=batch_dir, mention_id=req.mention_id)
    return {"ok": True}


app.include_router(adjudicate)


# ── Ontology API ──────────────────────────────────────────────────────────────
ontology = APIRouter(prefix="/api/ontology", dependencies=[Depends(require_maintainer)])


def _ontology_progress() -> str:
    props = load_proposals(ONTOLOGY_ROOT)
    decided_ids = {d["proposal_id"] for d in load_live_decisions(ONTOLOGY_ROOT)}
    pending = [p for p in props if p.proposal_id not in decided_ids]
    decided = len(props) - len(pending)
    return f"{decided}/{len(props)} done"


def _proposal_payload(batch_dir: Path, p) -> dict:
    # For each note where the surface form was seen, attach the source text +
    # offset of the first occurrence so the maintainer can read it in context.
    # Cap to the first 3 note_ids to keep payload size sane.
    sources: list[dict] = []
    surface_lower = p.surface_form.lower()
    for nid in p.case_ids[:3]:
        src = _read_source(batch_dir, nid)
        if not src:
            continue
        idx = src.find(p.surface_form)
        if idx < 0:
            idx = src.lower().find(surface_lower)
        if idx < 0:
            continue
        sources.append({
            "note_id": nid,
            "source": src,
            "start": idx,
            "end": idx + len(p.surface_form),
        })
    return {
        "proposal_id": p.proposal_id,
        "surface_form": p.surface_form,
        "normalized_form": p.normalized_form,
        "occurrence_count": p.occurrence_count,
        "note_ids": p.case_ids,
        "sources": sources,
        "reviewer_proposals": [
            {"reviewer_id": rp.reviewer_id, "suggested_name": rp.suggested_name,
             "suggested_parent": rp.suggested_parent, "rationale": rp.rationale}
            for rp in p.reviewer_proposals
        ],
        "frequency_threshold_met": p.frequency_threshold_met,
        "reviewer_proposal_count": p.reviewer_proposal_count,
        "ready_for_review": p.ready_for_review,
        "prior_decision": latest_ontology_decision(ONTOLOGY_ROOT, p.proposal_id),
    }


class OntologyDecisionRequest(BaseModel):
    proposal_id: str
    decision: str  # "accept" | "accept-as-synonym" | "reject" | "defer"
    rationale: str = ""
    final_name: Optional[str] = None
    parent: Optional[str] = None
    entity_type: Optional[str] = None
    synonym_target: Optional[str] = None


class ClearOntologyRequest(BaseModel):
    proposal_id: str


@ontology.get("/proposals")
def ontology_list(user: str = Depends(get_user), batch_dir: Path = Depends(get_batch_dir)) -> dict:
    rows = [_proposal_payload(batch_dir, p) for p in load_proposals(ONTOLOGY_ROOT)]
    return {"proposals": rows, "progress": _ontology_progress()}


@ontology.get("/next")
def ontology_next(user: str = Depends(get_user), batch_dir: Path = Depends(get_batch_dir)) -> dict:
    decided_ids = {d["proposal_id"] for d in load_live_decisions(ONTOLOGY_ROOT)}
    pending = [p for p in load_proposals(ONTOLOGY_ROOT) if p.proposal_id not in decided_ids]
    if not pending:
        return {"done": True, "progress": _ontology_progress()}
    ready_first = sorted(pending, key=lambda p: 0 if p.ready_for_review else 1)
    p = ready_first[0]
    return {"done": False, "progress": _ontology_progress(), **_proposal_payload(batch_dir, p)}


@ontology.get("/proposal/{proposal_id}")
def ontology_get(proposal_id: str, user: str = Depends(get_user), batch_dir: Path = Depends(get_batch_dir)) -> dict:
    p = next((x for x in load_proposals(ONTOLOGY_ROOT) if x.proposal_id == proposal_id), None)
    if p is None:
        raise HTTPException(404, f"proposal {proposal_id} not found")
    return {"done": False, "progress": _ontology_progress(), **_proposal_payload(batch_dir, p)}


@ontology.post("/decide")
def ontology_decide(req: OntologyDecisionRequest, user: str = Depends(get_user)) -> dict:
    now = _now_iso()
    if req.decision == "accept":
        if not (req.final_name and req.parent):
            raise HTTPException(400, "accept requires final_name and parent")
        resolved_entity_type = _resolve_accept_entity_type(req.parent, req.entity_type)
        decision = {
            "proposal_id": req.proposal_id, "decision": "accept",
            "final": {"concept_name": req.final_name, "parent": req.parent,
                      "entity_type": resolved_entity_type},
            "maintainer_id": user, "rationale": req.rationale, "decided_at": now,
        }
    elif req.decision == "accept-as-synonym":
        if not req.synonym_target:
            raise HTTPException(400, "accept-as-synonym requires synonym_target")
        decision = {
            "proposal_id": req.proposal_id, "decision": "accept-as-synonym",
            "final": {"synonym_target": req.synonym_target},
            "maintainer_id": user, "rationale": req.rationale, "decided_at": now,
        }
    elif req.decision == "reject":
        decision = {
            "proposal_id": req.proposal_id, "decision": "reject", "final": None,
            "maintainer_id": user, "rationale": req.rationale, "decided_at": now,
        }
    elif req.decision == "defer":
        decision = {
            "proposal_id": req.proposal_id, "decision": "defer", "final": None,
            "maintainer_id": user, "rationale": req.rationale or "(deferred)", "decided_at": now,
        }
    else:
        raise HTTPException(400, f"unknown decision {req.decision!r}")
    write_decision(ontology_root=ONTOLOGY_ROOT, decision=decision)
    return {"ok": True}


@ontology.post("/clear")
def ontology_clear(req: ClearOntologyRequest, user: str = Depends(get_user)) -> dict:
    clear_ontology_decision(ontology_root=ONTOLOGY_ROOT, proposal_id=req.proposal_id)
    return {"ok": True}


app.include_router(ontology)


# ── HTML templates ────────────────────────────────────────────────────────────
# Login page (simple name picker). Filled by `login_page()` with `__OPTIONS__`
# replaced with one <option> per known user, and `__BATCH__` with the batch id.
LOGIN_HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Login · BSO-AD Curation Workbench</title>
<style>
:root {
  --bg:#fafbfc; --bg-card:#fff; --bg-muted:#f6f8fa;
  --border:#d0d7de; --border-muted:#e6eaef;
  --text:#1f2328; --text-muted:#57606a;
  --accent:#0969da; --accent-bg:#ddf4ff;
  --success:#1a7f37; --success-hover:#157a31;
  --shadow:0 16px 40px rgba(15,20,25,.10), 0 4px 12px rgba(31,35,40,.04);
  --font-sans:-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --font-mono:ui-monospace, SFMono-Regular, Menlo, monospace;
}
* { box-sizing: border-box; }
body { font: 14px/1.55 var(--font-sans); margin: 0; min-height: 100vh;
       background: var(--bg); color: var(--text);
       display: flex; align-items: center; justify-content: center;
       -webkit-font-smoothing: antialiased; }
.card { background: var(--bg-card); padding: 32px 36px; border-radius: 14px;
        box-shadow: var(--shadow); width: 420px; max-width: 92vw;
        border: 1px solid var(--border-muted); }
.brand { font-size: 20px; font-weight: 700; letter-spacing: -.02em; margin-bottom: 4px; }
.subtitle { color: var(--text-muted); font-size: 13px; margin-bottom: 22px; }
.subtitle code { background: var(--bg-muted); padding: 2px 8px; border-radius: 4px;
                 font: 12.5px var(--font-mono); }
label { display: block; font: 600 11px var(--font-sans); color: var(--text-muted);
        text-transform: uppercase; letter-spacing: .06em; margin: 14px 0 5px; }
select, input { width: 100%; padding: 9px 12px; border: 1px solid var(--border);
                border-radius: 6px; font: 14px var(--font-sans); background: var(--bg-card); }
select:focus, input:focus { outline: 0; border-color: var(--accent);
                             box-shadow: 0 0 0 3px var(--accent-bg); }
button[type=submit] { margin-top: 22px; width: 100%; padding: 11px;
                      border-radius: 6px; border: 0; background: var(--success);
                      color: white; font: 600 14px var(--font-sans); cursor: pointer; }
button[type=submit]:hover { background: var(--success-hover); }
button[type=submit]:focus,
button[type=submit]:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.divider { text-align: center; color: var(--text-muted); font-size: 12px;
           margin: 14px 0 6px; position: relative; }
.divider::before, .divider::after { content: ""; position: absolute; top: 50%;
                                     width: calc(50% - 28px); border-top: 1px solid var(--border-muted); }
.divider::before { left: 0; }
.divider::after { right: 0; }
.hint { color: var(--text-muted); font-size: 12px; margin-top: 14px; line-height: 1.5; }
</style>
</head>
<body>
<form class="card" method="post" action="/login">
  <div class="brand">BSO-AD Curation Workbench</div>
  <div class="subtitle">batch <code>__BATCH__</code></div>

  <label for="name">Who are you?</label>
  <select id="name" name="name">
    <option value="">— select a known user —</option>
    __OPTIONS__
  </select>

  <div class="divider">or</div>

  <label for="new_name">New user — type your name</label>
  <input id="new_name" name="new_name" placeholder="e.g. erin" autocomplete="off">

  <button type="submit">Continue</button>

  <p class="hint">No password — the workbench just labels your verdicts /
    decisions with this name. Your session lasts 30 days unless you log out.</p>
</form>
</body>
</html>
"""

# The big shell — sidebar nav + 3 views + all modals + CSS + JS.
# `__BATCH__` and `__USER__` are substituted at server-render time.
SHELL_HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>BSO-AD Curation Workbench — __USER__ · __BATCH__</title>
<style>
/* ─── Design tokens ─────────────────────────────────────────────────────── */
:root {
  --bg:#eef1f4; --bg-app:#f5f6f8; --bg-card:#fff; --bg-muted:#f0f2f5; --bg-subtle:#f7f8fa;
  --border:#d0d7de; --border-muted:#e6eaef;
  --text:#1f2328; --text-muted:#57606a; --text-subtle:#8b949e;
  --accent:#0969da; --accent-hover:#0550ae; --accent-bg:#ddf4ff;
  --success:#1a7f37; --success-hover:#157a31; --success-bg:#dafbe1;
  --warning:#9a6700; --warning-bg:#fff8c5; --warning-border:#d4a72c;
  --danger:#b1361b; --danger-bg:#ffebe9;
  --shadow-sm:0 1px 0 rgba(31,35,40,.04), 0 1px 2px rgba(31,35,40,.04);
  --shadow-lg:0 16px 40px rgba(15,20,25,.18), 0 4px 12px rgba(31,35,40,.08);
  --radius-sm:4px; --radius:8px; --radius-lg:12px;
  --font-sans:-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --font-mono:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --sidebar-w: 220px;
  --highlight-ent: rgba(255,199,7,.42);  /* entity span highlight */
  --overlay: rgba(15,20,25,.50);         /* modal backdrop */
  --text-inverted: #fff;                  /* text on accent/success backgrounds */
  --radius-xs: 2px;                       /* micro pill / entity highlight bottom-half */
  --radius-md: 6px;                       /* primary action buttons, login inputs */
}
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.55 var(--font-sans); color: var(--text);
       background: var(--bg-app);
       background-image: radial-gradient(at 20% 0%, rgba(99,141,182,.08) 0px, transparent 40%),
                          radial-gradient(at 80% 100%, rgba(202,180,222,.10) 0px, transparent 50%);
       background-attachment: fixed;
       -webkit-font-smoothing: antialiased; }

/* ─── Shell layout ─────────────────────────────────────────────────────── */
.shell { display: grid; grid-template-columns: var(--sidebar-w) 1fr; min-height: 100vh; }
.sidebar { border-right: 1px solid var(--border-muted); background: var(--bg-card);
           display: flex; flex-direction: column; padding: 20px 14px;
           position: sticky; top: 0; height: 100vh;
           box-shadow: 1px 0 4px rgba(31,35,40,.03); }
.brand { font-size: 15px; font-weight: 700; letter-spacing: -.02em; margin-bottom: 6px; padding: 0 6px; }
.batch-pill { font: 11px var(--font-mono); background: var(--bg-muted);
              color: var(--text-muted); padding: 3px 8px; border-radius: 4px;
              margin: 0 6px 18px; align-self: flex-start; }
.nav-list { display: flex; flex-direction: column; gap: 2px; }
.nav-list a {
    display: flex; align-items: center; gap: 10px;
    padding: 9px 12px; border-radius: 6px;
    text-decoration: none; color: var(--text); font-size: 13.5px; font-weight: 500;
}
.nav-list a:hover { background: var(--bg-muted); }
.nav-list a.active { background: var(--accent-bg); color: var(--accent); font-weight: 600; }
.nav-list a .ico { width: 18px; text-align: center; }
.nav-list a .badge { margin-left: auto; font: 11px var(--font-mono); color: var(--text-muted);
                     background: var(--bg-muted); padding: 1px 7px; border-radius: 10px; }
.nav-list a.active .badge { background: var(--bg-card); color: var(--accent); }

.sidebar .footer { margin-top: auto; padding: 14px 8px 4px; border-top: 1px solid var(--border-muted);
                   font-size: 12px; color: var(--text-muted); }
.sidebar .footer .user { font-weight: 600; color: var(--text); font-size: 13px; margin-bottom: 6px;
                          word-break: break-word; }
.sidebar .footer form { margin: 0; }
.sidebar .footer button {
    background: none; border: 0; padding: 4px 0; cursor: pointer;
    color: var(--accent); font: 500 12px var(--font-sans); text-decoration: underline;
    text-underline-offset: 3px;
}

.main { padding: 24px 32px 60px; min-width: 0; }
.main header { display: flex; justify-content: space-between; align-items: center;
               padding: 0 0 14px; margin-bottom: 18px;
               border-bottom: 1px solid var(--border-muted); }
.main header h1 { margin: 0; font-size: 15px; font-weight: 600; letter-spacing: -.01em; }
.main header h1 code { background: var(--bg-muted); padding: 3px 8px; border-radius: var(--radius-sm);
                       font: 12.5px var(--font-mono); }
.main header .actions { display: flex; gap: 8px; align-items: center; }
.types-button {
    background: var(--bg-card); border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: 6px 12px; cursor: pointer;
    font: 500 12px var(--font-sans); color: var(--text);
}
.types-button:hover { background: var(--bg-muted); border-color: var(--text-subtle); }
.progress { color: var(--text-muted); font-size: 13px;
            font-variant-numeric: tabular-nums; font-weight: 500; }

.view { display: none; }
.view.active { display: block; }

/* ─── Cards ─────────────────────────────────────────────────────────────── */
section { background: var(--bg-card); border: 1px solid var(--border-muted);
          border-radius: var(--radius); padding: 18px 22px; margin-bottom: 14px;
          box-shadow: var(--shadow-sm); }
section h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .06em;
             color: var(--text-subtle); margin: 0 0 12px; font-weight: 600; }
section h2 .disagreement-tag {
    background: var(--danger-bg); color: var(--danger);
    padding: 2px 9px; border-radius: 999px; font: 600 11px var(--font-sans);
    text-transform: none; letter-spacing: 0; margin-left: 8px;
}

.source { white-space: pre-wrap; word-wrap: break-word; line-height: 1.8;
          font-size: 14.5px; background: var(--bg-subtle); padding: 16px 20px;
          border-radius: var(--radius-sm); border: 1px solid var(--border-muted);
          user-select: text; max-height: 320px; overflow-y: auto; color: var(--text); }
.source.span-edit-mode { outline: 2px solid var(--accent); outline-offset: 2px;
                          cursor: text; background: var(--accent-bg); }
.source .ent {
    background: linear-gradient(to bottom, transparent 55%, var(--highlight-ent) 55%);
    padding: 0 2px; border-radius: 2px; font-weight: 600;
    -webkit-box-decoration-break: clone; box-decoration-break: clone;
}
.source-toolbar { display: flex; justify-content: flex-end; margin-bottom: 4px; }
.source-toolbar .reference-link { padding: 0; font-size: 12px; }
.source.full-note { max-height: 480px; }
.span-info { color: var(--text-muted); font-size: 12px; margin-top: 10px;
             font-variant-numeric: tabular-nums; font-family: var(--font-mono); }

.agent-grid { display: grid; grid-template-columns: 130px 1fr; gap: 10px 18px;
              font-size: 13.5px; align-items: baseline; }
.agent-grid .label { color: var(--text-muted); font: 600 11px var(--font-sans);
                     text-transform: uppercase; letter-spacing: .06em; }
.agent-grid > div:not(.label) { font-family: var(--font-mono); font-size: 13px; }

/* Status pills (inline; reused in cards + lists) */
.status-mapped, .status-uncertain, .status-novel {
    display: inline-block; padding: 2px 10px 3px; border-radius: 999px;
    font: 600 11px var(--font-sans); line-height: 1.4;
}
.status-mapped     { background: var(--success-bg); color: var(--success); }
.status-uncertain  { background: var(--warning-bg); color: var(--warning); }
.status-novel      { background: var(--danger-bg);  color: var(--danger); }

.reference-link {
    background: none; border: 0; padding: 0 0 0 10px;
    color: var(--accent); cursor: pointer; font: 500 12px var(--font-sans);
}
.reference-link:hover { text-decoration: underline; text-underline-offset: 3px; color: var(--accent-hover); }
.subtree-panel { display: none; margin-top: 12px; padding: 12px 14px;
                 background: var(--bg-subtle); border: 1px solid var(--border-muted);
                 border-radius: var(--radius-sm); }
.subtree-panel.shown { display: block; }
.subtree-panel pre { margin: 0; max-height: 360px; overflow: auto;
                     font: 12px/1.5 var(--font-mono); white-space: pre; color: var(--text); }
.subtree-panel .head { display: flex; justify-content: space-between; align-items: baseline;
                       margin-bottom: 8px; font-size: 12px; color: var(--text-muted); }
.subtree-panel .tree-node { font: 12px var(--font-mono); padding-top: 2px; padding-bottom: 2px; }
.subtree-panel .tree-node.current-agent { background: var(--accent-bg); border-left: 3px solid var(--accent); color: var(--accent-hover); font-style: normal; font-weight: 600; }

/* Primary action buttons — single-line rows */
.actions-primary { display: flex; flex-direction: column; gap: 5px; }
.actions-primary button {
    text-align: left; padding: 14px 18px; border-radius: var(--radius-md);
    border: 1px solid var(--border); background: var(--bg-card);
    cursor: pointer; font: inherit; display: flex; align-items: center;
    gap: 14px; transition: background .12s, border-color .12s;
    box-shadow: var(--shadow-sm); width: 100%; min-width: 0;
}
.actions-primary button:hover { background: var(--bg-muted); border-color: var(--text-subtle); }
.actions-primary button:active { transform: translateY(1px); }
.actions-primary button .key {
    font: 600 14px var(--font-mono); background: var(--bg-muted);
    padding: 2px 7px; border-radius: 4px; color: var(--text-muted);
    min-width: 28px; height: 28px; line-height: 28px; text-align: center; flex-shrink: 0;
}
.actions-primary button .label {
    font: 500 16px var(--font-sans); color: var(--text); flex-shrink: 0;
}
.actions-primary button.primary {
    background: var(--success); border-color: var(--success);
    box-shadow: 0 1px 0 rgba(0,0,0,.06), 0 0 0 1px rgba(255,255,255,.10) inset;
}
.actions-primary button.primary:hover { background: var(--success-hover); border-color: var(--success-hover); }
.actions-primary button.primary .key { background: rgba(255,255,255,.22); color: var(--text-inverted); }
.actions-primary button.primary .label { color: var(--text-inverted); }

/* Inline form (shared by all 3 views) */
.inline-form { display: none; margin-top: 14px; padding: 16px 18px;
               background: var(--bg-muted); border-radius: var(--radius);
               border: 1px solid var(--border-muted); }
.inline-form.shown { display: block; }
.inline-form .form-title { font-size: 13px; font-weight: 600; margin-bottom: 12px; }
.inline-form label { display: block; font: 600 10.5px var(--font-sans); color: var(--text-muted);
                     text-transform: uppercase; letter-spacing: .06em; margin-bottom: 5px; }
.inline-form input, .inline-form select, .inline-form textarea {
    width: 100%; padding: 8px 12px; border: 1px solid var(--border);
    border-radius: var(--radius-sm); font: 14px var(--font-sans);
    background: var(--bg-card); transition: border-color .12s, box-shadow .12s;
}
.inline-form input:focus, .inline-form select:focus, .inline-form textarea:focus {
    outline: 0; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-bg);
}
.inline-form .field { margin-bottom: 12px; }
.inline-form .row { display: flex; gap: 10px; }
.inline-form .row > .field { flex: 1; }
.inline-form .helper { color: var(--text-muted); font-size: 12px; margin-top: 4px;
                       font-weight: 400; text-transform: none; letter-spacing: 0; }
.inline-form .checkbox-row { display: flex; align-items: center; gap: 10px; }
.inline-form .checkbox-row input[type=checkbox] { width: 16px; height: 16px; accent-color: var(--success); }
.inline-form .checkbox-row label { margin: 0; font-weight: 400; font-size: 13.5px;
                                    text-transform: none; letter-spacing: 0; color: var(--text); }
.inline-form .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 6px; }
.inline-form .actions button {
    padding: 8px 18px; border-radius: var(--radius-sm); border: 1px solid var(--border);
    background: var(--bg-card); cursor: pointer; font: 500 13px var(--font-sans); color: var(--text);
}
.inline-form .actions button.primary {
    background: var(--success); border-color: var(--success); color: var(--text-inverted);
}
.inline-form .actions button.primary:hover { background: var(--success-hover); border-color: var(--success-hover); }

/* Tree picker (ontology Accept form) */
.tree-picker {
    margin-top: 6px; padding: 8px 10px;
    background: var(--bg-subtle); border: 1px solid var(--border-muted);
    border-radius: 6px; max-height: 320px; overflow: auto;
}
.tree-picker-header {
    display: flex; gap: 10px; align-items: center;
    margin-bottom: 8px; padding-bottom: 8px;
    border-bottom: 1px dashed var(--border);
    font: 12px var(--font-sans);
}
.tree-picker-header select {
    flex: 0 0 280px; padding: 4px 8px; font: 12px var(--font-sans);
    border: 1px solid var(--border); border-radius: 4px; background: var(--bg-card);
}
.tree-picker-header .helper { color: var(--text-muted); font-size: 11.5px; }
.tree-node {
    padding: 3px 8px; cursor: pointer; border-radius: var(--radius-sm);
    font: 12.5px var(--font-mono); color: var(--text);
    user-select: none;
}
.tree-node:hover { background: var(--bg-muted); }
.tree-node.selected {
    background: var(--accent-bg); color: var(--accent-hover); font-weight: 700;
}
.tree-picker-list {
    margin-top: 4px; max-height: 320px; overflow: auto;
    background: var(--bg-subtle); border: 1px solid var(--border-muted);
    border-radius: 6px; padding: 6px 4px;
}

/* Span preview (review fix_type_span) */
.span-preview { background: var(--warning-bg); border: 1px solid var(--warning-border);
                padding: 10px 14px; border-radius: var(--radius-sm); margin: 10px 0 12px; }
.span-preview .pv-label { text-transform: uppercase; letter-spacing: .06em;
                          font: 600 10.5px var(--font-sans); color: var(--warning); margin-bottom: 5px; }
.span-preview .pv-text { font: 14px var(--font-mono); word-break: break-word; color: var(--text); }
.span-preview .pv-text.invalid { color: var(--danger); font-style: italic; }

/* Reviewed/decided lock (re-annotate / redo) */
.lock-card { background: var(--bg-muted); border: 1px solid var(--border-muted);
             padding: 16px 18px; border-radius: var(--radius); }
.lock-card .head { font-size: 13px; color: var(--text-muted); margin-bottom: 10px; font-weight: 500; }
.lock-card .prior { font: 13px var(--font-mono); background: var(--bg-card);
                    padding: 10px 14px; border-radius: var(--radius-sm);
                    border: 1px solid var(--border-muted); margin-bottom: 14px;
                    word-break: break-word; line-height: 1.5; }
.lock-card .prior .rat { color: var(--text-muted); font-style: italic; margin-top: 6px; font-size: 12.5px; }
.lock-card button.clear { padding: 9px 20px; border-radius: var(--radius-sm);
                           border: 1px solid var(--warning-border); background: var(--warning-bg);
                           cursor: pointer; font: 500 13px var(--font-sans); color: var(--text); }
.lock-card button.clear:hover { background: #fff3cd; }

/* Adjudicate reviewer-pair cards */
.reviewers { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.rev-card { background: var(--bg-subtle); border: 1.5px solid var(--border-muted);
            border-radius: var(--radius); padding: 14px 16px; transition: border-color .12s, box-shadow .12s; }
.rev-card .rev-name { font-weight: 600; font-size: 13px; margin-bottom: 10px; display: flex;
                       align-items: center; gap: 8px; }
.rev-card .rev-verdict-pill { display: inline-block; padding: 2px 9px; border-radius: 999px;
                              font: 600 11px var(--font-sans); background: var(--bg-muted); color: var(--text-muted); }
.rev-card .rev-verdict-pill.confirm { background: var(--success-bg); color: var(--success); }
.rev-card .rev-verdict-pill.correct { background: var(--accent-bg);  color: var(--accent); }
.rev-card .rev-verdict-pill.reject  { background: var(--danger-bg);  color: var(--danger); }
.rev-card .rev-verdict-pill.propose { background: var(--warning-bg); color: var(--warning); }
.rev-card .rev-detail { background: var(--bg-card); border: 1px solid var(--border-muted);
                         border-radius: var(--radius-sm); padding: 8px 12px; margin-bottom: 8px; }
.rev-card .rev-detail .key { font: 600 10.5px var(--font-sans); text-transform: uppercase;
                              letter-spacing: .05em; color: var(--text-muted); margin-bottom: 3px; }
.rev-card .rev-detail code { font: 12.5px var(--font-mono); color: var(--text); display: block;
                              word-break: break-word; }
.rev-card .rev-detail.span-detail { background: var(--warning-bg); border-color: var(--warning-border); }
.rev-card .rev-detail.span-detail .key { color: var(--warning); }
.rev-card .rev-detail.span-detail .span-text {
    font: 14px var(--font-mono); font-weight: 600; color: var(--text);
    word-break: break-word;
}
.rev-card .rev-detail.span-detail .span-offsets {
    font: 11px var(--font-mono); color: var(--text-muted);
    font-variant-numeric: tabular-nums; margin-top: 3px;
}
.rev-card .rev-notes { color: var(--text-muted); font-size: 12.5px;
                       margin-top: 8px; font-style: italic; line-height: 1.5; }
.rev-card.selected { border-color: var(--success); box-shadow: 0 0 0 3px var(--success-bg); }

/* Ontology proposal cards */
.prop-grid { display: grid; grid-template-columns: 150px 1fr; gap: 10px 18px;
             font-size: 13.5px; align-items: baseline; }
.prop-grid .label { color: var(--text-muted); font: 600 11px var(--font-sans);
                    text-transform: uppercase; letter-spacing: .06em; }
.prop-grid code { background: var(--bg-muted); padding: 2px 8px; border-radius: var(--radius-sm);
                  font: 13px var(--font-mono); }
.surface { font: 17px var(--font-sans); font-weight: 600; }
.ready-pill { display: inline-block; padding: 2px 10px 3px; border-radius: 999px;
              font: 600 11px var(--font-sans); margin-left: 8px; }
.ready-pill.yes { background: var(--success-bg); color: var(--success); }
.ready-pill.no  { background: var(--warning-bg); color: var(--warning); }
.rev-prop { background: var(--bg-subtle); border: 1px solid var(--border-muted);
            border-radius: var(--radius-sm); padding: 10px 14px; margin-bottom: 8px; }
.rev-prop .rev-name { font-weight: 600; font-size: 13px; margin-bottom: 6px; }
.rev-prop .rev-row { font-size: 13px; margin-bottom: 3px; line-height: 1.5; }
.rev-prop .rev-row .key { color: var(--text-muted); font: 600 10.5px var(--font-sans);
                          text-transform: uppercase; letter-spacing: .05em;
                          display: inline-block; min-width: 70px; }
.rev-prop .rev-row code { font: 12.5px var(--font-mono); background: var(--bg-muted);
                          padding: 1px 6px; border-radius: var(--radius-sm); }
.rev-prop .rev-rationale { color: var(--text-muted); font-size: 12.5px;
                            margin-top: 6px; font-style: italic; line-height: 1.5; }
.cases-line { font-size: 12.5px; color: var(--text-muted); font-family: var(--font-mono); }

/* Modals */
.modal-backdrop { position: fixed; inset: 0; background: var(--overlay);
                  -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px);
                  display: none; align-items: center; justify-content: center; z-index: 10; }
.modal-backdrop.shown { display: flex; animation: fade-in .14s ease-out; }
@keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
.modal { background: var(--bg-card); padding: 26px 28px; border-radius: var(--radius-lg);
         width: 560px; max-width: 92vw; box-shadow: var(--shadow-lg);
         animation: pop-in .16s ease-out; }
@keyframes pop-in {
    from { opacity: 0; transform: translateY(8px) scale(.98); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
}
.modal h2 { margin: 0 0 14px; font-size: 16px; font-weight: 600; letter-spacing: -.01em; }
.modal label { display: block; font: 600 10.5px var(--font-sans); color: var(--text-muted);
               text-transform: uppercase; letter-spacing: .06em; margin: 14px 0 5px; }
.modal label .normal { text-transform: none; font-weight: 400; color: var(--text-subtle); }
.modal input, .modal select, .modal textarea {
    width: 100%; padding: 8px 12px; border: 1px solid var(--border);
    border-radius: var(--radius-sm); font: 14px var(--font-sans); background: var(--bg-card);
}
.modal input:focus, .modal select:focus, .modal textarea:focus {
    outline: 0; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-bg);
}
.modal .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 18px; }
.modal .actions button {
    padding: 8px 18px; border-radius: var(--radius-sm); border: 1px solid var(--border);
    background: var(--bg-card); cursor: pointer; font: 500 13px var(--font-sans); color: var(--text);
}
.modal .actions button:hover { background: var(--bg-muted); }
.modal .actions button.primary {
    background: var(--success); border-color: var(--success); color: var(--text-inverted);
}
.modal .actions button.primary:hover { background: var(--success-hover); border-color: var(--success-hover); }

/* List rows in overview modals (review mentions / disagreements / proposals) */
.list-row { display: grid; gap: 12px; align-items: center;
            padding: 10px 14px; border-radius: var(--radius-sm); cursor: pointer;
            border: 1px solid transparent; font-size: 13px; margin-bottom: 4px;
            transition: background .12s, border-color .12s; }
.list-row:hover { background: var(--bg-muted); border-color: var(--border); }
.list-row.done    { background: var(--success-bg); }
.list-row.pending { background: var(--bg-card); border-color: var(--border-muted); }
.list-row.deferred{ background: var(--warning-bg); }
.list-row .mark { font-weight: 700; font-size: 14px; text-align: center; }
.list-row.done    .mark { color: var(--success); }
.list-row.pending .mark { color: var(--text-subtle); }
.list-row.deferred .mark { color: var(--warning); }
.list-row .idx { color: var(--text-subtle); font: 12px var(--font-mono); }
.list-row .text { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.list-row .meta, .list-row .verdict {
    font-size: 12px; color: var(--text-muted);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.list-row .meta code { font-size: 11px; background: var(--bg-muted); padding: 1px 6px; border-radius: var(--radius-sm); }
.list-row .type-pill {
    background: var(--danger-bg); color: var(--danger); padding: 2px 9px;
    border-radius: 999px; font: 600 11px var(--font-sans); display: inline-block;
    text-align: center; width: fit-content;
}
.summary { font-size: 13px; color: var(--text-muted); margin-bottom: 14px;
           display: flex; align-items: center; gap: 4px; }
.summary strong { color: var(--text); font-weight: 600; }
.summary .bar { display: inline-block; height: 6px; width: 220px; background: var(--border-muted);
                border-radius: var(--radius-sm); vertical-align: middle; margin: 0 10px; overflow: hidden; }
.summary .bar > span { display: block; height: 100%; background: var(--success); transition: width .3s; }

/* All-mentions per-case grouping */
.am-group { margin-bottom: 18px; }
.am-group:last-child { margin-bottom: 0; }
.am-group-header {
    display: flex; justify-content: space-between; align-items: baseline;
    padding: 8px 6px 8px 10px; margin-bottom: 6px;
    border-bottom: 1px solid var(--border-muted);
    background: linear-gradient(to right, var(--bg-muted) 0%, transparent 100%);
    border-radius: var(--radius-sm);
}
.am-group-title { font: 600 13px var(--font-sans); color: var(--text); }
.am-group-title code {
    background: var(--bg-muted); padding: 1px 8px; border-radius: var(--radius-sm);
    font: 12.5px var(--font-mono); margin-left: 4px;
}
.am-group-meta {
    font-size: 11.5px; color: var(--text-muted); font-variant-numeric: tabular-nums;
}

/* Batch picker rows */
.batch-row {
    display: grid; grid-template-columns: 26px 1fr auto; gap: 12px;
    align-items: center; padding: 10px 14px; border-radius: var(--radius-sm);
    cursor: pointer; border: 1px solid transparent; font-size: 13px;
    margin-bottom: 4px; transition: background .12s, border-color .12s;
}
.batch-row:hover { background: var(--bg-muted); border-color: var(--border); }
.batch-row.current { background: var(--accent-bg); border-color: var(--accent); }
.batch-row .mark { font-weight: 700; color: var(--text-subtle); text-align: center; }
.batch-row.current .mark { color: var(--accent); }
.batch-row .meta { color: var(--text-muted); font: 11px var(--font-mono); }
.batch-row .name { font-weight: 600; }
.batch-row .roles {
    font: 600 11px var(--font-sans); padding: 2px 8px; border-radius: 999px;
    background: var(--bg-muted); color: var(--text-muted);
}
.batch-row .roles.has-role { background: var(--success-bg); color: var(--success); }

/* Downloads list */
.dl-row {
    display: grid; grid-template-columns: 1fr auto auto; gap: 10px;
    align-items: center; padding: 8px 12px; border-radius: 4px;
    border: 1px solid var(--border-muted); margin-bottom: 4px;
    background: var(--bg-card);
}
.dl-row:hover { background: var(--bg-muted); }
.dl-row.missing { opacity: .55; }
.dl-row .name { font: 13px var(--font-mono); }
.dl-row .size { color: var(--text-muted); font-size: 11.5px;
                font-variant-numeric: tabular-nums; }
.dl-row .dl-btn {
    background: var(--bg-card); border: 1px solid var(--border);
    border-radius: 4px; padding: 4px 10px; cursor: pointer;
    font: 500 11.5px var(--font-sans); color: var(--text);
}
.dl-row .dl-btn:hover { background: var(--bg-muted); border-color: var(--text-subtle); }
.dl-row .dl-btn:disabled { opacity: .4; cursor: not-allowed; }
.dl-group-title { font: 600 10.5px var(--font-sans); color: var(--text-muted);
                  text-transform: uppercase; letter-spacing: .06em;
                  margin: 14px 0 6px; }

/* IAA report panel */
.iaa-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.iaa-card {
    background: var(--bg-subtle); border: 1px solid var(--border-muted);
    border-radius: var(--radius-sm); padding: 12px 14px;
}
.iaa-card h3 { font: 600 11px var(--font-sans); text-transform: uppercase;
               letter-spacing: .06em; color: var(--text-muted); margin: 0 0 8px; }
.iaa-row { display: flex; justify-content: space-between; align-items: baseline;
           font-size: 13px; padding: 3px 0; line-height: 1.45; }
.iaa-row .k { color: var(--text-muted); font: 12.5px var(--font-mono); }
.iaa-row .v { font: 600 13px var(--font-mono); font-variant-numeric: tabular-nums; }
.iaa-row .v.good { color: var(--success); }
.iaa-row .v.poor { color: var(--danger); }
.iaa-row .v.warn { color: var(--warning); }
.iaa-pill { display: inline-block; padding: 2px 10px; border-radius: 999px;
            font: 600 11px var(--font-sans); }
.iaa-pill.danger  { background: var(--danger-bg); color: var(--danger); }
.iaa-pill.warning { background: var(--warning-bg); color: var(--warning); }
.iaa-pill.success { background: var(--success-bg); color: var(--success); }

/* Done banner */
.done-banner { text-align: center; padding: 56px 24px; background: var(--bg-card);
               border-radius: var(--radius); border: 1px solid var(--border-muted);
               box-shadow: var(--shadow-sm); }
.done-banner .check { font-size: 48px; color: var(--success); line-height: 1; margin-bottom: 14px; }
.done-banner .text { font-weight: 600; color: var(--text); font-size: 16px; }
.done-banner .hint { color: var(--text-muted); font-size: 12px; margin-top: 10px; }
</style>
</head>
<body>

<div class="shell">
  <!-- ─── Sidebar ──────────────────────────────────────────────────────── -->
  <aside class="sidebar">
    <div class="brand">BSO-AD Curation</div>
    <button class="batch-pill" id="current-batch-pill" onclick="openBatchesModal()"
            style="background:var(--bg-muted);border:1px solid var(--border);cursor:pointer;text-align:left;width:auto;font:11px var(--font-mono);padding:4px 8px;color:var(--text);margin:0 6px 14px;align-self:flex-start"
            title="click to switch batch">
      📁 __BATCH__ <span style="color:var(--accent);margin-left:4px">▾</span>
    </button>
    <div class="nav-list">
      <a href="#/review" data-view="review">
        <span class="ico">📝</span> Review
        <span class="badge" id="nav-badge-review">—</span>
      </a>
      <a href="#/adjudicate" data-view="adjudicate">
        <span class="ico">⚖️</span> Adjudicate
        <span class="badge" id="nav-badge-adjudicate">—</span>
      </a>
      <a href="#/ontology" data-view="ontology">
        <span class="ico">🌐</span> Ontology
        <span class="badge" id="nav-badge-ontology">—</span>
      </a>
    </div>
    <div class="footer">
      <div class="user">👤 __USER__</div>
      <button onclick="openDownloadsModal()" style="background:none;border:0;padding:0;cursor:pointer;color:var(--accent);font:500 12px var(--font-sans);text-decoration:underline;text-underline-offset:3px;margin-bottom:6px;text-align:left;display:block">⬇ Downloads</button>
      <form method="post" action="/logout"><button type="submit">Log out</button></form>
    </div>
  </aside>

  <!-- ─── Main content ─────────────────────────────────────────────────── -->
  <main class="main">

    <!-- Review view -->
    <section id="view-review" class="view">
      <header>
        <h1>Review</h1>
        <div class="actions">
          <button class="types-button" onclick="reviewGoBack()">← Back to last reviewed</button>
          <button class="types-button" onclick="openAllMentionsModal()">All mentions ▸</button>
          <span class="progress" id="review-progress">—</span>
        </div>
      </header>
      <div class="review-filter-bar" style="margin:6px 0 10px;display:flex;align-items:center;gap:8px">
        <label for="review-note-filter" style="font-size:12px;color:var(--text-muted)">Filter by note:</label>
        <select id="review-note-filter" onchange="reviewNoteFilterChanged()"></select>
      </div>
      <div id="review-card-wrap"></div>
      <div class="done-banner" id="review-done" style="display:none">
        <div class="check">✓</div>
        <div class="text" id="review-done-text">All mentions reviewed.</div>
        <p class="hint" id="review-done-hint">Verdicts are in <code>verdicts/__USER__.jsonl</code>. Switch to <strong>Adjudicate</strong> next.</p>
        <div id="review-done-actions" style="margin-top:8px"></div>
      </div>
    </section>

    <!-- Adjudicate view -->
    <section id="view-adjudicate" class="view">
      <header>
        <h1>Adjudicate</h1>
        <div class="actions">
          <button class="types-button" onclick="openIaaModal()">📊 IAA report</button>
          <button class="types-button" onclick="openAllDisagreementsModal()">All disagreements ▸</button>
          <span class="progress" id="adjud-progress">—</span>
        </div>
      </header>
      <div id="adjud-card-wrap"></div>
      <div class="done-banner" id="adjud-done" style="display:none">
        <div class="check">✓</div>
        <div class="text">All disagreements adjudicated.</div>
        <p class="hint">Switch to <strong>Ontology</strong> to decide proposed concepts, or run <code>compile_gold.py</code> for the final dataset.</p>
      </div>
    </section>

    <!-- No-access banner — shown if user has zero roles -->
    <div id="no-access-banner" class="done-banner" style="display:none">
      <div class="check">🔒</div>
      <div class="text">You don't have access to any role in this batch.</div>
      <p class="hint">Ask the batch admin to add you as a reviewer, adjudicator, or maintainer
        (via <code>workbench.py --reviewer/--adjudicator/--maintainer</code>, or by editing
        <code>manifest.json</code>), then log out and back in.</p>
    </div>

    <!-- Ontology view -->
    <section id="view-ontology" class="view">
      <header>
        <h1>Ontology decisions</h1>
        <div class="actions">
          <button class="types-button" onclick="openAllProposalsModal()">All proposals ▸</button>
          <span class="progress" id="ontology-progress">—</span>
        </div>
      </header>
      <div id="ontology-card-wrap"></div>
      <div class="done-banner" id="ontology-done" style="display:none">
        <div class="check">✓</div>
        <div class="text">All proposals decided.</div>
        <p class="hint">Run <code>ontology_apply.py</code> to merge into the next ontology version.</p>
      </div>
    </section>

  </main>
</div>

<!-- ─── Modals (shared between views) ────────────────────────────────────── -->

<!-- Batches picker -->
<div class="modal-backdrop" id="batches-modal">
  <div class="modal" style="width:760px; max-height:84vh; overflow-y:auto">
    <h2>Switch batch</h2>
    <p style="color:var(--text-muted);font-size:12px;margin:0 0 .8em">
      Pick a batch to work on. Your roles per batch are shown on the right;
      no role means downloads-only.
    </p>
    <div id="batches-list">loading…</div>
    <div class="actions"><button onclick="closeBatchesModal()">Close</button></div>
  </div>
</div>

<!-- Downloads -->
<div class="modal-backdrop" id="downloads-modal">
  <div class="modal" style="width:680px; max-height:84vh; overflow-y:auto">
    <h2>Downloads</h2>
    <p style="color:var(--text-muted);font-size:12px;margin:0 0 .8em">
      Files for the current batch + cross-batch ontology artifacts.
      Disabled = not generated yet.
    </p>
    <div id="downloads-list">loading…</div>
    <div class="actions"><button onclick="closeDownloadsModal()">Close</button></div>
  </div>
</div>

<!-- IAA report (adjudicate) -->
<div class="modal-backdrop" id="iaa-modal">
  <div class="modal" style="width:760px; max-height:84vh; overflow-y:auto">
    <h2>IAA report</h2>
    <p style="color:var(--text-muted);font-size:12px;margin:0 0 .8em">
      Inter-annotator agreement + agent-quality correlation. Updated each time
      merge_iaa.py runs.
    </p>
    <div id="iaa-body">loading…</div>
    <div class="actions"><button onclick="closeIaaModal()">Close</button></div>
  </div>
</div>

<!-- Entity types reference -->
<div class="modal-backdrop" id="entity-types-modal">
  <div class="modal" style="width:780px; max-height:84vh; overflow-y:auto">
    <h2>Entity types in the BSO-AD ontology</h2>
    <p style="color:var(--text-muted);font-size:12px;margin:0 0 .8em">Click any row to expand that subtree.</p>
    <div id="et-list">loading…</div>
    <div class="actions"><button onclick="closeEntityTypesModal()">Close</button></div>
  </div>
</div>

<!-- All-mentions overview (review) -->
<div class="modal-backdrop" id="all-mentions-modal">
  <div class="modal" style="width:920px; max-height:86vh; overflow-y:auto">
    <h2>All mentions in this batch</h2>
    <div class="summary" id="am-summary">loading…</div>
    <div id="am-list"></div>
    <div class="actions"><button onclick="closeAllMentionsModal()">Close</button></div>
  </div>
</div>

<!-- All-disagreements overview (adjudicate) -->
<div class="modal-backdrop" id="all-disagreements-modal">
  <div class="modal" style="width:920px; max-height:86vh; overflow-y:auto">
    <h2>All disagreements in this batch</h2>
    <div class="summary" id="ad-summary">loading…</div>
    <div id="ad-list"></div>
    <div class="actions"><button onclick="closeAllDisagreementsModal()">Close</button></div>
  </div>
</div>

<!-- All-proposals overview (ontology) -->
<div class="modal-backdrop" id="all-proposals-modal">
  <div class="modal" style="width:920px; max-height:86vh; overflow-y:auto">
    <h2>All ontology proposals</h2>
    <div class="summary" id="ap-summary">loading…</div>
    <div id="ap-list"></div>
    <div class="actions"><button onclick="closeAllProposalsModal()">Close</button></div>
  </div>
</div>

<!-- Ontology proposal attachment modal (review) -->
<div class="modal-backdrop" id="ontology-modal">
  <div class="modal">
    <h2>Add ontology proposal</h2>
    <label>Action</label>
    <select id="op-action">
      <option value="add_new">add_new — propose a new concept</option>
      <option value="add_as_synonym_of">add_as_synonym_of — propose as synonym of existing</option>
    </select>
    <label>Suggested name</label>
    <input id="op-name" placeholder="e.g. Spousal_Caregiver_Burden">
    <label>Suggested parent <span class="normal">(optional)</span></label>
    <input id="op-parent" placeholder="e.g. Element_Relevant_to_Social_and_Community_Context">
    <label>Rationale</label>
    <textarea id="op-rationale" rows="3" placeholder="why this concept belongs in the ontology"></textarea>
    <div class="actions">
      <button onclick="closeOntologyModal()">Cancel</button>
      <button class="primary" onclick="submitWithProposal()">Submit confirm + proposal</button>
    </div>
  </div>
</div>

<script>
// ═══════════════════════════════════════════════════════════════════════
//   Workbench JS — sidebar router + 3 view controllers
// ═══════════════════════════════════════════════════════════════════════

// ─── Generic helpers ─────────────────────────────────────────────────────
function escapeHtml(s) {
  return (s || "").toString().replace(/[&<>"']/g,
    c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
// Escape for safe embedding inside a JS single-quoted string that itself
// lives inside an HTML attribute value (eg. onclick="foo('${escapeJsStr(x)}')").
// HTML attribute de-escaping turns &#39; back into ', which would terminate
// the JS string — so prepend a backslash before any ' or \ first; HTML escape
// can then run on top safely (escapeHtml -> &#39; -> de-escape -> JS sees \\').
function escapeJsStr(s) {
  return (s || "").toString().replace(/[\\']/g, c => "\\" + c);
}
async function apiGet(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}
async function apiPost(url, body) {
  const r = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) { alert("request failed: " + await r.text()); throw new Error(`${url} failed`); }
  return r.json();
}

// Shared state
let entityTypes = [];   // [{name, n_concepts}]
let userRoles = [];      // ["reviewer"] / ["adjudicator"] / etc — set by loadMe()
const subtreeCache = {};

// Map view name → required role
const VIEW_ROLE = { review: "reviewer", adjudicate: "adjudicator", ontology: "maintainer" };

async function loadEntityTypes() {
  const d = await apiGet("/api/concepts/entity_types");
  entityTypes = d.entity_types || [];
}

async function loadMe() {
  const d = await apiGet("/api/me");
  userRoles = d.roles || [];
  // Hide nav items the user can't access
  document.querySelectorAll(".nav-list a").forEach(a => {
    a.style.display = userRoles.includes(VIEW_ROLE[a.dataset.view]) ? "" : "none";
  });
}

// ─── Routing ─────────────────────────────────────────────────────────────
function firstAccessibleView() {
  for (const v of ["review", "adjudicate", "ontology"]) {
    if (userRoles.includes(VIEW_ROLE[v])) return v;
  }
  return null;
}
function canAccess(view) { return userRoles.includes(VIEW_ROLE[view]); }
function currentView() {
  const h = location.hash || "";
  let v = h.slice(2);
  if (!v || !canAccess(v)) {
    const fallback = firstAccessibleView();
    if (fallback) { if (location.hash !== `#/${fallback}`) location.hash = `#/${fallback}`; return fallback; }
    return null;  // No accessible views
  }
  return v;
}
function showView(name) {
  // No accessible views → friendly empty state
  if (!name) {
    document.querySelectorAll(".view").forEach(s => s.classList.remove("active"));
    document.getElementById("no-access-banner").style.display = "block";
    return;
  }
  document.getElementById("no-access-banner").style.display = "none";
  document.querySelectorAll(".view").forEach(s => s.classList.toggle("active", s.id === `view-${name}`));
  document.querySelectorAll(".nav-list a").forEach(a => a.classList.toggle("active", a.dataset.view === name));
  if (name === "review")      reviewLoadNext();
  if (name === "adjudicate")  adjudLoadNext();
  if (name === "ontology")    ontologyLoadNext();
}
window.addEventListener("hashchange", () => showView(currentView()));

// Sidebar nav badges — only fetch endpoints the user has access to.
async function refreshBadges() {
  const tasks = [];
  if (userRoles.includes("reviewer"))
    tasks.push(apiGet("/api/review/mentions").then(d => {
      const done = d.mentions.filter(m => m.verdict).length;
      document.getElementById("nav-badge-review").textContent = `${done}/${d.mentions.length}`;
    }).catch(() => {}));
  if (userRoles.includes("adjudicator"))
    tasks.push(apiGet("/api/adjudicate/disagreements").then(d => {
      const done = d.disagreements.filter(x => x.decision && !x.decision.deferred).length;
      document.getElementById("nav-badge-adjudicate").textContent = `${done}/${d.disagreements.length}`;
    }).catch(() => {}));
  if (userRoles.includes("maintainer"))
    tasks.push(apiGet("/api/ontology/proposals").then(d => {
      const done = d.proposals.filter(p => p.prior_decision).length;
      document.getElementById("nav-badge-ontology").textContent = `${done}/${d.proposals.length}`;
    }).catch(() => {}));
  await Promise.all(tasks);
}

// ─── Status indicator (used in all views' agent_proposal sections) ───────
function statusConceptHtml(m) {
  if (m.concept_name) {
    return `<code>${escapeHtml(m.concept_name)}</code>` +
      ((m.status === "mapped" || m.status === "mapped_uncertain")
        ? ` <span class="status-mapped" style="margin-left:8px;vertical-align:middle">✓ in ontology</span>`
        : "");
  }
  return `<span class="status-novel" style="vertical-align:middle;padding:4px 14px 5px;font-size:12px">⚠ not in ontology — needs your review</span>`;
}

// ─── Source pane with toggleable full-note view ─────────────────────────
// Returns { html, prefixLen, ctxL } for a source pane.
// opts: { showFull: bool, onToggle: string (JS expression), containerId: string,
//         spanId: string }
function renderSourceHtml(mention, source, opts) {
  const showFull = !!opts.showFull;
  let ctxL, ctxR, prefix, suffix;
  if (showFull) {
    ctxL = 0; ctxR = source.length;
    prefix = ""; suffix = "";
  } else {
    ctxL = Math.max(0, mention.start - 300);
    ctxR = Math.min(source.length, mention.end + 300);
    prefix = ctxL > 0 ? "…" : "";
    suffix = ctxR < source.length ? "…" : "";
  }
  const before = source.slice(ctxL, mention.start);
  const mentionText = source.slice(mention.start, mention.end);
  const after = source.slice(mention.end, ctxR);
  const label = showFull ? "Show context" : "📖 View full note";
  const containerId = opts.containerId || "source-pane";
  const spanId = opts.spanId || "mention-hl";
  const fullCls = showFull ? " full-note" : "";
  const html = `
    <div class="source-toolbar"><button type="button" class="reference-link" onclick="${opts.onToggle}">${label}</button></div>
    <div class="source${fullCls}" id="${containerId}">${escapeHtml(prefix + before)}<span class="ent" id="${spanId}">${escapeHtml(mentionText)}</span>${escapeHtml(after + suffix)}</div>
  `;
  return { html, prefixLen: prefix.length, ctxL };
}

// ═══════════════════════════════════════════════════════════════════════
//   REVIEW view
// ═══════════════════════════════════════════════════════════════════════
let reviewMention = null, reviewSource = "", reviewCtxL = 0, reviewPrefixLen = 0;
let reviewFullSource = false;
let reviewShownAt = 0, reviewPrior = null, reviewPendingNotes = "";
let reviewNoteFilter = "";       // "" → all notes; otherwise restrict to this note_id
let reviewNoteIndex = [];        // [{note_id, n_mentions, n_reviewed}, ...]

function summarizePriorVerdict(pv, source) {
  if (!pv) return "(none)";
  let s = pv.verdict;
  const c = pv.corrected || {};
  if (c.concept_name) s += ` → concept = ${c.concept_name}`;
  if (c.entity_type)  s += ` → entity_type = ${c.entity_type}`;
  if (c.span) {
    s += ` → span = [${c.span.start}, ${c.span.end})`;
    if (source) s += ` "${source.slice(c.span.start, c.span.end)}"`;
  }
  if (pv.ontology_proposal) s += " + ontology proposal";
  if (pv.notes) s += `  · notes: ${pv.notes}`;
  return s;
}

function reviewNoteFilterQS() {
  return reviewNoteFilter ? `?note_id=${encodeURIComponent(reviewNoteFilter)}` : "";
}

async function reviewLoadNoteIndex() {
  try {
    const d = await apiGet("/api/review/note_index");
    reviewNoteIndex = d.notes || [];
    const sel = document.getElementById("review-note-filter");
    if (!sel) return;
    const total = d.total || 0;
    const opts = [`<option value="">All notes (${total})</option>`];
    for (const n of reviewNoteIndex) {
      const selAttr = (n.note_id === reviewNoteFilter) ? " selected" : "";
      opts.push(`<option value="${escapeHtml(n.note_id)}"${selAttr}>${escapeHtml(n.note_id)} (${n.n_mentions})</option>`);
    }
    sel.innerHTML = opts.join("");
  } catch (e) { /* no role / no batch — ignore */ }
}

async function reviewNoteFilterChanged() {
  const sel = document.getElementById("review-note-filter");
  reviewNoteFilter = sel ? sel.value : "";
  await reviewLoadNext();
}

async function reviewLoadNext() {
  // Always refresh the per-note index so counts stay current after a verdict.
  await reviewLoadNoteIndex();
  const d = await apiGet("/api/review/next" + reviewNoteFilterQS());
  reviewRenderCard(d);
  refreshBadges();
}

// Toggle full-note view on the Review source pane WITHOUT re-rendering the
// rest of the card (verdict buttons, inline forms, etc. stay intact).
function reviewToggleFullSource() {
  if (!reviewMention) return;
  reviewFullSource = !reviewFullSource;
  const section = document.getElementById("review-source-section");
  if (!section) return;
  const sourceRender = renderSourceHtml(reviewMention, reviewSource, {
    showFull: reviewFullSource,
    onToggle: "reviewToggleFullSource()",
    containerId: "review-source-text",
    spanId: "review-mention-hl",
  });
  reviewCtxL = sourceRender.ctxL;
  reviewPrefixLen = sourceRender.prefixLen;
  // Replace the existing toolbar + source div (everything between <h2> and .span-info).
  const h2 = section.querySelector("h2");
  const spanInfo = section.querySelector(".span-info");
  // Build a fragment from sourceRender.html and insert between h2 and span-info.
  const tmp = document.createElement("div");
  tmp.innerHTML = sourceRender.html;
  // Remove old toolbar + source.
  const oldToolbar = section.querySelector(".source-toolbar");
  const oldSource = section.querySelector(".source");
  if (oldToolbar) oldToolbar.remove();
  if (oldSource) oldSource.remove();
  // Re-insert new nodes before .span-info.
  while (tmp.firstChild) section.insertBefore(tmp.firstChild, spanInfo);
  // If we expanded, scroll the mention into view within the source container.
  if (reviewFullSource) {
    const span = document.getElementById("review-mention-hl");
    if (span && span.scrollIntoView) span.scrollIntoView({ block: "center" });
  }
  // If a span-edit-mode was active (fix_type_span open), re-apply it.
  const form = document.getElementById("review-inline-form");
  if (form && form.classList.contains("shown") && document.getElementById("ft-start")) {
    const srcEl = document.querySelector("#view-review .source");
    if (srcEl) {
      srcEl.classList.add("span-edit-mode");
      srcEl.onmouseup = reviewOnSourceSelectionForSpan;
    }
  }
}

function reviewRenderCard(data) {
  document.getElementById("review-progress").textContent = data.progress;
  if (data.done) {
    document.getElementById("review-card-wrap").innerHTML = "";
    const txt = document.getElementById("review-done-text");
    const hint = document.getElementById("review-done-hint");
    const actions = document.getElementById("review-done-actions");
    if (data.note_id) {
      if (txt)  txt.textContent  = `All mentions in note "${data.note_id}" reviewed.`;
      if (hint) hint.innerHTML   = `Clear the note filter to continue with the rest of the batch.`;
      if (actions) actions.innerHTML = `<button class="types-button" onclick="reviewClearNoteFilter()">Go to all notes</button>`;
    } else {
      if (txt)  txt.textContent  = `All mentions reviewed.`;
      if (hint) hint.innerHTML   = `Verdicts are in <code>verdicts/__USER__.jsonl</code>. Switch to <strong>Adjudicate</strong> next.`;
      if (actions) actions.innerHTML = "";
    }
    document.getElementById("review-done").style.display = "block";
    return;
  }
  document.getElementById("review-done").style.display = "none";

  reviewPrior = data.prior_verdict || null;
  const m = data.mention;
  const isFreshMention = !reviewMention || reviewMention.mention_id !== m.mention_id;
  reviewMention = m;
  reviewShownAt = Date.now();
  reviewSource = data.source || "";
  const isNovel = m.status === "novel_candidate";

  // Reset full-note toggle whenever we switch to a new mention.
  if (isFreshMention) reviewFullSource = false;

  const sourceRender = renderSourceHtml(m, reviewSource, {
    showFull: reviewFullSource,
    onToggle: "reviewToggleFullSource()",
    containerId: "review-source-text",
    spanId: "review-mention-hl",
  });
  reviewCtxL = sourceRender.ctxL;
  reviewPrefixLen = sourceRender.prefixLen;
  const mentionText = reviewSource.slice(m.start, m.end);

  const verdictHtml = reviewPrior ? `
    <div class="lock-card">
      <div class="head">You've already reviewed this mention.</div>
      <div class="prior">${escapeHtml(summarizePriorVerdict(reviewPrior, reviewSource))}</div>
      <button class="clear" onclick="reviewClearAnnotation()">Clear annotation to re-annotate</button>
    </div>
  ` : `
    <div class="actions-primary">${isNovel ? reviewNovelHtml(m) : reviewMappedHtml(m)}</div>
    <div id="review-inline-form" class="inline-form"></div>
  `;

  document.getElementById("review-card-wrap").innerHTML = `
    <section id="review-source-section">
      <h2>Source · note ${escapeHtml(m.note_id)}</h2>
      ${sourceRender.html}
      <div class="span-info">start = ${m.start} · end = ${m.end} · text = "${escapeHtml(mentionText)}"</div>
    </section>
    <section>
      <h2>Agent proposal</h2>
      <div class="agent-grid">
        <div class="label">entity_type</div>
        <div>
          ${escapeHtml(m.entity_type)}
          <button class="reference-link" onclick="openEntityTypesModal()">View Entity Types</button>
        </div>
        <div class="label">concept_name</div>
        <div>
          ${statusConceptHtml(m)}
          <button class="reference-link" onclick="toggleSubtree('${escapeHtml(m.entity_type)}', 'review', '${escapeHtml(escapeJsStr(m.concept_name || ""))}')">View Ontology</button>
        </div>
      </div>
      <div id="review-subtree-panel" class="subtree-panel"></div>
    </section>
    <section>
      <h2>Your verdict</h2>
      ${verdictHtml}
    </section>
  `;

  if (!reviewPrior) {
    document.querySelectorAll("#view-review .actions-primary button").forEach(btn => {
      btn.addEventListener("click", () => reviewHandlePrimary(btn.dataset.action));
    });
  }
}

function reviewMappedHtml(m) {
  return `
    <button class="primary" data-action="confirm">
      <span class="key">c</span>
      <span class="label">Confirm</span>
    </button>
    <button data-action="fix_concept">
      <span class="key">1</span>
      <span class="label">concept_name is wrong</span>
    </button>
    <button data-action="concept_name_novel">
      <span class="key">2</span>
      <span class="label">concept_name is novel</span>
    </button>
    <button data-action="fix_type_span">
      <span class="key">3</span>
      <span class="label">entity_type or span is wrong</span>
    </button>
    <button data-action="reject_not_entity">
      <span class="key">4</span>
      <span class="label">Not an entity</span>
    </button>
  `;
}
function reviewNovelHtml(m) {
  return `
    <button class="primary" data-action="confirm_novel">
      <span class="key">c</span>
      <span class="label">Yes truly novel</span>
    </button>
    <button data-action="missed_concept">
      <span class="key">1</span>
      <span class="label">Agent missed it — provide concept_name</span>
    </button>
    <button data-action="fix_type_span">
      <span class="key">2</span>
      <span class="label">entity_type or span is wrong</span>
    </button>
    <button data-action="reject_not_entity">
      <span class="key">3</span>
      <span class="label">Not an entity</span>
    </button>
  `;
}

function reviewSetActiveAction(action) {
  document.querySelectorAll("#view-review .actions-primary button").forEach(btn => {
    btn.classList.toggle("primary", btn.dataset.action === action);
  });
}

function reviewHandlePrimary(action) {
  reviewSetActiveAction(action);
  if (action === "confirm")          { reviewSubmit({ verdict: "confirm" }); return; }
  if (action === "confirm_novel")    { reviewShowConfirmNovelForm(); return; }
  if (action === "fix_concept" || action === "missed_concept") { reviewShowFixConceptForm(); return; }
  if (action === "fix_type_span")    { reviewShowFixTypeSpanForm(); return; }
  if (action === "concept_name_novel" || action === "reject_not_entity") {
    reviewHandleRare(action);
    return;
  }
}
function reviewHandleRare(action) {
  reviewShowNotesForm(action);
}

function reviewShowConfirmNovelForm() {
  const form = document.getElementById("review-inline-form");
  form.classList.add("shown");
  form.innerHTML = `
    <div class="form-title">Confirm as novel</div>
    <div class="field checkbox-row">
      <input type="checkbox" id="cn-propose" checked>
      <label for="cn-propose">Also submit an ontology proposal (recommended)</label>
    </div>
    <div class="field">
      <label>Notes (optional)</label>
      <textarea id="cn-notes" rows="2" placeholder="any extra context"></textarea>
    </div>
    <div class="actions">
      <button onclick="reviewHideInline()">Cancel</button>
      <button class="primary" onclick="reviewSubmitConfirmNovel()">Save</button>
    </div>
  `;
  document.getElementById("cn-notes").focus();
}
function reviewSubmitConfirmNovel() {
  const notes = document.getElementById("cn-notes").value;
  if (document.getElementById("cn-propose").checked) {
    reviewPendingNotes = notes;
    openOntologyModal();
  } else {
    reviewSubmit({ verdict: "confirm", notes });
  }
}
function reviewShowFixConceptForm() {
  const m = reviewMention;
  const form = document.getElementById("review-inline-form");
  form.classList.add("shown");
  form.innerHTML = `
    <div class="form-title">Provide the correct concept_name</div>
    <div class="field">
      <div class="helper" style="font-size:12.5px">
        Agent proposed: <code>${escapeHtml(m.concept_name || '')}</code>
        · entity_type: <code>${escapeHtml(m.entity_type || '')}</code>
      </div>
    </div>
    <div class="field">
      <label>Pick the correct concept from the ${escapeHtml(m.entity_type || '')} subtree:</label>
      <input type="hidden" id="ff-concept" value="">
      <div id="rf-tree-list" class="tree-picker tree-picker-list">loading…</div>
      <div class="helper" style="margin-top:4px">
        Selected: <code id="rf-selected">(none)</code>
      </div>
      <div class="helper" id="rf-warn" style="color:var(--danger);display:none;margin-top:4px">
        That is the agent's current concept — pick a different one to indicate a real correction.
      </div>
    </div>
    <div class="field">
      <label>Notes (optional)</label>
      <textarea id="ff-notes" rows="2"></textarea>
    </div>
    <div class="actions">
      <button onclick="reviewHideInline()">Cancel</button>
      <button class="primary" id="ff-save" onclick="reviewSubmitFixConcept()" disabled>Save</button>
    </div>
  `;
  reviewRenderConceptTree(m.entity_type);
}
async function reviewRenderConceptTree(entityType) {
  const list = document.getElementById("rf-tree-list");
  if (!entityType) {
    list.innerHTML = `<span style="color:var(--text-muted);font-size:12px">no entity_type — cannot pick</span>`;
    return;
  }
  list.innerHTML = `<span style="color:var(--text-muted);font-size:12px">loading…</span>`;
  const d = await fetchSubtree(entityType);
  const nodes = d.nodes || [];
  const currentConcept = (reviewMention && reviewMention.concept_name) || "";
  list.innerHTML = nodes.map(n => `
    <div class="tree-node ${n.label === currentConcept ? 'current-agent' : ''}"
         data-label="${escapeHtml(n.label)}"
         style="padding-left:${n.depth * 14 + 8}px">
      ${escapeHtml(n.label)}${n.label === currentConcept ? ' <span style="color:var(--accent);font-size:11px;font-weight:600">← agent’s pick</span>' : ''}
    </div>
  `).join("");
  list.querySelectorAll(".tree-node").forEach(el => {
    el.addEventListener("click", () => reviewPickConcept(el.dataset.label));
  });
}
function reviewPickConcept(label) {
  const currentConcept = (reviewMention && reviewMention.concept_name) || "";
  const hidden = document.getElementById("ff-concept");
  const selectedDisplay = document.getElementById("rf-selected");
  const warn = document.getElementById("rf-warn");
  const saveBtn = document.getElementById("ff-save");
  hidden.value = label;
  selectedDisplay.textContent = label;
  document.querySelectorAll("#rf-tree-list .tree-node").forEach(n => {
    n.classList.toggle("selected", n.dataset.label === label);
  });
  if (label === currentConcept) {
    warn.style.display = "block";
    saveBtn.disabled = true;
  } else {
    warn.style.display = "none";
    saveBtn.disabled = !label;
  }
}
function reviewSubmitFixConcept() {
  const concept = document.getElementById("ff-concept").value.trim();
  if (!concept) { alert("concept_name required — pick one from the tree"); return; }
  const currentConcept = (reviewMention && reviewMention.concept_name) || "";
  if (concept === currentConcept) {
    alert(`pick a different concept — current is already ${currentConcept}`);
    return;
  }
  reviewSubmit({
    verdict: "correct_concept", new_concept: concept,
    notes: document.getElementById("ff-notes").value,
  });
}
function reviewShowFixTypeSpanForm() {
  const m = reviewMention;
  const form = document.getElementById("review-inline-form");
  form.classList.add("shown");
  const typeOptions = entityTypes.map(t =>
    `<option value="${escapeHtml(t.name)}" ${t.name === m.entity_type ? "selected" : ""}>${escapeHtml(t.name)}</option>`
  ).join("");
  const initialText = reviewSource.slice(m.start, m.end);
  form.innerHTML = `
    <div class="form-title">Fix entity_type and/or span — edit only the wrong one</div>
    <div class="field">
      <label>entity_type</label>
      <select id="ft-type">${typeOptions}</select>
    </div>
    <div class="helper" style="color:var(--accent);font-weight:500">
      ✱ Drag-select text in the source paragraph above to change the span.
    </div>
    <div class="span-preview">
      <div class="pv-label">Selected text</div>
      <div class="pv-text" id="ft-preview">"${escapeHtml(initialText)}"</div>
    </div>
    <div class="row">
      <div class="field"><label>span start</label><input type="number" id="ft-start" value="${m.start}"></div>
      <div class="field"><label>span end</label><input type="number" id="ft-end" value="${m.end}"></div>
    </div>
    <div class="field"><label>Notes (optional)</label><textarea id="ft-notes" rows="2"></textarea></div>
    <div class="helper">Edit type OR span (not both). For both wrong, fix one then re-review.</div>
    <div class="actions">
      <button onclick="reviewHideInline()">Cancel</button>
      <button class="primary" onclick="reviewSubmitFixTypeSpan()">Save</button>
    </div>
  `;
  document.getElementById("ft-start").addEventListener("input", reviewUpdateSpanPreview);
  document.getElementById("ft-end").addEventListener("input", reviewUpdateSpanPreview);
  const srcEl = document.querySelector("#view-review .source");
  if (srcEl) {
    srcEl.classList.add("span-edit-mode");
    srcEl.onmouseup = reviewOnSourceSelectionForSpan;
  }
  document.getElementById("ft-type").focus();
}
function reviewUpdateSpanPreview() {
  const preview = document.getElementById("ft-preview");
  if (!preview) return;
  const s = parseInt(document.getElementById("ft-start").value, 10);
  const e = parseInt(document.getElementById("ft-end").value, 10);
  if (isNaN(s) || isNaN(e) || s < 0 || e > reviewSource.length || s >= e) {
    preview.textContent = "(invalid span)"; preview.classList.add("invalid"); return;
  }
  preview.textContent = `"${reviewSource.slice(s, e)}"`;
  preview.classList.remove("invalid");
}
function reviewOnSourceSelectionForSpan() {
  const srcEl = document.querySelector("#view-review .source");
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  if (!srcEl.contains(range.startContainer) || !srcEl.contains(range.endContainer)) return;
  function offsetIn(node, off) {
    let total = 0, found = false;
    function walk(n) {
      if (found) return;
      if (n === node) { total += off; found = true; return; }
      if (n.nodeType === Node.TEXT_NODE) { total += n.textContent.length; return; }
      if (n.nodeType === Node.ELEMENT_NODE) for (const c of n.childNodes) { walk(c); if (found) return; }
    }
    walk(srcEl);
    return total;
  }
  let s = offsetIn(range.startContainer, range.startOffset);
  let e = offsetIn(range.endContainer, range.endOffset);
  if (s > e) [s, e] = [e, s];
  const startInSource = s - reviewPrefixLen + reviewCtxL;
  const endInSource   = e - reviewPrefixLen + reviewCtxL;
  document.getElementById("ft-start").value = startInSource;
  document.getElementById("ft-end").value = endInSource;
  reviewUpdateSpanPreview();
}
function reviewSubmitFixTypeSpan() {
  const m = reviewMention;
  const newType = document.getElementById("ft-type").value;
  const newStart = parseInt(document.getElementById("ft-start").value, 10);
  const newEnd = parseInt(document.getElementById("ft-end").value, 10);
  const notes = document.getElementById("ft-notes").value;
  const typeChanged = newType !== m.entity_type;
  const spanChanged = newStart !== m.start || newEnd !== m.end;
  if (!typeChanged && !spanChanged) { alert("nothing changed"); return; }
  if (typeChanged && spanChanged) { alert("edit only one field at a time"); return; }
  if (spanChanged) {
    if (isNaN(newStart) || isNaN(newEnd) || newEnd <= newStart) { alert("invalid span"); return; }
    reviewSubmit({ verdict: "correct_span", new_span: [newStart, newEnd], notes });
  } else {
    reviewSubmit({ verdict: "correct_type", new_type: newType, notes });
  }
}
function reviewShowNotesForm(verdict) {
  const form = document.getElementById("review-inline-form");
  form.classList.add("shown");
  form.innerHTML = `
    <div class="form-title">${verdict.replace(/_/g, " ")} — add notes (optional)</div>
    <div class="field"><textarea id="nt-notes" rows="3" placeholder="why?"></textarea></div>
    <div class="actions">
      <button onclick="reviewHideInline()">Cancel</button>
      <button class="primary" id="nt-save">Save</button>
    </div>
  `;
  document.getElementById("nt-notes").focus();
  document.getElementById("nt-save").addEventListener("click", () => {
    reviewSubmit({ verdict, notes: document.getElementById("nt-notes").value });
  });
}
function reviewHideInline() {
  const form = document.getElementById("review-inline-form");
  if (form) form.classList.remove("shown");
  const srcEl = document.querySelector("#view-review .source");
  if (srcEl) { srcEl.classList.remove("span-edit-mode"); srcEl.onmouseup = null; }
  if (reviewMention) {
    reviewSetActiveAction(reviewMention.status === "novel_candidate" ? "confirm_novel" : "confirm");
  }
}

async function reviewSubmit(extra) {
  const body = {
    mention_id: reviewMention.mention_id,
    review_duration_ms: Date.now() - reviewShownAt,
    ...extra,
  };
  await apiPost("/api/review/verdict", body);
  reviewHideInline();
  reviewPrior = null;
  return reviewLoadNext();
}

async function reviewClearAnnotation() {
  await apiPost("/api/review/clear", { mention_id: reviewMention.mention_id });
  const d = await apiGet(`/api/review/mention/${encodeURIComponent(reviewMention.mention_id)}`);
  reviewRenderCard(d);
}

async function reviewGoBack() {
  const d = await apiGet("/api/review/prev" + reviewNoteFilterQS());
  if (d.none) {
    alert(reviewNoteFilter
      ? `no prior verdicts to go back to in note "${reviewNoteFilter}"`
      : "no prior verdicts to go back to");
    return;
  }
  reviewRenderCard(d);
}

async function reviewClearNoteFilter() {
  reviewNoteFilter = "";
  const sel = document.getElementById("review-note-filter");
  if (sel) sel.value = "";
  await reviewLoadNext();
}

// Ontology proposal modal (used by review only)
function openOntologyModal() {
  document.getElementById("ontology-modal").classList.add("shown");
  if (reviewMention) document.getElementById("op-parent").value = reviewMention.entity_type || "";
  document.getElementById("op-name").focus();
}
function closeOntologyModal() {
  document.getElementById("ontology-modal").classList.remove("shown");
  reviewPendingNotes = "";
}
function submitWithProposal() {
  const proposal = {
    action: document.getElementById("op-action").value,
    suggested_name: document.getElementById("op-name").value.trim(),
    suggested_parent: document.getElementById("op-parent").value.trim() || null,
    rationale: document.getElementById("op-rationale").value.trim(),
  };
  reviewSubmit({ verdict: "confirm", notes: reviewPendingNotes, ontology_proposal: proposal });
  closeOntologyModal();
  for (const id of ["op-name", "op-parent", "op-rationale"]) {
    const el = document.getElementById(id); if (el) el.value = "";
  }
}

// All-mentions overview (review)
async function openAllMentionsModal() {
  document.getElementById("all-mentions-modal").classList.add("shown");
  const d = await apiGet("/api/review/mentions");
  const total = d.mentions.length;
  const reviewed = d.mentions.filter(m => m.verdict).length;
  const pct = total ? Math.round(100 * reviewed / total) : 0;
  document.getElementById("am-summary").innerHTML =
    `<strong>${reviewed} / ${total}</strong> reviewed across all notes (${pct}%)
     <span class="bar"><span style="width:${pct}%"></span></span>`;

  // Group mentions by note_id (preserve insertion order from mentions.jsonl)
  const groups = new Map();
  for (const m of d.mentions) {
    const nid = m.note_id || "(no note)";
    if (!groups.has(nid)) groups.set(nid, {note_id: nid, mentions: []});
    groups.get(nid).mentions.push(m);
  }

  const groupBlocks = [];
  for (const g of groups.values()) {
    const gTotal = g.mentions.length;
    const gDone  = g.mentions.filter(m => m.verdict).length;
    const gPct   = gTotal ? Math.round(100 * gDone / gTotal) : 0;
    const rows = g.mentions.map(m => {
      const cls = m.verdict ? "done" : "pending";
      const verdictText = m.verdict ? summarizePriorVerdict(m.verdict) : "(pending)";
      const conceptHtml = m.concept_name ? `<code>${escapeHtml(m.concept_name)}</code>` : `<em>novel</em>`;
      return `
        <div class="list-row ${cls}" style="grid-template-columns:26px 42px 1.7fr 1.4fr 1.6fr" onclick="reviewJumpTo('${escapeHtml(m.mention_id)}')">
          <span class="mark">${m.verdict ? '✓' : '○'}</span>
          <span class="idx">#${m.index}</span>
          <span class="text">"${escapeHtml(m.text)}"</span>
          <span class="meta">${escapeHtml(m.entity_type)} → ${conceptHtml}</span>
          <span class="verdict">${escapeHtml(verdictText)}</span>
        </div>
      `;
    }).join("");
    groupBlocks.push(`
      <div class="am-group">
        <div class="am-group-header">
          <span class="am-group-title">📄 note <code>${escapeHtml(g.note_id)}</code></span>
          <span class="am-group-meta">${gDone}/${gTotal} reviewed (${gPct}%)</span>
        </div>
        ${rows}
      </div>
    `);
  }
  document.getElementById("am-list").innerHTML = groupBlocks.join("");
}
function closeAllMentionsModal() { document.getElementById("all-mentions-modal").classList.remove("shown"); }
async function reviewJumpTo(mid) {
  closeAllMentionsModal();
  const d = await apiGet(`/api/review/mention/${encodeURIComponent(mid)}`);
  reviewRenderCard(d);
}

// ═══════════════════════════════════════════════════════════════════════
//   ADJUDICATE view
// ═══════════════════════════════════════════════════════════════════════
let adjudData = null, adjudPendingAction = null, adjudPrior = null;
let adjudFullSource = false;

function verdictPillClass(verdict) {
  if (verdict === "confirm") return "confirm";
  if (verdict.startsWith("correct")) return "correct";
  if (verdict.startsWith("reject"))  return "reject";
  if (verdict.startsWith("propose")) return "propose";
  return "";
}
function summarizeVerdict(v) {
  let s = v.verdict;
  const c = v.corrected || {};
  if (c.concept_name) s += ` → concept = ${c.concept_name}`;
  if (c.entity_type)  s += ` → type = ${c.entity_type}`;
  if (c.span)         s += ` → span = [${c.span.start}, ${c.span.end})`;
  return s;
}

function renderReviewerCard(v, key, sourceText, agent) {
  const c = v.corrected || {};
  const pillCls = verdictPillClass(v.verdict);
  const details = [];
  if (c.concept_name) details.push(`<div class="rev-detail"><div class="key">corrected concept_name</div><code>${escapeHtml(c.concept_name)}</code></div>`);
  if (c.entity_type)  details.push(`<div class="rev-detail"><div class="key">corrected entity_type</div><code>${escapeHtml(c.entity_type)}</code></div>`);
  if (c.span) {
    const text = (sourceText || "").slice(c.span.start, c.span.end);
    details.push(`
      <div class="rev-detail span-detail">
        <div class="key">corrected span</div>
        <div class="span-text">"${escapeHtml(text)}"</div>
        <div class="span-offsets">[${c.span.start}, ${c.span.end})</div>
      </div>
    `);
  }
  if (v.ontology_proposal) {
    const op = v.ontology_proposal;
    details.push(`
      <div class="rev-detail">
        <div class="key">+ ontology proposal</div>
        <code>${escapeHtml(op.action)}: ${escapeHtml(op.suggested_name || "(no name)")}</code>
        ${op.rationale ? `<div class="rev-notes" style="margin-top:4px">${escapeHtml(op.rationale)}</div>` : ""}
      </div>
    `);
  }
  const notesBlock = v.notes
    ? `<div class="rev-notes">notes: ${escapeHtml(v.notes)}</div>`
    : `<div class="rev-notes" style="opacity:.5">(no notes)</div>`;
  return `
    <div class="rev-card" id="adjud-rev-${key}">
      <div class="rev-name">
        ${escapeHtml(v.reviewer_id)}
        <span class="rev-verdict-pill ${pillCls}">${escapeHtml(v.verdict)}</span>
      </div>
      ${details.join("")}
      ${notesBlock}
    </div>
  `;
}

async function adjudLoadNext() {
  const d = await apiGet("/api/adjudicate/next");
  adjudRenderCard(d);
  refreshBadges();
}

// Toggle full-note view on the Adjudicate source pane WITHOUT re-rendering
// the rest of the card.
function adjudToggleFullSource() {
  if (!adjudData || !adjudData.agent) return;
  adjudFullSource = !adjudFullSource;
  const section = document.getElementById("adjud-source-section");
  if (!section) return;
  const a = adjudData.agent;
  const src = adjudData.source || "";
  const adjudSourceRender = renderSourceHtml(a, src, {
    showFull: adjudFullSource,
    onToggle: "adjudToggleFullSource()",
    containerId: "adjud-source-text",
    spanId: "adjud-mention-hl",
  });
  const spanInfo = section.querySelector(".span-info");
  const oldToolbar = section.querySelector(".source-toolbar");
  const oldSource = section.querySelector(".source");
  if (oldToolbar) oldToolbar.remove();
  if (oldSource) oldSource.remove();
  const tmp = document.createElement("div");
  tmp.innerHTML = adjudSourceRender.html;
  while (tmp.firstChild) section.insertBefore(tmp.firstChild, spanInfo);
  if (adjudFullSource) {
    const span = document.getElementById("adjud-mention-hl");
    if (span && span.scrollIntoView) span.scrollIntoView({ block: "center" });
  }
}

function adjudRenderCard(data) {
  document.getElementById("adjud-progress").textContent = data.progress;
  if (data.done) {
    document.getElementById("adjud-card-wrap").innerHTML = "";
    document.getElementById("adjud-done").style.display = "block";
    return;
  }
  document.getElementById("adjud-done").style.display = "none";

  const isFreshAdjud = !adjudData || adjudData.mention_id !== data.mention_id;
  adjudData = data;
  adjudPendingAction = null;
  adjudPrior = data.prior_decision || null;
  if (isFreshAdjud) adjudFullSource = false;

  const a = data.agent;
  const src = data.source || "";
  const adjudSourceRender = renderSourceHtml(a, src, {
    showFull: adjudFullSource,
    onToggle: "adjudToggleFullSource()",
    containerId: "adjud-source-text",
    spanId: "adjud-mention-hl",
  });
  const mentionText = src.slice(a.start, a.end);
  const [vA, vB] = data.verdicts;

  document.getElementById("adjud-card-wrap").innerHTML = `
    <section id="adjud-source-section">
      <h2>Source · note ${escapeHtml(a.note_id)}</h2>
      ${adjudSourceRender.html}
      <div class="span-info">start = ${a.start} · end = ${a.end} · text = "${escapeHtml(mentionText)}"</div>
    </section>
    <section>
      <h2>Agent proposal</h2>
      <div class="agent-grid">
        <div class="label">entity_type</div>
        <div>
          ${escapeHtml(a.entity_type)}
          <button class="reference-link" onclick="openEntityTypesModal()">View Entity Types</button>
        </div>
        <div class="label">concept_name</div>
        <div>
          ${statusConceptHtml(a)}
          <button class="reference-link" onclick="toggleSubtree('${escapeHtml(a.entity_type)}', 'adjud', '${escapeHtml(escapeJsStr(a.concept_name || ""))}')">View Ontology</button>
        </div>
      </div>
      <div id="adjud-subtree-panel" class="subtree-panel"></div>
    </section>
    <section>
      <h2>Reviewer verdicts <span class="disagreement-tag">disagreement: ${escapeHtml(data.disagreement_type)}</span></h2>
      <div class="reviewers">
        ${renderReviewerCard(vA, "a", src, a)}
        ${renderReviewerCard(vB, "b", src, a)}
      </div>
    </section>
    <section>
      <h2>Your decision</h2>
      ${adjudPrior ? adjudLockedHtml(adjudPrior) : adjudPrimaryHtml(vA, vB)}
    </section>
  `;

  if (!adjudPrior) {
    document.querySelectorAll("#view-adjudicate .actions-primary button").forEach(btn => {
      btn.addEventListener("click", () => adjudActionPicked(btn.dataset.action));
    });
  }
}

function adjudPrimaryHtml(vA, vB) {
  return `
    <div class="actions-primary">
      <button data-action="take_a">
        <span class="key">a</span>
        <span class="label">Take ${escapeHtml(vA.reviewer_id)}'s</span>
      </button>
      <button data-action="take_b">
        <span class="key">b</span>
        <span class="label">Take ${escapeHtml(vB.reviewer_id)}'s</span>
      </button>
      <button data-action="new_value">
        <span class="key">n</span>
        <span class="label">Set a new value</span>
      </button>
      <button data-action="defer">
        <span class="key">s</span>
        <span class="label">Defer</span>
      </button>
    </div>
    <div id="adjud-inline-form" class="inline-form"></div>
  `;
}

function adjudLockedHtml(pd) {
  const f = pd.final || {};
  let line = `verdict: ${f.verdict}`;
  if (f.concept_name) line += ` → concept = ${f.concept_name}`;
  if (f.entity_type)  line += ` → entity_type = ${f.entity_type}`;
  if (f.span)         line += ` → span = [${f.span.start}, ${f.span.end})`;
  if (pd.deferred)    line = `deferred (no final decision recorded yet)`;
  return `
    <div class="lock-card">
      <div class="head">You've already decided this disagreement.</div>
      <div class="prior">
        ${escapeHtml(line)}
        ${pd.rationale ? `<div class="rat">rationale: ${escapeHtml(pd.rationale)}</div>` : ""}
      </div>
      <button class="clear" onclick="adjudClearDecision()">Clear decision to redo</button>
    </div>
  `;
}

function adjudSetActive(action) {
  document.querySelectorAll("#view-adjudicate .actions-primary button").forEach(btn => {
    btn.classList.toggle("primary", btn.dataset.action === action);
  });
  document.querySelectorAll("#view-adjudicate .rev-card").forEach(c => c.classList.remove("selected"));
  if (action === "take_a") document.getElementById("adjud-rev-a")?.classList.add("selected");
  if (action === "take_b") document.getElementById("adjud-rev-b")?.classList.add("selected");
}

function adjudActionPicked(action) {
  adjudPendingAction = action;
  adjudSetActive(action);
  if (action === "defer")       adjudShowRationaleForm("Notes (optional — confirm to skip)");
  else if (action === "new_value") adjudShowNewValueForm();
  else                          adjudShowRationaleForm("Rationale (optional)");
}
function adjudShowRationaleForm(label) {
  const form = document.getElementById("adjud-inline-form");
  form.classList.add("shown");
  form.innerHTML = `
    <div class="field"><label>${label}</label>
      <textarea id="ra-text" rows="3" placeholder="why this decision? (optional)"></textarea></div>
    <div class="actions">
      <button onclick="adjudHideInline()">Cancel</button>
      <button class="primary" onclick="adjudSubmitDecision()">Save decision</button>
    </div>
  `;
  document.getElementById("ra-text").focus();
}
function adjudShowNewValueForm() {
  const form = document.getElementById("adjud-inline-form");
  form.classList.add("shown");
  const a = (adjudData && adjudData.agent) || {};
  const seedType = a.entity_type || "";
  const typeOptions = `<option value=""></option>` + entityTypes.map(t =>
    `<option value="${escapeHtml(t.name)}" ${t.name === seedType ? "selected" : ""}>${escapeHtml(t.name)}</option>`
  ).join("");
  form.innerHTML = `
    <div class="field">
      <label>Verdict kind</label>
      <select id="nv-verdict">
        <option value="correct_concept">Correct Concept Name</option>
        <option value="correct_type">Correct Entity Type</option>
        <option value="reject_not_entity">Not an Entity</option>
        <option value="concept_name_novel">Concept Name is Novel</option>
      </select>
    </div>
    <div id="nv-concept-tree-wrap" style="display:none">
      <label>concept_name &mdash; pick from ontology subtree</label>
      <input type="hidden" id="nv-concept" value="">
      <div id="nv-tree-list" class="tree-picker tree-picker-list">loading&hellip;</div>
      <div class="helper" style="margin-top:4px">Selected: <code id="nv-selected">(none)</code></div>
    </div>
    <div id="nv-type-wrap" class="field" style="display:none">
      <label>entity_type</label>
      <select id="nv-type">${typeOptions}</select>
    </div>
    <div class="field"><label>Rationale (optional)</label><textarea id="ra-text" rows="2"></textarea></div>
    <div class="helper">Fields shown depend on the verdict you choose above.</div>
    <div class="actions">
      <button onclick="adjudHideInline()">Cancel</button>
      <button class="primary" onclick="adjudSubmitDecision()">Save decision</button>
    </div>
  `;
  // Hidden nv-type select also needs to exist even when wrap hidden, so always keep one nv-type
  // (the rendered select above is the one source of truth).
  document.getElementById("nv-verdict").addEventListener("change", adjudOnVerdictChange);
  adjudOnVerdictChange();
  document.getElementById("nv-verdict").focus();
}
function adjudOnVerdictChange() {
  const v = document.getElementById("nv-verdict").value;
  const treeWrap = document.getElementById("nv-concept-tree-wrap");
  const typeWrap = document.getElementById("nv-type-wrap");
  treeWrap.style.display = "none";
  typeWrap.style.display = "none";
  if (v === "correct_concept") {
    treeWrap.style.display = "block";
    const a = (adjudData && adjudData.agent) || {};
    adjudRenderConceptTree(a.entity_type || "");
  } else if (v === "correct_type") {
    typeWrap.style.display = "block";
  }
}
async function adjudRenderConceptTree(entityType) {
  const list = document.getElementById("nv-tree-list");
  if (!list) return;
  if (!entityType) {
    list.innerHTML = `<span style="color:var(--text-muted);font-size:12px">no entity_type &mdash; cannot pick</span>`;
    return;
  }
  list.innerHTML = `<span style="color:var(--text-muted);font-size:12px">loading&hellip;</span>`;
  const d = await fetchSubtree(entityType);
  const nodes = d.nodes || [];
  const a = (adjudData && adjudData.agent) || {};
  const currentConcept = a.concept_name || "";
  list.innerHTML = nodes.map(n => `
    <div class="tree-node ${n.label === currentConcept ? 'current-agent' : ''}"
         data-label="${escapeHtml(n.label)}"
         style="padding-left:${n.depth * 14 + 8}px">
      ${escapeHtml(n.label)}${n.label === currentConcept ? ' <span style="color:var(--accent);font-size:11px;font-weight:600">&larr; agent pick</span>' : ''}
    </div>
  `).join("");
  list.querySelectorAll(".tree-node").forEach(el => {
    el.addEventListener("click", () => adjudPickConcept(el.dataset.label));
  });
}
function adjudPickConcept(label) {
  const hidden = document.getElementById("nv-concept");
  const selectedDisplay = document.getElementById("nv-selected");
  if (hidden) hidden.value = label;
  if (selectedDisplay) selectedDisplay.textContent = label;
  document.querySelectorAll("#nv-tree-list .tree-node").forEach(n => {
    n.classList.toggle("selected", n.dataset.label === label);
  });
}
function adjudHideInline() {
  document.getElementById("adjud-inline-form")?.classList.remove("shown");
  adjudPendingAction = null;
  adjudSetActive(null);
}
async function adjudSubmitDecision() {
  const rationale = document.getElementById("ra-text")?.value.trim() || "";
  const body = {
    mention_id: adjudData.mention_id,
    action: adjudPendingAction, rationale,
  };
  if (adjudPendingAction === "new_value") {
    const verdict = document.getElementById("nv-verdict").value;
    body.verdict = verdict;
    const conceptEl = document.getElementById("nv-concept");
    const typeEl = document.getElementById("nv-type");
    const concept = (conceptEl && conceptEl.value) ? conceptEl.value.trim() : "";
    const entityType = (typeEl && typeEl.value) ? typeEl.value.trim() : "";
    if (verdict === "correct_concept" && !concept) {
      alert("concept_name required — pick one from the tree");
      return;
    }
    if (verdict === "correct_type" && !entityType) {
      alert("entity_type required — pick one from the dropdown");
      return;
    }
    body.concept_name = concept || null;
    body.entity_type = entityType || null;
  }
  await apiPost("/api/adjudicate/decide", body);
  await adjudLoadNext();
}
async function adjudClearDecision() {
  await apiPost("/api/adjudicate/clear", { mention_id: adjudData.mention_id });
  const d = await apiGet(`/api/adjudicate/disagreement/${encodeURIComponent(adjudData.mention_id)}`);
  adjudRenderCard(d);
}

async function openAllDisagreementsModal() {
  document.getElementById("all-disagreements-modal").classList.add("shown");
  const d = await apiGet("/api/adjudicate/disagreements");
  const total = d.disagreements.length;
  const decided = d.disagreements.filter(x => x.decision && !x.decision.deferred).length;
  const deferred = d.disagreements.filter(x => x.decision && x.decision.deferred).length;
  const pct = total ? Math.round(100 * decided / total) : 0;
  document.getElementById("ad-summary").innerHTML =
    `<strong>${decided} / ${total}</strong> decided (${pct}%)${deferred ? `, ${deferred} deferred` : ""}
     <span class="bar"><span style="width:${pct}%"></span></span>`;
  document.getElementById("ad-list").innerHTML = d.disagreements.map(x => {
    const decided = !!x.decision && !x.decision.deferred;
    const deferred = !!x.decision && x.decision.deferred;
    const cls = decided ? "done" : (deferred ? "deferred" : "pending");
    const mark = decided ? "✓" : "○";
    const reviewers = x.verdicts.map(v => `${v.reviewer_id}: ${v.verdict}`).join(" · ");
    let decisionLabel = "(pending)";
    if (decided) {
      const f = x.decision.final;
      decisionLabel = f.verdict;
      if (f.concept_name) decisionLabel += ` → ${f.concept_name}`;
      if (f.entity_type) decisionLabel += ` → type=${f.entity_type}`;
      if (f.span) decisionLabel += ` → span=[${f.span.start},${f.span.end})`;
    } else if (deferred) decisionLabel = "(deferred)";
    return `
      <div class="list-row ${cls}" style="grid-template-columns:26px 42px 1.5fr 1fr 1.4fr 1.6fr" onclick="adjudJumpTo('${escapeHtml(x.mention_id)}')">
        <span class="mark">${mark}</span>
        <span class="idx">#${x.index}</span>
        <span class="text">"${escapeHtml(x.text)}"</span>
        <span class="type-pill">${escapeHtml(x.disagreement_type)}</span>
        <span class="meta">${escapeHtml(reviewers)}</span>
        <span class="verdict">${escapeHtml(decisionLabel)}</span>
      </div>
    `;
  }).join("");
}
function closeAllDisagreementsModal() { document.getElementById("all-disagreements-modal").classList.remove("shown"); }
async function adjudJumpTo(mid) {
  closeAllDisagreementsModal();
  const d = await apiGet(`/api/adjudicate/disagreement/${encodeURIComponent(mid)}`);
  adjudRenderCard(d);
}

// ═══════════════════════════════════════════════════════════════════════
//   ONTOLOGY view
// ═══════════════════════════════════════════════════════════════════════
let ontologyData = null, ontologyPending = null, ontologyPrior = null;

async function ontologyLoadNext() {
  const d = await apiGet("/api/ontology/next");
  ontologyRender(d);
  refreshBadges();
}

function ontologyRender(data) {
  document.getElementById("ontology-progress").textContent = data.progress;
  if (data.done) {
    document.getElementById("ontology-card-wrap").innerHTML = "";
    document.getElementById("ontology-done").style.display = "block";
    return;
  }
  document.getElementById("ontology-done").style.display = "none";

  ontologyData = data;
  ontologyPending = null;
  ontologyPrior = data.prior_decision || null;

  const revsHtml = data.reviewer_proposals.length === 0
    ? `<div class="rev-prop" style="opacity:.7"><div class="rev-name">(no reviewer suggestions)</div><div style="font-size:12px;color:var(--text-muted)">This concept came from a confirmed novel_candidate without an explicit ontology proposal attached.</div></div>`
    : data.reviewer_proposals.map(rp => `
        <div class="rev-prop">
          <div class="rev-name">${escapeHtml(rp.reviewer_id)}</div>
          <div class="rev-row"><span class="key">name</span> <code>${escapeHtml(rp.suggested_name || "(empty)")}</code></div>
          ${rp.suggested_parent ? `<div class="rev-row"><span class="key">parent</span> <code>${escapeHtml(rp.suggested_parent)}</code> <button class="reference-link" onclick="toggleSubtree('${escapeHtml(escapeJsStr(rp.suggested_parent))}', 'ontology', '${escapeHtml(escapeJsStr(rp.suggested_name || rp.suggested_parent || ""))}')">View Ontology</button></div>` : ""}
          ${rp.rationale ? `<div class="rev-rationale">${escapeHtml(rp.rationale)}</div>` : ""}
        </div>
      `).join("");

  const readyPill = data.ready_for_review
    ? `<span class="ready-pill yes">ready</span>`
    : `<span class="ready-pill no">below frequency threshold</span>`;

  // Render source section showing where the surface form appeared in context
  let sourceHtml = "";
  if (data.sources && data.sources.length > 0) {
    const s = data.sources[0];
    const ctxL = Math.max(0, s.start - 300);
    const ctxR = Math.min(s.source.length, s.end + 300);
    const before = s.source.slice(ctxL, s.start);
    const mentionText = s.source.slice(s.start, s.end);
    const after = s.source.slice(s.end, ctxR);
    const prefix = ctxL > 0 ? "…" : "";
    const suffix = ctxR < s.source.length ? "…" : "";
    sourceHtml = `
      <section>
        <h2>Source · note ${escapeHtml(s.note_id)}${data.sources.length > 1 ? ` <span style="text-transform:none;color:var(--text-muted);font-weight:400;font-size:11px">(+${data.sources.length - 1} more note${data.sources.length > 2 ? 's' : ''})</span>` : ''}</h2>
        <div class="source">${escapeHtml(prefix + before)}<span class="ent">${escapeHtml(mentionText)}</span>${escapeHtml(after + suffix)}</div>
      </section>
    `;
  }

  document.getElementById("ontology-card-wrap").innerHTML = `
    ${sourceHtml}
    <section>
      <h2>Proposal</h2>
      <div class="prop-grid">
        <div class="label">surface form</div>
        <div><span class="surface">"${escapeHtml(data.surface_form)}"</span> ${readyPill}</div>
        <div class="label">normalized</div>       <div><code>${escapeHtml(data.normalized_form)}</code></div>
        <div class="label">occurrence count</div> <div>${data.occurrence_count} <span style="color:var(--text-muted);font-size:12px">across ${data.note_ids.length} note(s)</span></div>
        <div class="label">note ids</div>         <div class="cases-line">${data.note_ids.map(escapeHtml).join(", ")}</div>
      </div>
      <div id="ontology-subtree-panel" class="subtree-panel"></div>
    </section>
    <section>
      <h2>Reviewer suggestions (${data.reviewer_proposal_count})</h2>
      ${revsHtml}
    </section>
    <section>
      <h2>Your decision</h2>
      ${ontologyPrior ? ontologyLockedHtml(ontologyPrior) : ontologyPrimaryHtml()}
    </section>
  `;
  if (!ontologyPrior) {
    document.querySelectorAll("#view-ontology .actions-primary button").forEach(btn => {
      btn.addEventListener("click", () => ontologyActionPicked(btn.dataset.action));
    });
  }
}

function ontologyPrimaryHtml() {
  return `
    <div class="actions-primary">
      <button class="primary" data-action="accept">
        <span class="key">a</span>
        <span class="label">Accept — add new concept</span>
      </button>
      <button data-action="accept-as-synonym">
        <span class="key">s</span>
        <span class="label">Accept as synonym</span>
      </button>
      <button data-action="reject">
        <span class="key">r</span>
        <span class="label">Reject</span>
      </button>
      <button data-action="defer">
        <span class="key">d</span>
        <span class="label">Defer</span>
      </button>
    </div>
    <div id="ontology-inline-form" class="inline-form"></div>
  `;
}

function ontologyLockedHtml(pd) {
  let line = `decision: ${pd.decision}`;
  if (pd.final) {
    if (pd.final.concept_name) line += ` → ${pd.final.concept_name}`;
    if (pd.final.parent)       line += ` (parent=${pd.final.parent})`;
    if (pd.final.entity_type)  line += ` (entity_type=${pd.final.entity_type})`;
    if (pd.final.synonym_target) line += ` → synonym of ${pd.final.synonym_target}`;
  }
  return `
    <div class="lock-card">
      <div class="head">You've already decided this proposal.</div>
      <div class="prior">${escapeHtml(line)}${pd.rationale ? `<div class="rat">rationale: ${escapeHtml(pd.rationale)}</div>` : ""}</div>
      <button class="clear" onclick="ontologyClearDecision()">Clear decision to redo</button>
    </div>
  `;
}

function ontologySetActive(action) {
  document.querySelectorAll("#view-ontology .actions-primary button").forEach(btn => {
    btn.classList.toggle("primary", btn.dataset.action === action);
  });
}
function ontologyActionPicked(action) {
  ontologyPending = action;
  ontologySetActive(action);
  if (action === "accept")             ontologyShowAcceptForm();
  else if (action === "accept-as-synonym") ontologyShowSynonymForm();
  else if (action === "reject")        ontologyShowNotesForm("Reject — rationale (optional)");
  else if (action === "defer")         ontologyShowNotesForm("Defer — notes (optional)");
}
function ontologyShowAcceptForm() {
  const sug = ontologyData.reviewer_proposals[0] || {};
  const suggestedType = sug.suggested_parent ? "" : "";  // unknown — let user pick
  const typeOptions = entityTypes.map(t =>
    `<option value="${escapeHtml(t.name)}">${escapeHtml(t.name)}</option>`
  ).join("");
  document.getElementById("ontology-inline-form").classList.add("shown");
  document.getElementById("ontology-inline-form").innerHTML = `
    <div class="form-title">Accept — add new concept</div>
    <div class="field">
      <label>Final concept_name</label>
      <input id="ac-name" value="${escapeHtml(sug.suggested_name || "")}" placeholder="e.g. Spousal_Caregiver_Burden">
      <div class="helper">use the exact form: TitleCase_With_Underscores</div>
    </div>
    <div class="field">
      <label>Parent concept_name
        <button type="button" class="reference-link" onclick="acToggleTreePicker()" id="ac-picker-toggle">Browse tree ▾</button>
      </label>
      <input id="ac-parent" value="${escapeHtml(sug.suggested_parent || "")}" placeholder="e.g. Element_Relevant_to_Social_and_Community_Context">
      <div class="helper">must be an existing concept (or a root entity_type). Click <em>Browse tree</em> to pick from the ontology.</div>
      <div id="ac-tree-picker" class="tree-picker" style="display:none">
        <div class="tree-picker-header">
          <select id="ac-tree-type">${typeOptions}</select>
          <span class="helper">click any node to set it as the parent (entity_type auto-fills)</span>
        </div>
        <div id="ac-tree-list">loading…</div>
      </div>
    </div>
    <div class="field">
      <label>entity_type (root subtree)</label>
      <select id="ac-type"><option value="">(infer from parent)</option>${typeOptions}</select>
    </div>
    <div class="field"><label>Rationale (optional)</label><textarea id="ac-rationale" rows="2"></textarea></div>
    <div class="actions">
      <button onclick="ontologyHideInline()">Cancel</button>
      <button class="primary" onclick="ontologySubmitAccept()">Save</button>
    </div>
  `;
  // When user changes the tree-picker's entity_type dropdown, reload the tree
  document.getElementById("ac-tree-type").addEventListener("change", (e) => {
    acRenderTreeList(e.target.value);
  });
  document.getElementById("ac-name").focus();
  document.getElementById("ac-name").select();
}

async function acToggleTreePicker() {
  const picker = document.getElementById("ac-tree-picker");
  const toggle = document.getElementById("ac-picker-toggle");
  const open = picker.style.display === "block";
  if (open) {
    picker.style.display = "none";
    toggle.textContent = "Browse tree ▾";
    return;
  }
  picker.style.display = "block";
  toggle.textContent = "Hide tree ▴";
  // Default the picker's entity_type to (in order): the form's --type select,
  // the reviewer's suggested entity_type derived from sug.suggested_parent
  // (if it matches a known parent), or the first entity_type.
  const formType = document.getElementById("ac-type").value;
  const initial = formType || entityTypes[0]?.name;
  document.getElementById("ac-tree-type").value = initial;
  await acRenderTreeList(initial);
}

async function acRenderTreeList(entityType) {
  const list = document.getElementById("ac-tree-list");
  if (!entityType) { list.innerHTML = `<span style="color:var(--text-muted);font-size:12px">no entity_type selected</span>`; return; }
  list.innerHTML = `<span style="color:var(--text-muted);font-size:12px">loading…</span>`;
  const d = await fetchSubtree(entityType);
  const nodes = d.nodes || [];
  const currentParent = document.getElementById("ac-parent").value.trim();
  list.innerHTML = nodes.map(n => `
    <div class="tree-node ${n.label === currentParent ? 'selected' : ''}"
         data-label="${escapeHtml(n.label)}"
         data-etype="${escapeHtml(entityType)}"
         style="padding-left:${n.depth * 14 + 8}px">
      ${escapeHtml(n.label)}
    </div>
  `).join("");
  list.querySelectorAll(".tree-node").forEach(el => {
    el.addEventListener("click", () => acPickParent(el.dataset.label, el.dataset.etype));
  });
}

function acPickParent(label, entityType) {
  document.getElementById("ac-parent").value = label;
  // Auto-fill entity_type so the maintainer doesn't have to pick it separately
  if (entityType) {
    const typeSelect = document.getElementById("ac-type");
    typeSelect.value = entityType;
  }
  // Highlight the picked node
  document.querySelectorAll("#ac-tree-list .tree-node").forEach(n => {
    n.classList.toggle("selected", n.dataset.label === label);
  });
}
function ontologyShowSynonymForm() {
  document.getElementById("ontology-inline-form").classList.add("shown");
  const rps = (ontologyData && ontologyData.reviewer_proposals) || [];
  const seedType = (rps[0] && rps[0].suggested_parent) || "";
  const typeOptions = entityTypes.map(t =>
    `<option value="${escapeHtml(t.name)}" ${t.name === seedType ? "selected" : ""}>${escapeHtml(t.name)}</option>`
  ).join("");
  document.getElementById("ontology-inline-form").innerHTML = `
    <div class="form-title">Accept as synonym — point to existing concept</div>
    <div class="field">
      <label>entity_type subtree to browse</label>
      <select id="syn-tree-type">${typeOptions}</select>
    </div>
    <div class="field">
      <label>Synonym target concept_name</label>
      <input type="hidden" id="syn-target" value="">
      <div id="syn-tree-list" class="tree-picker tree-picker-list">loading…</div>
      <div class="helper" style="margin-top:4px">Selected: <code id="syn-selected">(none)</code></div>
    </div>
    <div class="field"><label>Rationale (optional)</label><textarea id="syn-rationale" rows="2"></textarea></div>
    <div class="actions">
      <button onclick="ontologyHideInline()">Cancel</button>
      <button class="primary" id="syn-save" onclick="ontologySubmitSynonym()" disabled>Save</button>
    </div>
  `;
  document.getElementById("syn-tree-type").addEventListener("change", (e) => {
    ontologyRenderSynonymTree(e.target.value);
  });
  ontologyRenderSynonymTree(seedType || (entityTypes[0] && entityTypes[0].name));
}
async function ontologyRenderSynonymTree(entityType) {
  const list = document.getElementById("syn-tree-list");
  if (!list) return;
  if (!entityType) {
    list.innerHTML = `<span style="color:var(--text-muted);font-size:12px">no entity_type — pick one above</span>`;
    return;
  }
  list.innerHTML = `<span style="color:var(--text-muted);font-size:12px">loading…</span>`;
  const d = await fetchSubtree(entityType);
  const nodes = d.nodes || [];
  list.innerHTML = nodes.map(n => `
    <div class="tree-node" data-label="${escapeHtml(n.label)}" style="padding-left:${n.depth * 14 + 8}px">
      ${escapeHtml(n.label)}
    </div>
  `).join("");
  list.querySelectorAll(".tree-node").forEach(el => {
    el.addEventListener("click", () => ontologyPickSynonym(el.dataset.label));
  });
}
function ontologyPickSynonym(label) {
  document.getElementById("syn-target").value = label;
  document.getElementById("syn-selected").textContent = label;
  document.querySelectorAll("#syn-tree-list .tree-node").forEach(n => {
    n.classList.toggle("selected", n.dataset.label === label);
  });
  document.getElementById("syn-save").disabled = false;
}
function ontologyShowNotesForm(title) {
  document.getElementById("ontology-inline-form").classList.add("shown");
  document.getElementById("ontology-inline-form").innerHTML = `
    <div class="form-title">${escapeHtml(title)}</div>
    <div class="field"><textarea id="nt-text" rows="3" placeholder="(optional)"></textarea></div>
    <div class="actions">
      <button onclick="ontologyHideInline()">Cancel</button>
      <button class="primary" onclick="ontologySubmitSimple()">Save</button>
    </div>
  `;
  document.getElementById("nt-text").focus();
}
async function ontologySubmitAccept() {
  const final_name = document.getElementById("ac-name").value.trim();
  const parent = document.getElementById("ac-parent").value.trim();
  const entity_type = document.getElementById("ac-type").value || null;
  const rationale = document.getElementById("ac-rationale").value.trim();
  if (!final_name || !parent) { alert("concept_name and parent are required"); return; }
  await ontologySubmitDecision({
    proposal_id: ontologyData.proposal_id, decision: "accept",
    final_name, parent, entity_type, rationale,
  });
}
async function ontologySubmitSynonym() {
  const synonym_target = document.getElementById("syn-target").value.trim();
  const rationale = document.getElementById("syn-rationale").value.trim();
  if (!synonym_target) { alert("synonym_target is required"); return; }
  await ontologySubmitDecision({
    proposal_id: ontologyData.proposal_id, decision: "accept-as-synonym",
    synonym_target, rationale,
  });
}
async function ontologySubmitSimple() {
  const rationale = document.getElementById("nt-text")?.value.trim() || "";
  await ontologySubmitDecision({
    proposal_id: ontologyData.proposal_id, decision: ontologyPending, rationale,
  });
}
async function ontologySubmitDecision(body) {
  await apiPost("/api/ontology/decide", body);
  ontologyHideInline();
  return ontologyLoadNext();
}
async function ontologyClearDecision() {
  await apiPost("/api/ontology/clear", { proposal_id: ontologyData.proposal_id });
  const d = await apiGet(`/api/ontology/proposal/${encodeURIComponent(ontologyData.proposal_id)}`);
  ontologyRender(d);
}
function ontologyHideInline() { document.getElementById("ontology-inline-form")?.classList.remove("shown"); }

async function openAllProposalsModal() {
  document.getElementById("all-proposals-modal").classList.add("shown");
  const d = await apiGet("/api/ontology/proposals");
  const total = d.proposals.length;
  const decided = d.proposals.filter(p => p.prior_decision).length;
  const pct = total ? Math.round(100 * decided / total) : 0;
  document.getElementById("ap-summary").innerHTML =
    `<strong>${decided} / ${total}</strong> decided (${pct}%)
     <span class="bar"><span style="width:${pct}%"></span></span>`;
  document.getElementById("ap-list").innerHTML = d.proposals.map(p => {
    const decidedCls = p.prior_decision ? "done" : "pending";
    const mark = p.prior_decision ? "✓" : "○";
    const readyCls = p.ready_for_review ? "yes" : "no";
    const readyLabel = p.ready_for_review ? "ready" : "below threshold";
    let decisionLabel = "(pending)";
    if (p.prior_decision) {
      const pd = p.prior_decision;
      decisionLabel = pd.decision;
      if (pd.final) {
        if (pd.final.concept_name) decisionLabel += ` → ${pd.final.concept_name}`;
        if (pd.final.synonym_target) decisionLabel += ` → ${pd.final.synonym_target}`;
      }
    }
    return `
      <div class="list-row ${decidedCls}" style="grid-template-columns:26px 1fr 110px 1.2fr" onclick="ontologyJumpTo('${escapeHtml(p.proposal_id)}')">
        <span class="mark">${mark}</span>
        <span class="text">"${escapeHtml(p.surface_form)}" <span style="color:var(--text-subtle);font-size:11px">(${p.occurrence_count}× · ${p.reviewer_proposal_count} props)</span></span>
        <span class="ready-pill ${readyCls}">${readyLabel}</span>
        <span class="verdict">${escapeHtml(decisionLabel)}</span>
      </div>
    `;
  }).join("");
}
function closeAllProposalsModal() { document.getElementById("all-proposals-modal").classList.remove("shown"); }
async function ontologyJumpTo(pid) {
  closeAllProposalsModal();
  const d = await apiGet(`/api/ontology/proposal/${encodeURIComponent(pid)}`);
  ontologyRender(d);
}

// ═══════════════════════════════════════════════════════════════════════
//   Shared: subtree panel + entity-types modal
// ═══════════════════════════════════════════════════════════════════════
async function fetchSubtree(name) {
  if (subtreeCache[name]) return subtreeCache[name];
  subtreeCache[name] = await apiGet(`/api/concepts/subtree/${encodeURIComponent(name)}`);
  return subtreeCache[name];
}
async function toggleSubtree(name, view, highlightConcept) {
  const panel = document.getElementById(`${view === 'review' ? 'review' : (view === 'adjud' ? 'adjud' : 'ontology')}-subtree-panel`);
  if (panel.classList.contains("shown") && panel.dataset.name === name) {
    panel.classList.remove("shown"); return;
  }
  const d = await fetchSubtree(name);
  panel.dataset.name = name;
  const nodes = d.nodes || [];
  const nodesHtml = nodes.map(node => `
    <div class="tree-node${node.label === highlightConcept ? ' current-agent' : ''}"
         style="padding-left:${node.depth * 14 + 8}px">
      ${escapeHtml(node.label)}${node.label === highlightConcept ? ' <span style="color:var(--accent);font-size:11px;font-weight:600">← agent\u2019s pick</span>' : ''}
    </div>
  `).join("");
  panel.innerHTML = `
    <div class="head">
      <span><strong>${escapeHtml(d.name)}</strong> · ${d.n_concepts} concepts</span>
      <button class="reference-link" onclick="this.closest('.subtree-panel').classList.remove('shown')">close</button>
    </div>
    <div class="subtree-nodes" style="max-height:360px;overflow:auto">${nodesHtml}</div>
  `;
  panel.classList.add("shown");
  if (highlightConcept) {
    const hit = panel.querySelector(".tree-node.current-agent");
    if (hit) hit.scrollIntoView({ block: 'center' });
  }
}
async function openEntityTypesModal() {
  document.getElementById("entity-types-modal").classList.add("shown");
  document.getElementById("et-list").innerHTML = entityTypes.map((t, i) => `
    <div class="list-row pending" style="grid-template-columns:1fr" onclick="toggleEtRow(${i})">
      <div>
        <span style="font-weight:600;font-size:13px">${escapeHtml(t.name)}</span>
        <span style="color:var(--text-muted);font-size:12px;margin-left:8px">${t.n_concepts} concepts</span>
      </div>
      <div class="et-tree" id="et-tree-${i}" style="display:none;margin-top:8px;padding-top:8px;border-top:1px dashed var(--border)"></div>
    </div>
  `).join("");
}
async function toggleEtRow(i) {
  const tree = document.getElementById(`et-tree-${i}`);
  if (tree.style.display === "block") { tree.style.display = "none"; return; }
  const d = await fetchSubtree(entityTypes[i].name);
  tree.innerHTML = `<pre style="margin:0;max-height:280px;overflow:auto;font:12px/1.5 var(--font-mono);white-space:pre">${escapeHtml(d.ascii)}</pre>`;
  tree.style.display = "block";
}
function closeEntityTypesModal() { document.getElementById("entity-types-modal").classList.remove("shown"); }

// Global Esc closes whichever modal is open
document.addEventListener("keydown", (e) => {
  for (const m of ["batches-modal", "downloads-modal", "iaa-modal",
                   "all-mentions-modal", "all-disagreements-modal", "all-proposals-modal",
                   "entity-types-modal", "ontology-modal"]) {
    const el = document.getElementById(m);
    if (el && el.classList.contains("shown")) {
      if (e.key === "Escape") { e.preventDefault(); el.classList.remove("shown"); }
      return;
    }
  }
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") return;

  // View-specific keybindings
  const view = currentView();
  if (view === "review") {
    if (reviewPrior) return;
    const m = reviewMention;
    if (!m) return;
    const isNovel = m.status === "novel_candidate";
    if (e.key === "c") { e.preventDefault(); reviewHandlePrimary(isNovel ? "confirm_novel" : "confirm"); }
    else if (e.key === "1") { e.preventDefault(); reviewHandlePrimary(isNovel ? "missed_concept" : "fix_concept"); }
    else if (e.key === "2") { e.preventDefault(); reviewHandlePrimary(isNovel ? "fix_type_span" : "concept_name_novel"); }
    else if (e.key === "3") { e.preventDefault(); reviewHandlePrimary(isNovel ? "reject_not_entity" : "fix_type_span"); }
    else if (e.key === "4" && !isNovel) { e.preventDefault(); reviewHandlePrimary("reject_not_entity"); }
  } else if (view === "adjudicate") {
    if (!adjudData || adjudPrior) return;
    if (e.key === "a") { e.preventDefault(); adjudActionPicked("take_a"); }
    else if (e.key === "b") { e.preventDefault(); adjudActionPicked("take_b"); }
    else if (e.key === "n") { e.preventDefault(); adjudActionPicked("new_value"); }
    else if (e.key === "s") { e.preventDefault(); adjudActionPicked("defer"); }
  } else if (view === "ontology") {
    if (!ontologyData || ontologyPrior) return;
    if (e.key === "a") { e.preventDefault(); ontologyActionPicked("accept"); }
    else if (e.key === "s") { e.preventDefault(); ontologyActionPicked("accept-as-synonym"); }
    else if (e.key === "r") { e.preventDefault(); ontologyActionPicked("reject"); }
    else if (e.key === "d") { e.preventDefault(); ontologyActionPicked("defer"); }
  }
});

// Click outside any modal closes it
for (const m of ["batches-modal", "downloads-modal", "iaa-modal",
                 "all-mentions-modal", "all-disagreements-modal", "all-proposals-modal",
                 "entity-types-modal", "ontology-modal"]) {
  document.getElementById(m).addEventListener("click", (e) => {
    if (e.target.id === m) e.target.classList.remove("shown");
  });
}

// ─── Batch picker / Downloads / IAA modals ──────────────────────────────
async function openBatchesModal() {
  document.getElementById("batches-modal").classList.add("shown");
  const d = await apiGet("/api/batches");
  const current = d.current;
  document.getElementById("batches-list").innerHTML = d.batches.map(b => {
    const isCurrent = (b.batch_id === current);
    const hasRole = (b.your_roles || []).length > 0;
    const roleLabel = hasRole ? b.your_roles.join(" + ") : "no role";
    return `
      <div class="batch-row ${isCurrent ? 'current' : ''}" onclick="selectBatch('${escapeHtml(b.batch_id)}')">
        <span class="mark">${isCurrent ? '●' : '○'}</span>
        <div>
          <div class="name">${escapeHtml(b.batch_id)}</div>
          <div class="meta">${b.n_mentions} mentions · ${b.note_ids.length} note${b.note_ids.length === 1 ? '' : 's'} · reviewers: ${(b.reviewers || []).join(', ') || '—'}</div>
        </div>
        <span class="roles ${hasRole ? 'has-role' : ''}">${escapeHtml(roleLabel)}</span>
      </div>
    `;
  }).join("");
}
function closeBatchesModal() { document.getElementById("batches-modal").classList.remove("shown"); }
async function selectBatch(batchId) {
  await apiPost("/api/select_batch", { batch_id: batchId });
  closeBatchesModal();
  // Re-load page so cookie + roles re-resolve cleanly across views
  window.location.reload();
}

async function openDownloadsModal() {
  document.getElementById("downloads-modal").classList.add("shown");
  try {
    const d = await apiGet("/api/artifacts");
    const groups = {
      batch:    { title: "Batch artifacts (current batch)",  items: ["mentions","manifest","merged","iaa","adjudication","gold","restructuring","verdicts"] },
      ontology: { title: "Ontology artifacts (cross-batch)", items: ["proposals","decisions","concepts","changelog"] },
    };
    const labels = {
      mentions: "mentions.jsonl  — frozen agent NER output",
      manifest: "manifest.json   — batch metadata",
      merged:   "merged.jsonl    — reviewer-pair merge + agreement",
      iaa:      "iaa.json        — IAA report",
      adjudication: "adjudication.jsonl — adjudicator decisions",
      gold:     "gold.jsonl      — final ground truth",
      restructuring: "restructuring_needed.jsonl",
      verdicts: "verdicts.jsonl  — your own verdicts",
      proposals: "proposals.jsonl — ontology proposal queue",
      decisions: "decisions.jsonl — maintainer decisions",
      concepts:  "concepts.json   — current ontology",
      changelog: "changelog.jsonl — ontology version history",
    };
    function fmt(b) { return b < 1024 ? `${b}B` : (b < 1024**2 ? `${(b/1024).toFixed(1)}KB` : `${(b/1024/1024).toFixed(2)}MB`); }
    let html = "";
    for (const [key, g] of Object.entries(groups)) {
      html += `<div class="dl-group-title">${g.title}</div>`;
      for (const kind of g.items) {
        const meta = d[kind] || {exists: false, size: 0};
        html += `
          <div class="dl-row ${meta.exists ? '' : 'missing'}">
            <span class="name">${escapeHtml(labels[kind] || kind)}</span>
            <span class="size">${meta.exists ? fmt(meta.size) : '(not generated)'}</span>
            <button class="dl-btn" ${meta.exists ? '' : 'disabled'} onclick="downloadArtifact('${kind}')">Download</button>
          </div>
        `;
      }
    }
    document.getElementById("downloads-list").innerHTML = html;
  } catch (e) {
    document.getElementById("downloads-list").innerHTML = `<div style="color:var(--danger)">${escapeHtml(String(e))}</div>`;
  }
}
function closeDownloadsModal() { document.getElementById("downloads-modal").classList.remove("shown"); }
function downloadArtifact(kind) {
  // Trigger a real file download via a hidden anchor
  const a = document.createElement("a");
  a.href = `/api/download/${encodeURIComponent(kind)}`;
  a.click();
}

function _kappaClass(v) {
  if (v >= 0.6) return "good";
  if (v >= 0.4) return "warn";
  return "poor";
}
function _kappaPill(v) {
  if (v >= 0.8)  return `<span class="iaa-pill success">excellent</span>`;
  if (v >= 0.6)  return `<span class="iaa-pill success">substantial</span>`;
  if (v >= 0.4)  return `<span class="iaa-pill warning">moderate</span>`;
  if (v >= 0)    return `<span class="iaa-pill danger">weak</span>`;
  return `<span class="iaa-pill danger">below random</span>`;
}
async function openIaaModal() {
  document.getElementById("iaa-modal").classList.add("shown");
  try {
    const d = await apiGet("/api/adjudicate/iaa");
    const k = d.kappa || {};
    const aqc = d.agent_quality_correlation?.by_status || {};
    const peetk = d.per_entity_type_concept_kappa || {};
    let html = `
      <div class="summary">
        <strong>${d.n_mentions}</strong> mentions
        · <strong>${d.n_needs_adjudication}</strong> need adjudication
        · <strong>${d.n_ontology_proposals}</strong> ontology proposals
      </div>
      <div class="iaa-grid">
        <div class="iaa-card">
          <h3>Cohen's kappa</h3>
          ${Object.entries(k).map(([dim, v]) => `
            <div class="iaa-row">
              <span class="k">${escapeHtml(dim)}</span>
              <span>${_kappaPill(v)} <span class="v ${_kappaClass(v)}">${v.toFixed(3)}</span></span>
            </div>
          `).join("")}
        </div>
        <div class="iaa-card">
          <h3>Agent quality by status</h3>
          ${Object.entries(aqc).map(([s, info]) => {
            const pct = (info.agreement_rate * 100).toFixed(1);
            const klass = info.agreement_rate >= 0.9 ? "good" : (info.agreement_rate >= 0.7 ? "warn" : "poor");
            return `
              <div class="iaa-row">
                <span class="k">${escapeHtml(s)}  <span style="font-size:11px;color:var(--text-subtle)">n=${info.n}</span></span>
                <span class="v ${klass}">${pct}%</span>
              </div>
            `;
          }).join("")}
        </div>
      </div>
      <div class="iaa-card" style="margin-top:14px">
        <h3>Per entity_type concept kappa</h3>
        ${Object.entries(peetk).map(([et, v]) => `
          <div class="iaa-row">
            <span class="k">${escapeHtml(et)}</span>
            <span class="v ${_kappaClass(v)}">${v.toFixed(3)}</span>
          </div>
        `).join("")}
      </div>
    `;
    document.getElementById("iaa-body").innerHTML = html;
  } catch (e) {
    document.getElementById("iaa-body").innerHTML = `<div style="color:var(--danger);padding:1em">${escapeHtml(String(e))}<br><span style="color:var(--text-muted);font-size:12px">Run <code>merge_iaa.py</code> to generate iaa.json.</span></div>`;
  }
}
function closeIaaModal() { document.getElementById("iaa-modal").classList.remove("shown"); }

// ─── Initial load ────────────────────────────────────────────────────────
(async () => {
  await loadMe();          // sets userRoles + hides inaccessible nav items
  await loadEntityTypes();
  showView(currentView());
  refreshBadges();
})();
</script>
</body>
</html>
"""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--batch", default=None,
                        help="default batch_id (cookie can override per session). "
                             "If omitted, every login must POST /api/select_batch first.")
    parser.add_argument("--review-root", type=Path, default=Path("review"))
    parser.add_argument("--ontology-root", type=Path, default=Path("ontology"))
    parser.add_argument("--results-ner-root", type=Path, default=Path("results/ner"))
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18090)
    parser.add_argument("--reviewer", action="append", default=[], metavar="NAME",
                        help="add reviewer role to this user across all batches (repeatable)")
    parser.add_argument("--adjudicator", action="append", default=[], metavar="NAME",
                        help="add adjudicator role to this user (repeatable)")
    parser.add_argument("--maintainer", action="append", default=[], metavar="NAME",
                        help="add maintainer role to this user (repeatable)")
    args = parser.parse_args()

    global REVIEW_ROOT, ONTOLOGY_ROOT, RESULTS_NER_ROOT, DEFAULT_BATCH_ID
    global CLI_REVIEWERS, CLI_ADJUDICATORS, CLI_MAINTAINERS
    REVIEW_ROOT = args.review_root
    ONTOLOGY_ROOT = args.ontology_root
    RESULTS_NER_ROOT = args.results_ner_root
    DEFAULT_BATCH_ID = args.batch
    CLI_REVIEWERS = list(args.reviewer)
    CLI_ADJUDICATORS = list(args.adjudicator)
    CLI_MAINTAINERS = list(args.maintainer)

    # Validate the default batch (if provided) and warm the roles cache.
    available = [b["batch_id"] for b in _list_batches()]
    if DEFAULT_BATCH_ID:
        bd = REVIEW_ROOT / "batches" / DEFAULT_BATCH_ID
        if not (bd / "mentions.jsonl").exists():
            raise SystemExit(
                f"default --batch {DEFAULT_BATCH_ID!r} not found; available: {available}"
            )

    print("\n  BSO-AD Curation Workbench ready")
    print(f"     review-root: {REVIEW_ROOT}")
    print(f"     batches:     {available}")
    print(f"     default:     {DEFAULT_BATCH_ID or '(none — user must pick after login)'}")
    print(f"     open:        http://{args.host}:{args.port}\n")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
