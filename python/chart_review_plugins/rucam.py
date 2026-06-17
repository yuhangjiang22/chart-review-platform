"""RUCAM read/compute tools for concur, reused from RUCAM/agent_v2.

The tool bodies live in rucam_tools.py (= agent_v2/tools.py) and rucam_r_ratio.py
(= agent_v2/r_ratio.py), copied UNCHANGED so scoring matches the validated RUCAM
agent. This module just curates the TOOLS the deepagents sidecar loads.

Hybrid tool location (per the per-task tool registry design): NOTE reading stays
on concur's MCP tools (list_notes / read_note, faithfulness-gated). RUCAM's own
CSV note tools (list_notes_index / search_notes / get_note_section) are
deliberately NOT exported here. Only the structured/compute tools are plugins —
they read the RUCAM CSV cohort (data_dir) filtered by person_id; both are bound
per run by the plugin loader.
"""
from .rucam_tools import (
    get_patient_summary,
    get_suspect_drug,
    get_medications,
    get_drug_episodes,
    get_lft_series,
    get_lab_extremum,
    get_serology,
    get_conditions,
    get_hepatotoxicity_category,
)
from .rucam_r_ratio import compute_r_ratio
from .rucam_item5 import score_item5_exclusion

TOOLS = [
    get_patient_summary,
    get_suspect_drug,
    get_medications,
    get_drug_episodes,
    get_lft_series,
    get_lab_extremum,
    get_serology,
    get_conditions,
    get_hepatotoxicity_category,
    compute_r_ratio,
    # Item-5 structured floor + per-cause breakdown. Concur addition (not from
    # agent_v2): on real data the agent rotely scored item 5 = +1 ("all
    # excluded"); this forces it to start from a data-derived floor and justify
    # any score above it with note evidence. See rucam_item5.py.
    score_item5_exclusion,
]
