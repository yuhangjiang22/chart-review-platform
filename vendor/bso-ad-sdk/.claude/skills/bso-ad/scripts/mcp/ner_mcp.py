"""MCP server that lets the NER agent normalize entity mentions against the
BSO-AD ontology.

The environment is a single JSON file produced by
`ontology/scripts/build_concepts.py`:
    {data_root}/concepts.json

Tools expose that file to the agent: enumerate the 9 supported entity types
(top-level subtree roots), render any subtree as ASCII, and most importantly
map a (entity_type, candidate_label) tuple to a canonical concept name in the
subtree. Writing the final NER JSON is handled by the sibling
`write_ner.py` CLI script — this server only does reads.

Run:
    python3 ner_mcp.py --data-root=/abs/path/to/dir/with/concepts.json
"""

from __future__ import annotations

import argparse
import functools
import json
import os
import re
import sys
from collections import defaultdict
from pathlib import Path
from typing import Annotated, Optional

from fastmcp import FastMCP
from pydantic import BaseModel, Field


# Set by __main__ before mcp.run(). Tool calls resolve through _data_root() so
# importers can also override it programmatically or via env.
DATA_ROOT: Optional[str] = None

# Path to the source text the agent is annotating, set at startup via
# --source-text-file. `locate_in_source` reads it (cached). Tests may
# override directly. None means locate_in_source returns found=False.
SOURCE_TEXT_FILE: Optional[str] = None

ONTOLOGY_FILENAME = "concepts.json"


def _data_root() -> Path:
    if DATA_ROOT:
        return Path(DATA_ROOT)
    env = os.environ.get("NER_DATA_ROOT")
    if env:
        return Path(env)
    raise RuntimeError(
        "ner_mcp: data root not configured. Pass --data-root=<dir> on the "
        "command line or set NER_DATA_ROOT. The directory must contain "
        f"{ONTOLOGY_FILENAME}."
    )


def _ontology_path() -> Path:
    path = _data_root() / ONTOLOGY_FILENAME
    if not path.is_file():
        raise FileNotFoundError(
            f"Ontology JSON not found at {path}. Generate it with "
            f"`python ontology/scripts/build_concepts.py` or pass a different --data-root."
        )
    return path


# ---------------------------------------------------------------------------
# Ontology loading (cached)
# ---------------------------------------------------------------------------


@functools.lru_cache(maxsize=4)
def _load_ontology_cached(path_str: str, mtime_ns: int) -> dict:
    """Indexed view of the ontology JSON. Cache-keyed on (path, mtime_ns) so
    a regenerated file is picked up on the next call without restarting the
    server. The mtime arg isn't read inside; it just discriminates the cache.

    Returns:
        {
          entity_type: {
            "concepts": list[dict],          # raw records (label/parent_label/depth/...)
            "labels":   set[str],            # all labels in subtree (root excluded)
            "labels_lower": dict[str, str],  # lowercased -> original
            "tree_ascii": str,               # rendered tree (root included as line 1)
          },
          ...
        }
    """
    raw = json.loads(Path(path_str).read_text(encoding="utf-8"))
    blocks: dict = {}
    for entity_type, block in raw.items():
        if entity_type.startswith("_"):  # _meta etc.
            continue
        records = block.get("concepts", [])
        labels = {r["label"] for r in records if r.get("label") and r["label"] != entity_type}
        labels_lower = {label.lower(): label for label in labels}
        labels_lower.setdefault(entity_type.lower(), entity_type)  # so root is matchable too
        tree = _render_subtree(records, entity_type)
        blocks[entity_type] = {
            "concepts": records,
            "labels": labels,
            "labels_lower": labels_lower,
            "tree_ascii": tree,
            "by_label": {r["label"]: r for r in records if r.get("label")},
        }
    return blocks


def _load_ontology(path_str: str) -> dict:
    """Public wrapper: stat the file once, delegate to mtime-keyed cache."""
    mtime_ns = Path(path_str).stat().st_mtime_ns
    return _load_ontology_cached(path_str, mtime_ns)


def _render_subtree(records: list, root_label: str) -> str:
    """Render an ASCII tree of all descendants of root_label.

    Mirrors the renderer in `ner/normalize.py` so the agent sees the same
    layout it would see in `docs/concept_hierarchy.md`.
    """
    children_of: dict = defaultdict(list)
    for r in records:
        if r.get("parent_label") is not None:
            children_of[r["parent_label"]].append(r["label"])
    for k in children_of:
        children_of[k].sort()

    lines = [root_label]

    def walk(label: str, prefix: str, is_last: bool) -> None:
        connector = "└── " if is_last else "├── "
        lines.append(f"{prefix}{connector}{label}")
        kids = children_of.get(label, [])
        if not kids:
            return
        new_prefix = prefix + ("    " if is_last else "│   ")
        for i, kid in enumerate(kids):
            walk(kid, new_prefix, i == len(kids) - 1)

    direct = children_of.get(root_label, [])
    for i, k in enumerate(direct):
        walk(k, "    ", i == len(direct) - 1)

    return "\n".join(lines)


def _ontology() -> dict:
    return _load_ontology(str(_ontology_path().resolve()))


# ---------------------------------------------------------------------------
# Source-text loading (cached)
# ---------------------------------------------------------------------------


@functools.lru_cache(maxsize=4)
def _load_source_cached(path_str: str, mtime_ns: int) -> str:
    """Read the source-text file once per (path, mtime). mtime_ns gates the
    cache so a regenerated file is picked up without restarting the server.
    """
    return Path(path_str).read_text(encoding="utf-8")


def _source_text() -> Optional[str]:
    """Return the source text the agent is annotating, or None if unset."""
    if not SOURCE_TEXT_FILE:
        return None
    p = Path(SOURCE_TEXT_FILE)
    if not p.is_file():
        return None
    return _load_source_cached(str(p.resolve()), p.stat().st_mtime_ns)


# ---------------------------------------------------------------------------
# Pydantic return models
# ---------------------------------------------------------------------------


class EntityTypesResult(BaseModel):
    entity_types: list[str]
    counts: dict[str, int] = Field(default_factory=dict)
    # Short prose hint of what each subtree covers — the agent uses these to
    # pick the right entity_type for a candidate span. Without descriptions
    # the agent has only the 9 root names and may route by superficial word
    # association (e.g. "Lives with Spouse" → Social_and_Community_Context
    # because "social"), missing the actual home of the concept (Living_Status
    # is under Neighborhood). Descriptions disambiguate the boundaries that
    # the surface names alone don't make obvious.
    descriptions: dict[str, str] = Field(default_factory=dict)


# Authoritative subtree-coverage hints. Keep these short (1-2 lines each)
# and focused on the non-obvious boundaries — what's HERE that you might
# look for elsewhere, and what's NOT HERE despite a misleading name.
_ENTITY_TYPE_DESCRIPTIONS: dict[str, str] = {
    "Demographic": (
        "Patient identity attributes — age, biological sex, gender identity, "
        "race, ethnicity, marital status. NOT lifestyle, behavior, or sexual "
        "orientation (those are under Behavior_and_Lifestyle)."
    ),
    "Dementia": (
        "Cognitive impairment and dementia diagnoses — Alzheimer's disease "
        "(plus genetic subtypes Alzheimer_Disease_1..18), Vascular_Dementia, "
        "Frontotemporal_Dementia, Lewy_Body_Disease, Mild_Cognitive_Impairment, "
        "AD staging."
    ),
    "Element_Relevant_to_Behavior_and_Lifestyle": (
        "Substance use (tobacco / alcohol / drug — including specific "
        "smoking-by-substance like Tobacco_Smoking / Marijuana_Smoking), "
        "diet, sleep, walking, physical activity, AND sexual behavior — "
        "this is where Sexual_Orientation (Heterosexuality / Homosexuality / "
        "Bisexuality) lives, NOT under Demographic."
    ),
    "Element_Relevant_to_Economic_Stability": (
        "Employment status (Employed / Unemployed / Retired / On_Disability), "
        "occupation (SOC-style categories), income, financial stress, federal "
        "assistance programs, expenses, treatment adherence."
    ),
    "Element_Relevant_to_Education_and_Literacy": (
        "Educational attainment (High_School_Graduation etc.), literacy, "
        "health literacy, early childhood education, problems related to "
        "education."
    ),
    "Element_Relevant_to_Food": (
        "Diet patterns (High_Sodium_Intake / High_Fat_Intake etc.), food "
        "insecurity, lack of adequate food, access to healthy options."
    ),
    "Element_Relevant_to_Health_Care": (
        "Access to / quality of / payment for healthcare — Healthcare_Visit, "
        "Emergency_Department_Visit, Hospitalization, Access_to_Health_Service, "
        "Health_Insurance, Health_Care_Payment_Source. NOT diseases / drugs / "
        "labs — those go to SNOMED / RxNorm / LOINC, not BSO-AD."
    ),
    "Element_Relevant_to_Neighborhood": (
        "Living arrangement (Lives_Alone, Lives_with_Spouse, Lives_with_Child, "
        "Lives_in_Apartment/dormitory, Lives_in_Nursing_Home, Homelessness, "
        "and similar Living_Status enum), physical environment (Air_Quality, "
        "Green_Space, Weather), geographic location (Address, Food_Swamp, "
        "Concentrated_Poverty, Zip_Code). 'Lives with X' goes HERE, not under "
        "Social_and_Community_Context."
    ),
    "Element_Relevant_to_Social_and_Community_Context": (
        "Relationships (Spouse_Relationship, Sibling_Relationship, "
        "Extended_Family_Relationship, Friend_Relationship, "
        "Parent_Child_Relationship), social support, social isolation, "
        "family conflict, incarceration, adverse childhood experience, "
        "psychosocial factors. NOT living arrangement — 'Lives with X' is "
        "Neighborhood/Living_Status, not here."
    ),
}


class ConceptTreeResult(BaseModel):
    entity_type: str
    n_concepts: int
    tree_ascii: str
    found: bool = True
    message: str = ""


class NormalizeResult(BaseModel):
    entity_type: str
    label: str
    found: bool
    concept_name: str = ""
    parent_label: Optional[str] = None
    depth: Optional[int] = None
    match_kind: str = ""        # "exact" | "case_insensitive" | "underscore_normalized" | "substring_candidates" | "none"
    alternatives: list[str] = Field(default_factory=list)


class LocateResult(BaseModel):
    """Authoritative (start, end) for an entity span, computed deterministically.

    The agent supplies an `anchor` (an unambiguously-locatable substring of
    the source) and a `text` (the actual entity value, which lives somewhere
    inside that anchor). The server finds anchor in the source, then text
    inside anchor, and returns the absolute (start, end) of `text`.
    """
    found: bool
    start: int = -1
    end: int = -1
    anchor_match_count: int = 0  # how many times the anchor matched in the full source
    message: str = ""            # human-readable diagnostic when found=False


# ---------------------------------------------------------------------------
# FastMCP server
# ---------------------------------------------------------------------------


mcp = FastMCP("ner_mcp")


@mcp.tool(
    description=(
        "Return the supported entity types — root labels of the BSO-AD "
        "ontology subtrees. Use these as the only valid `entity_type` values "
        "in subsequent calls. Also returns the concept count per subtree "
        "(root excluded) AND a short prose description of what each subtree "
        "covers — use these to disambiguate routing for spans where the root "
        "name alone is misleading (e.g. living-arrangement mentions go under "
        "Neighborhood, not Social_and_Community_Context)."
    )
)
def list_entity_types() -> EntityTypesResult:
    onto = _ontology()
    types = sorted(onto.keys())
    counts = {t: len(onto[t]["labels"]) for t in types}
    descriptions = {t: _ENTITY_TYPE_DESCRIPTIONS.get(t, "") for t in types}
    return EntityTypesResult(
        entity_types=types,
        counts=counts,
        descriptions=descriptions,
    )


@mcp.tool(
    description=(
        "Return the concept subtree for one entity_type as an ASCII tree, "
        "rooted at the entity_type itself. Use this to pick the most "
        "specific concept_name for a span."
    )
)
def get_concept_tree(
    entity_type: Annotated[str, Field(description="One of the values returned by list_entity_types")],
) -> ConceptTreeResult:
    onto = _ontology()
    block = onto.get(entity_type)
    if block is None:
        return ConceptTreeResult(
            entity_type=entity_type,
            n_concepts=0,
            tree_ascii="",
            found=False,
            message=(
                f"Unknown entity_type {entity_type!r}. Call list_entity_types "
                f"to see the supported set."
            ),
        )
    return ConceptTreeResult(
        entity_type=entity_type,
        n_concepts=len(block["labels"]),
        tree_ascii=block["tree_ascii"],
    )


@mcp.tool(
    description=(
        "Map a candidate label (the surface form of an entity span) onto a "
        "canonical concept_name within the given entity_type's subtree. "
        "Match precedence: (1) exact label match, (2) case-insensitive, "
        "(3) underscore-normalized form (spaces → underscores). All three "
        "return found=True with match_kind set accordingly. If none of those "
        "hit, falls back to substring containment and returns found=False "
        "with up to 10 candidates in `alternatives` (match_kind="
        "\"substring_candidates\") — the agent must pick one explicitly via a "
        "second normalize_to_ontology call using the chosen candidate as "
        "label, or tag the span status=\"novel_candidate\" if none fit. "
        "Substring is a hint, NOT a confirmed match."
    )
)
def normalize_to_ontology(
    entity_type: Annotated[str, Field(description="One of the values returned by list_entity_types")],
    label: Annotated[str, Field(description="The entity span text to map (no preprocessing required)")],
) -> NormalizeResult:
    onto = _ontology()
    block = onto.get(entity_type)
    if block is None:
        return NormalizeResult(
            entity_type=entity_type,
            label=label,
            found=False,
            match_kind="none",
            alternatives=[],
        )

    by_label: dict = block["by_label"]
    labels_lower: dict = block["labels_lower"]
    raw = (label or "").strip()

    def _record(canonical: str) -> tuple[Optional[str], Optional[int]]:
        rec = by_label.get(canonical) or {}
        return rec.get("parent_label"), rec.get("depth")

    if not raw:
        return NormalizeResult(
            entity_type=entity_type, label=label, found=False, match_kind="none",
        )

    if raw in by_label:
        parent, depth = _record(raw)
        return NormalizeResult(
            entity_type=entity_type, label=label, found=True,
            concept_name=raw, parent_label=parent, depth=depth, match_kind="exact",
        )

    lower = raw.lower()
    if lower in labels_lower:
        canonical = labels_lower[lower]
        parent, depth = _record(canonical)
        return NormalizeResult(
            entity_type=entity_type, label=label, found=True,
            concept_name=canonical, parent_label=parent, depth=depth,
            match_kind="case_insensitive",
        )

    underscore_form = raw.replace(" ", "_")
    if underscore_form in by_label:
        parent, depth = _record(underscore_form)
        return NormalizeResult(
            entity_type=entity_type, label=label, found=True,
            concept_name=underscore_form, parent_label=parent, depth=depth,
            match_kind="underscore_normalized",
        )
    if underscore_form.lower() in labels_lower:
        canonical = labels_lower[underscore_form.lower()]
        parent, depth = _record(canonical)
        return NormalizeResult(
            entity_type=entity_type, label=label, found=True,
            concept_name=canonical, parent_label=parent, depth=depth,
            match_kind="underscore_normalized",
        )

    # Substring fallback. Keep cheap: lowercased contains either way.
    # Substring overlap is a heuristic, NOT a confident match — "stress"
    # substring-matches "stress_test" but the two are different concepts.
    # Earlier behaviour auto-confirmed found=True when len(candidates)==1,
    # which silently mis-mapped narrow surface forms onto broader concepts
    # whenever exactly one ontology label happened to share a token. Now we
    # always return found=False and surface the candidates in `alternatives`
    # so the agent has to make the decision (and our logs show it).
    candidates: list[str] = []
    for canonical_label in sorted(block["labels"]):
        cl = canonical_label.lower().replace("_", " ")
        rl = lower.replace("_", " ")
        if rl and (rl in cl or cl in rl):
            candidates.append(canonical_label)
        if len(candidates) >= 10:
            break

    return NormalizeResult(
        entity_type=entity_type, label=label, found=False,
        match_kind="substring_candidates" if candidates else "none",
        alternatives=candidates,
    )


@mcp.tool(
    description=(
        "Resolve the authoritative (start, end) character offsets of an entity "
        "in the source text the agent is annotating. Uses two-stage anchoring "
        "to disambiguate values that collide with other digits/words in the "
        "text (e.g. \"58\" inside \"1958\"):\n"
        "  Stage 1: locate `anchor` in the full source via word-boundary regex. "
        "Anchor must be unambiguous — if it matches multiple positions, returns "
        "found=False with a hint to narrow it.\n"
        "  Stage 2: locate `text` inside the anchor span (also word-boundary). "
        "If text appears multiple times within anchor, takes the first.\n"
        "Returns absolute (start, end) of `text` in the full source. Use this "
        "INSTEAD OF guessing offsets from inspection — LLM character arithmetic "
        "is unreliable.\n"
        "Tip: for entities that are already unambiguous (single-occurrence, "
        "long surface form), pass anchor == text. For short or numeric values, "
        "include nearby context words in anchor: anchor=\"age 58\", text=\"58\"."
    )
)
def locate_in_source(
    anchor: Annotated[str, Field(
        description="A substring of the source that contains this entity AND "
                    "uniquely identifies its occurrence. Word-boundary matched.",
    )],
    text: Annotated[str, Field(
        description="The actual entity value as it appears in the source. "
                    "Must occur inside `anchor`. Word-boundary matched.",
    )],
) -> LocateResult:
    src = _source_text()
    if src is None:
        return LocateResult(
            found=False,
            message=(
                "No source text configured. The runner must launch ner_mcp "
                "with --source-text-file=<path>; this is a deployment error."
            ),
        )

    if not anchor:
        return LocateResult(found=False, message="anchor is empty")
    if not text:
        return LocateResult(found=False, message="text is empty")

    # Stage 1: anchor in source
    anchor_pat = re.compile(r"\b" + re.escape(anchor) + r"\b")
    anchor_matches = list(anchor_pat.finditer(src))
    if not anchor_matches:
        # Fallback: drop \b for anchors that legitimately contain punctuation
        # at their boundaries (e.g. "—age 58—" where left boundary isn't \w↔\W).
        anchor_matches = list(re.finditer(re.escape(anchor), src))
    if not anchor_matches:
        return LocateResult(
            found=False,
            anchor_match_count=0,
            message=(
                f"anchor {anchor!r} not found in source. Check spelling / "
                f"whitespace; the anchor must be a verbatim substring."
            ),
        )
    if len(anchor_matches) > 1:
        return LocateResult(
            found=False,
            anchor_match_count=len(anchor_matches),
            message=(
                f"anchor {anchor!r} matches {len(anchor_matches)} positions "
                "in source — narrow it by including more context words "
                "(e.g. preceding/following 1-2 words) until it is unique."
            ),
        )
    a_start, a_end = anchor_matches[0].span()

    # Stage 2: text inside anchor
    region = src[a_start:a_end]
    text_pat = re.compile(r"\b" + re.escape(text) + r"\b")
    t_match = text_pat.search(region) or re.search(re.escape(text), region)
    if t_match is None:
        return LocateResult(
            found=False,
            anchor_match_count=1,
            message=(
                f"text {text!r} not found inside anchor {anchor!r}. The "
                "anchor must contain the entity value verbatim."
            ),
        )
    rel_start, rel_end = t_match.span()
    return LocateResult(
        found=True,
        start=a_start + rel_start,
        end=a_start + rel_end,
        anchor_match_count=1,
    )


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


def _parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="ner_mcp MCP server")
    parser.add_argument(
        "--data-root",
        default=None,
        help="Path to the directory containing concepts.json. "
        "Falls back to $NER_DATA_ROOT.",
    )
    parser.add_argument(
        "--source-text-file",
        default=None,
        help="Path to the source text file the agent is annotating. "
        "`locate_in_source` reads this to resolve authoritative entity offsets. "
        "Falls back to $NER_SOURCE_TEXT_FILE. When unset, locate_in_source "
        "returns found=False — the agent must then guess offsets, which is "
        "discouraged.",
    )
    return parser.parse_args(argv)


if __name__ == "__main__":
    args = _parse_args()
    if args.data_root:
        DATA_ROOT = str(Path(args.data_root).expanduser().resolve())
    elif os.environ.get("NER_DATA_ROOT"):
        DATA_ROOT = os.environ["NER_DATA_ROOT"]
    else:
        print(
            "ner_mcp: --data-root is required (or set NER_DATA_ROOT).",
            file=sys.stderr,
        )
        sys.exit(2)
    if args.source_text_file:
        SOURCE_TEXT_FILE = str(Path(args.source_text_file).expanduser().resolve())
    elif os.environ.get("NER_SOURCE_TEXT_FILE"):
        SOURCE_TEXT_FILE = os.environ["NER_SOURCE_TEXT_FILE"]
    # If neither is set, SOURCE_TEXT_FILE stays None and locate_in_source
    # returns found=False with a deployment-error message. The runner is
    # expected to inject --source-text-file but we don't hard-fail here so
    # the server still works for tests / dry-runs that don't exercise locate.
    mcp.run()
