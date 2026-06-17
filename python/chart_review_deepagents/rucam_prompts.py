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
    prior_lines = "\n".join(
        f"  - item {p['item_number']} ({p['field_id']}): {p.get('answer')}" for p in prior
    ) or "  (none yet)"

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
4. Write your verdict with `set_field_assessment(field_id="{fid}", answer=<score>, evidence=[...])`.
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
