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
        item5 = ("\n4b. MANDATORY: call `score_item5_exclusion(person_id)` and start from its "
                 "`recommended_floor`. Raise above it ONLY by citing explicit note exclusions "
                 "(from your search_notes/read_note results) for `not_assessed` causes; lower "
                 "toward -3 if a competing cause clearly explains the injury.")

    return f"""Score ONLY RUCAM item {n} — {name} (field_id: `{fid}`). Do not score any other item.

1. Read the scoring method first: read_file("{entry['skill_file']}"). Follow it exactly.
2. Gather the structured data its steps reference (the rucam tools: get_patient_summary,
   get_suspect_drug, get_drug_episodes, get_lft_series, get_lab_extremum, get_serology,
   get_conditions, get_hepatotoxicity_category, compute_r_ratio).
3. Sweep the notes — REQUIRED: call `search_notes(keyword)` for each of these terms:
   {kws}
   then `read_note` the notes that matched, to confirm or exclude per the method.{item5}
5. Write your verdict with `set_field_assessment(field_id="{fid}", answer=<score>, evidence=[...])`,
   citing both structured evidence and any note quotes. Score ONLY `{fid}`.

Prior item scores (context; do not re-score them):
{prior_lines}
"""
