from chart_review_deepagents.rucam_prompts import build_item_task_prompt

ENTRY = {"field_id": "item_5_exclusion", "item_number": 5,
         "skill_file": "/chart-review-rucam/references/scoring/item-5-exclusion.md",
         "keywords": ["autoimmune", "ANA", "biliary"]}

def test_prompt_is_focused_on_one_item_and_forces_discipline():
    p = build_item_task_prompt(ENTRY, prior=[])
    assert "item_5_exclusion" in p
    assert ENTRY["skill_file"] in p          # read the method first
    assert "search_notes" in p               # the note sweep
    assert "autoimmune" in p and "ANA" in p  # the keywords are listed
    assert "set_field_assessment" in p       # write exactly one field
    assert "score_item5_exclusion" in p      # item-5 floor tool mandated

def test_item5_floor_tool_only_mentioned_for_item5():
    p4 = build_item_task_prompt({**ENTRY, "field_id": "item_4_concomitant",
                                 "item_number": 4, "keywords": ["statin"]}, prior=[])
    assert "score_item5_exclusion" not in p4

def test_prior_scores_threaded_in():
    p = build_item_task_prompt(ENTRY, prior=[{"item_number": 1, "field_id": "item_1_time_to_onset", "answer": 2}])
    assert "item_1_time_to_onset" in p and "2" in p
