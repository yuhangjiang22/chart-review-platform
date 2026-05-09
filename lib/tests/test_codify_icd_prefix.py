from chart_review.codify_icd_prefix import group_icd_prefixes


def test_returns_empty_when_no_codes():
    assert group_icd_prefixes([]) == []


def test_returns_empty_when_below_threshold():
    # Only 2 leaves of C34 — below the ≥3 threshold.
    out = group_icd_prefixes(["C34.10", "C34.11"])
    assert out == []


def test_emits_prefix_when_three_leaves_share_parent():
    out = group_icd_prefixes(["C34.10", "C34.11", "C34.31"])
    # 3 leaves of C34 — emits the prefix.
    assert any(p["prefix"] == "C34.x" for p in out)


def test_prefix_carries_member_codes():
    out = group_icd_prefixes(["C34.10", "C34.11", "C34.31"])
    grp = next(p for p in out if p["prefix"] == "C34.x")
    assert set(grp["members"]) == {"C34.10", "C34.11", "C34.31"}


def test_does_not_emit_for_unrelated_codes():
    out = group_icd_prefixes(["C34.10", "I10", "E11.9"])
    assert out == []


def test_handles_mixed_above_and_below_threshold():
    # 3 of C34 (emit), 2 of E11 (skip), 1 of I10 (skip).
    out = group_icd_prefixes([
        "C34.10", "C34.11", "C34.31",
        "E11.9", "E11.65",
        "I10",
    ])
    prefixes = {p["prefix"] for p in out}
    assert prefixes == {"C34.x"}


def test_only_groups_dot_codes():
    # Pure-letter codes like "I10" with no dot don't have a prefix family.
    out = group_icd_prefixes(["I10", "I10", "I10", "I10"])
    assert out == []
