from chart_review_deepagents.rucam_prompts import build_item_task_prompt

ENTRY = {"field_id": "item_5_exclusion", "item_number": 5,
         "skill_file": "/chart-review-rucam/references/scoring/item-5-exclusion.md",
         "keywords": ["autoimmune", "ANA", "biliary"]}

def test_prompt_is_focused_on_one_item_and_forces_discipline():
    p = build_item_task_prompt(ENTRY, prior=[])
    assert "item_5_exclusion" in p
    assert ENTRY["skill_file"] in p          # read the method first
    assert "search_notes" in p               # the note sweep
    assert "get_note_section" in p           # Pass 2 reads sections (cheaper than full notes)
    assert "autoimmune" in p and "ANA" in p  # the keywords are listed
    assert "set_field_assessment" in p       # write exactly one field
    assert "score_item5_exclusion" in p      # item-5 floor tool mandated
    assert "item-0-setup.md" in p            # shared eligibility setup is read first

def test_prompt_does_not_ask_agent_to_pass_person_id():
    # person_id is force-bound by the plugin loader; the prompt must not tell the
    # agent to pass it (the agent has no person_id to pass anyway).
    p = build_item_task_prompt(ENTRY, prior=[])
    assert "score_item5_exclusion(person_id)" not in p
    assert "pass no arguments" in p

def test_prompt_steps_are_contiguous():
    # M1: steps must be numbered without gaps (no "5." with a missing "4.").
    p = build_item_task_prompt(ENTRY, prior=[])
    import re
    nums = [int(m) for m in re.findall(r"(?m)^(\d+)\.", p)]
    assert nums == [1, 2, 3, 4]

def test_item5_floor_tool_only_mentioned_for_item5():
    p4 = build_item_task_prompt({**ENTRY, "field_id": "item_4_concomitant",
                                 "item_number": 4, "keywords": ["statin"]}, prior=[])
    assert "score_item5_exclusion" not in p4

def test_prior_scores_threaded_in():
    p = build_item_task_prompt(ENTRY, prior=[{"item_number": 1, "field_id": "item_1_time_to_onset", "answer": 2}])
    assert "item_1_time_to_onset" in p and "2" in p

def test_prior_reasoning_threaded_in_and_truncated():
    # The prior item's reasoning is carried forward (not just its score) and
    # truncated to ~120 chars so later items get context without bloat.
    long_reason = "onset began 30 days after the suspect drug start, " + ("x" * 200) + " Score: 2"
    p = build_item_task_prompt(ENTRY, prior=[{
        "item_number": 1, "field_id": "item_1_time_to_onset", "answer": 2,
        "reasoning": long_reason,
    }])
    assert "onset began 30 days after the suspect drug start" in p   # reasoning shown
    assert ("x" * 200) not in p                                       # but truncated

def test_prior_line_omits_dash_when_no_reasoning():
    # A prior entry with empty reasoning renders the score only (no trailing "— ").
    p = build_item_task_prompt(ENTRY, prior=[{
        "item_number": 1, "field_id": "item_1_time_to_onset", "answer": 2, "reasoning": "",
    }])
    assert "item_1_time_to_onset): 2" in p

def test_prompt_asks_for_score_marker_in_rationale():
    # The reconciliation guard (port of agent_v2 sync_score_from_reasoning) needs
    # the agent to end its rationale with "Score: X"; the prompt must request it.
    p = build_item_task_prompt(ENTRY, prior=[])
    assert "rationale" in p
    assert "Score:" in p
