"""Per-item task prompts for RUCAM per-item invocation. Each prompt narrows the
agent to ONE item and mandates the discipline it skips in the single-call path:
read the item's method, sweep the notes (search_notes), use the item's tools,
write exactly one field. Ported/adapted from RUCAM/agent_v2/prompts.py to use
concur's MCP note tools + set_field_assessment write."""
from typing import List, Dict, Any

ITEM_NAMES = {
    1: "Time to onset", 2: "Course (dechallenge)", 3: "Risk factors",
    4: "Concomitant drugs", 5: "Exclusion of other causes",
    6: "Prior hepatotoxicity", 7: "Rechallenge",
}


def build_item_task_prompt(entry: Dict[str, Any], prior: List[Dict[str, Any]]) -> str:
    n = entry["item_number"]
    fid = entry["field_id"]
    name = ITEM_NAMES.get(n, fid)
    kws = ", ".join(entry.get("keywords", []))

    def _prior_line(p: Dict[str, Any]) -> str:
        base = f"  - item {p['item_number']} ({p['field_id']}): {p.get('answer')}"
        r = (p.get("reasoning") or "").strip().replace("\n", " ")
        return f"{base} — {r[:120]}" if r else base

    prior_lines = "\n".join(_prior_line(p) for p in prior) or "  (none yet)"

    item5 = ""
    if fid == "item_5_exclusion":
        item5 = ("\n3b. MANDATORY: call `score_item5_exclusion` (it is already bound to this "
                 "patient — pass no arguments) and start from its "
                 "`recommended_floor`. Raise above it ONLY by citing explicit note exclusions "
                 "(from your search_notes/read_note results) for `not_assessed` causes; lower "
                 "toward -3 if a competing cause clearly explains the injury.")

    return f"""Score ONLY RUCAM item {n} — {name} (field_id: `{fid}`). Do not score any other item.

1. Read the scoring method first. Read the shared eligibility setup
   read_file("/chart-review-rucam/references/scoring/item-0-setup.md"), then the
   item-specific method read_file("{entry['skill_file']}"). Follow it exactly.
2. Gather structured data. Use the rucam tools for COMPUTED logic (compute_r_ratio,
   get_drug_episodes' 45-day merge, get_lab_extremum, the LiverTox lookup
   get_hepatotoxicity_category, get_patient_summary flags). For the
   raw labs / meds / conditions you will CITE, also read them via `read_structured_data`
   (tables: `measurements` = LFTs+serology, `drugs` = medications, `conditions`) —
   each row has a `row_id` you can cite (see step 4). `list_structured_data` lists the
   tables + row counts first.
3. Sweep the notes — REQUIRED: call `search_notes(keyword)` for each of these terms:
   {kws}
   then, for each note that matched, call `get_note_section(filename)` to read just
   its rubric-relevant sections (Assessment/Plan/Impression/Diagnoses/Labs/HPI/…) —
   it is much cheaper than the full note. Only fall back to `read_note` (full text)
   if the section you need is missing or the `get_note_section` result is ambiguous.{item5}
4. Write your verdict with `set_field_assessment(field_id="{fid}", answer=<score>, rationale="…", evidence=[...])`.
   In `rationale`, give your scoring reasoning and END it with `Score: <the score>`
   (e.g. `Score: -2`); it MUST equal `answer`. If the two disagree, a reviewer trusts
   the `Score:` in your reasoning — so make them consistent.
   EVIDENCE SOURCE — pick the right one or the write is REJECTED. PREFER citable
   structured/note evidence over `computed` so a reviewer can trace the score:
   - A specific lab / med / condition → `source:"structured"` with the `table`
     (`measurements`/`drugs`/`conditions`) and the `row_id` of the exact row from
     `read_structured_data`. Use this for the LFT values, the suspect/concomitant
     drug rows, and the comorbidity rows you relied on.
   - A statement in a NOTE → `source:"note"` with note_id, span_offsets [start,end],
     and a verbatim_quote. Cite the note that actually supports THIS item.
   - Only a purely DERIVED quantity with no single underlying row (e.g. the R-ratio
     value, the exclusion-floor result) → `source:"computed"`; state the basis in the text.
   Do NOT cite an unrelated note just to satisfy the requirement. Score ONLY `{fid}`.

Prior item scores (context; do not re-score them):
{prior_lines}
"""


def format_case_facts(facts: Dict[str, Any]) -> str:
    """Render the once-computed shared foundations as a compact block for every
    group prompt, so groups don't each re-fetch the suspect drug / T0 / R-ratio."""
    if not facts:
        return "  (not available from structured data — establish these yourself with the tools)"
    L: List[str] = []
    if facts.get("suspect_drug"):
        s = f"  - Suspect drug: {facts['suspect_drug']}"
        if facts.get("suspect_first_date"):
            s += f" (first structured exposure {facts['suspect_first_date']})"
        if facts.get("stratum"):
            s += f" [stratum: {facts['stratum']}]"
        L.append(s)
    else:
        L.append("  - Suspect drug: none in structured data — check the notes")
    if facts.get("liver_injury_date"):
        L.append(f"  - Liver injury date (T0): {facts['liver_injury_date']}")
    if facts.get("r_ratio") is not None:
        L.append(f"  - R ratio: {facts['r_ratio']} → injury pattern: {facts.get('injury_pattern', '?')}")
    if facts.get("age") is not None:
        L.append(f"  - Age at injury: {facts['age']}")
    if facts.get("n_concomitant_drugs_90d") is not None:
        L.append(f"  - Concomitant drugs in 90-day window (structured count): {facts['n_concomitant_drugs_90d']}")
    return "\n".join(L)


def build_group_task_prompt(group: Dict[str, Any], case_facts_block: str,
                            prior: List[Dict[str, Any]], pending: List[str]) -> str:
    """One short, fresh conversation for a GROUP of leaves that share evidence.
    Injects the shared case facts + compact summaries of already-committed groups,
    and asks the agent to commit exactly this group's leaves. Context stays small
    because nothing from prior groups' raw exploration is carried forward."""
    title = group.get("title", group.get("group_id", "group"))
    fields = ", ".join(f"`{f}`" for f in pending)
    kws = ", ".join(group.get("keywords", []))
    skill_reads = "\n".join(f'   - read_file("{sf}")' for sf in group.get("skill_files", [])) \
        or "   (this group has no dedicated scoring file)"

    def _prior_line(p: Dict[str, Any]) -> str:
        committed = p.get("committed") or {}
        vals = ", ".join(f"{k}={v}" for k, v in committed.items()) or "(none)"
        return f"  - {p.get('title', p.get('group_id'))}: {vals}"
    prior_lines = "\n".join(_prior_line(p) for p in prior) or "  (none yet)"

    item5 = ""
    if group.get("group_id") == "exclusion":
        item5 = ("\n   MANDATORY for this group: call `score_item5_exclusion` (already bound to this "
                 "patient — pass no arguments) and start from its per-cause statuses. Raise a cause to "
                 "`ruled_out`/`yes` ONLY by citing a negative test or explicit note exclusion; a "
                 "documented-negative result counts even if it was drawn for another cause. Set "
                 "`alt_cause_explains=yes` (drives the -3 override) only if a NON-drug cause clearly "
                 "explains the injury — a competing drug belongs in item 4, not here.")

    return f"""Commit ONLY the RUCAM leaf fields in the "{title}" group: {fields}.
Do NOT touch any other field, and do NOT set the derived item_/total/category fields — the platform computes those from your leaves.

CASE FACTS (already established — reuse them, do not re-derive):
{case_facts_block}

1. Read this group's scoring method(s) first and follow them exactly:
{skill_reads}
2. Gather THIS group's evidence: rucam tools for COMPUTED logic (compute_r_ratio,
   get_drug_episodes, get_lab_extremum, get_hepatotoxicity_category, get_patient_summary)
   + `read_structured_data` (tables: measurements / drugs / conditions) for the raw
   rows you will CITE (each row has a row_id).{item5}
3. Sweep the notes — call `search_notes(keyword)` for: {kws}
   then `get_note_section(filename)` on the notes that matched (cheaper than full read_note).
4. Commit EACH of these fields with
   `set_field_assessment(field_id=..., answer=..., rationale="…", evidence=[...])`:
   {fields}
   Evidence source or the write is REJECTED — a specific lab/med/condition →
   `source:"structured"` with table + row_id; a note statement → `source:"note"` with
   note_id, span_offsets [start,end], verbatim_quote; a purely derived quantity →
   `source:"computed"`. Do not cite an unrelated note just to satisfy the requirement.

Already-committed groups (context; do not re-score):
{prior_lines}
"""
