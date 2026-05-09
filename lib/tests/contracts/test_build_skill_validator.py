# lib/tests/contracts/test_build_skill_validator.py
"""End-to-end validator: walks a draft package and surfaces all diagnostics."""

from __future__ import annotations

from pathlib import Path

from chart_review.build_skill_validator import validate_package

ROOT = Path(__file__).resolve().parents[3]
FIXTURES = ROOT / "lib" / "tests" / "fixtures" / "build-skill"


def test_known_good_package_passes():
    result = validate_package(FIXTURES / "known-good")
    assert result["ok"] is True, result["diagnostics"]


def test_known_bad_meta_caught():
    """B1: meta.yaml with skill-shape keys."""
    result = validate_package(FIXTURES / "known-bad-meta")
    assert result["ok"] is False
    codes = [d["code"] for d in result["diagnostics"]]
    assert "meta_schema_violation" in codes


def test_known_bad_derivation_caught():
    """B4: derived criterion with no derivation block."""
    result = validate_package(FIXTURES / "known-bad-derivation")
    assert result["ok"] is False
    codes = [d["code"] for d in result["diagnostics"]]
    assert "criterion_schema_violation" in codes
    msgs = " ".join(d["message"] for d in result["diagnostics"])
    assert "derivation" in msgs


def test_known_bad_todo_caught():
    """A6: # TODO marker in extraction guidance prose."""
    # known-bad-todo only has a single criterion file; meta_override supplies the meta.yaml
    package = FIXTURES / "known-bad-todo"
    result = validate_package(package, meta_override=FIXTURES / "known-good" / "meta.yaml")
    assert result["ok"] is False
    codes = [d["code"] for d in result["diagnostics"]]
    assert "todo_marker_in_body" in codes


def test_known_good_no_unknown_field_references():
    """Reference check on a clean package emits no unknown_field_reference diagnostics."""
    result = validate_package(FIXTURES / "known-good")
    codes = [d["code"] for d in result["diagnostics"]]
    assert "unknown_field_reference" not in codes


def test_typo_in_derivation_caught():
    """Derivation referencing a typo'd field_id is flagged."""
    result = validate_package(FIXTURES / "known-bad-typo")
    assert result["ok"] is False
    codes = [d["code"] for d in result["diagnostics"]]
    assert "unknown_field_reference" in codes
    msgs = " ".join(d["message"] for d in result["diagnostics"])
    # The fixture's typo (see below) should be the reported unknown reference
    assert "patology_present" in msgs  # intentional typo in the fixture


def test_quoted_strings_not_treated_as_references():
    """String literals like "yes" / "confirmed" inside expressions are not field references."""
    # Re-validate known-good — its derivations include `== "yes"`, `then "confirmed"`, etc.
    # If the parser were over-eager it would flag those as unknown field references.
    result = validate_package(FIXTURES / "known-good")
    msgs = " ".join(d["message"] for d in result["diagnostics"])
    for literal in ('"yes"', '"no"', '"confirmed"', '"probable"', '"absent"'):
        assert literal not in msgs


def test_diagnostic_levels_default_to_error():
    """Every existing diagnostic code emits level='error' by default."""
    result = validate_package(FIXTURES / "known-bad-meta")
    assert result["ok"] is False
    for d in result["diagnostics"]:
        assert d.get("level") == "error", (
            f"diagnostic {d['code']!r} missing or non-error level: {d!r}"
        )


def test_ok_true_when_no_errors():
    """A package with zero diagnostics has ok=True (sanity)."""
    result = validate_package(FIXTURES / "known-good")
    assert result["ok"] is True
    assert result["diagnostics"] == []


def test_ok_false_only_on_errors():
    """If a fixture had only warning-level diagnostics, ok would stay True.

    Synthesizes the scenario by monkey-patching the diagnostic list — no
    real warning-emitter exists yet at this point in the plan. This test
    will be re-anchored to a real fixture in Task 4.
    """
    from chart_review.build_skill_validator import _ok_from_diagnostics
    assert _ok_from_diagnostics([]) is True
    assert _ok_from_diagnostics([{"code": "x", "level": "warning"}]) is True
    assert _ok_from_diagnostics([{"code": "x", "level": "error"}]) is False
    assert _ok_from_diagnostics([
        {"code": "x", "level": "warning"},
        {"code": "y", "level": "error"},
    ]) is False


def test_ref_check_refactor_preserves_known_bad_typo():
    """The cluster-1.1 typo regression test still passes after the refactor.

    Anchors the contract: regardless of how the ref-walker is structured,
    a derivation.expr referencing 'patology_present' (typo for 'pathology_present')
    in known-bad-typo must still emit unknown_field_reference.
    """
    result = validate_package(FIXTURES / "known-bad-typo")
    assert result["ok"] is False
    matching = [
        d for d in result["diagnostics"]
        if d["code"] == "unknown_field_reference"
        and "patology_present" in d["message"]
        and "derivation.expr" in d["message"]
    ]
    assert matching, f"expected unknown_field_reference for 'patology_present' in derivation.expr; got {result['diagnostics']!r}"


def test_truth_table_clean_passes():
    """Known-good's truth table evaluates to a clean pass — no truth-table diagnostics."""
    result = validate_package(FIXTURES / "known-good")
    assert result["ok"] is True
    codes = [d["code"] for d in result["diagnostics"]]
    assert "derivation_truth_table_mismatch" not in codes
    assert "derivation_no_truth_table" not in codes
    assert "derivation_eval_error" not in codes


def test_truth_table_mismatch_caught():
    """A row whose evaluate() output != expected emits an error and names the row label."""
    result = validate_package(FIXTURES / "known-bad-truth-table")
    assert result["ok"] is False
    mismatches = [
        d for d in result["diagnostics"]
        if d["code"] == "derivation_truth_table_mismatch"
    ]
    assert len(mismatches) >= 1
    assert any("BAD ROW" in d["message"] for d in mismatches), (
        f"expected the BAD ROW label in a mismatch message; got {mismatches!r}"
    )
    assert any(d.get("level") == "error" for d in mismatches)


def test_truth_table_unknown_input_field_caught():
    """A truth-table row whose inputs reference a non-declared field_id reuses
    unknown_field_reference, with the source named as derivation_truth_table.inputs."""
    result = validate_package(FIXTURES / "known-bad-truth-table")
    unknown = [
        d for d in result["diagnostics"]
        if d["code"] == "unknown_field_reference"
        and "ghost_field" in d["message"]
    ]
    assert unknown, f"expected unknown_field_reference for 'ghost_field' from truth-table inputs; got {result['diagnostics']!r}"
    assert any("derivation_truth_table.inputs" in d["message"] for d in unknown), (
        f"expected the message to name 'derivation_truth_table.inputs' as the source; got {unknown!r}"
    )


def test_derived_without_truth_table_warns():
    """A derived criterion missing a truth table emits a warning; ok stays True iff no other errors."""
    # Use known-bad-derivation as a starting point — but that fixture is intentionally
    # error-bad. Instead, build a tmp package on the fly that has a clean derived
    # criterion with no truth table.
    import tempfile, shutil
    src = FIXTURES / "known-good"
    with tempfile.TemporaryDirectory() as tmp:
        from pathlib import Path as _Path
        dst = _Path(tmp) / "pkg"
        shutil.copytree(src, dst)
        # Strip the truth table from derived_status.md
        derived = dst / "references" / "criteria" / "derived_status.md"
        text = derived.read_text()
        # Crude excision: drop the derivation_truth_table block from frontmatter
        before, table, after = text.partition("derivation_truth_table:")
        if table:
            # discard everything from 'derivation_truth_table:' until the closing '---'
            close = after.find("\n---\n")
            assert close > -1
            text = before + after[close + 1 :]
            derived.write_text(text)
        # Sanity check the excision produced parseable YAML
        import re as _re, yaml as _yaml
        excised_text = derived.read_text()
        fm_match = _re.match(r"^---\n(.*?)\n---\n", excised_text, _re.DOTALL)
        assert fm_match, f"excision broke frontmatter fences: {excised_text[:200]!r}"
        excised_fm = _yaml.safe_load(fm_match.group(1))
        assert "derivation_truth_table" not in excised_fm, (
            f"excision did not remove derivation_truth_table; got {list(excised_fm.keys())}"
        )
        assert "derivation" in excised_fm, (
            f"excision over-removed; derivation block missing from {list(excised_fm.keys())}"
        )
        result = validate_package(dst)
        warnings = [d for d in result["diagnostics"] if d["code"] == "derivation_no_truth_table"]
        assert warnings, f"expected derivation_no_truth_table warning; got {result['diagnostics']!r}"
        assert all(w.get("level") == "warning" for w in warnings)
        # ok should still be True (no errors)
        assert result["ok"] is True, f"warnings should not flip ok=False; diagnostics={result['diagnostics']!r}"


def test_truth_table_eval_error_caught():
    """If evaluate() raises (e.g. unparseable expr), the row emits derivation_eval_error.

    Constructed via a tmp package because the known-bad-truth-table eval itself
    succeeds on rows 1 and 2; row 3's unknown ref is caught by the field-ref check
    before eval (we test eval-error separately with malformed expr).
    """
    import tempfile, textwrap
    from pathlib import Path as _Path
    with tempfile.TemporaryDirectory() as tmp:
        pkg = _Path(tmp) / "pkg"
        (pkg / "references" / "criteria").mkdir(parents=True)
        (pkg / "meta.yaml").write_text(textwrap.dedent("""\
            task_type: phenotype_validation
            review_unit: patient
            manual_version: '2026-05-07'
            index_anchor: index_date
            time_windows:
              - id: lookback_24mo
                anchor: index_anchor
                start_offset: -P24M
                end_offset: P0D
            final_output: bad_total
            overview_prose: eval-error fixture
        """))
        (pkg / "references" / "criteria" / "leaf.md").write_text(textwrap.dedent("""\
            ---
            field_id: x
            prompt: a
            answer_schema: {type: number}
            ---
            ## Definition
            x.
        """))
        (pkg / "references" / "criteria" / "total.md").write_text(textwrap.dedent("""\
            ---
            field_id: bad_total
            prompt: a
            answer_schema: {type: number}
            is_final_output: true
            derivation:
              kind: expression
              expr: |
                @@ unparseable @@
            derivation_truth_table:
              - inputs: {x: 1}
                expected: 1
            ---
            ## Definition
            bad expr.
        """))
        result = validate_package(pkg)
        eval_errors = [d for d in result["diagnostics"] if d["code"] == "derivation_eval_error"]
        assert eval_errors, f"expected derivation_eval_error; got {result['diagnostics']!r}"
        assert all(e.get("level") == "error" for e in eval_errors)


def test_time_window_at_index_with_window_warns():
    """Body says 'at index' / 'currently' AND time_window present -> warning."""
    result = validate_package(FIXTURES / "known-bad-time-window")
    warnings = [
        d for d in result["diagnostics"]
        if d["code"] == "time_window_likely_unneeded"
    ]
    assert warnings, f"expected time_window_likely_unneeded; got {result['diagnostics']!r}"
    assert all(w.get("level") == "warning" for w in warnings)
    # The diagnostic must name the matched phrase verbatim
    assert any(
        ("at index" in w["message"] or "currently" in w["message"])
        for w in warnings
    ), f"expected matched phrase in message; got {warnings!r}"


def test_time_window_history_no_window_warns():
    """Body says 'history of' / 'prior' AND no time_window -> warning."""
    result = validate_package(FIXTURES / "known-bad-time-window")
    warnings = [
        d for d in result["diagnostics"]
        if d["code"] == "time_window_likely_missing"
    ]
    assert warnings, f"expected time_window_likely_missing; got {result['diagnostics']!r}"
    assert all(w.get("level") == "warning" for w in warnings)
    assert any(
        ("history of" in w["message"] or "prior" in w["message"])
        for w in warnings
    ), f"expected matched phrase in message; got {warnings!r}"


def test_time_window_check_skip_suppresses():
    """time_window_check: skip suppresses BOTH time-window heuristics on a criterion.

    The skipped.md fixture contains both 'history of' and 'currently'/'at index'
    phrasing AND has no time_window — yet the heuristic must not fire on it.
    """
    result = validate_package(FIXTURES / "known-bad-time-window")
    skipped_msgs = [
        d for d in result["diagnostics"]
        if d["path"].endswith("skipped.md")
        and d["code"] in ("time_window_likely_unneeded", "time_window_likely_missing")
    ]
    assert not skipped_msgs, (
        f"time_window_check: skip should suppress heuristic on this criterion; "
        f"got {skipped_msgs!r}"
    )


def test_time_window_warnings_dont_flip_ok():
    """Warnings alone keep ok=True. The known-bad-time-window fixture emits only warnings
    (no errors), so ok must stay True."""
    result = validate_package(FIXTURES / "known-bad-time-window")
    error_codes = [d["code"] for d in result["diagnostics"] if d.get("level") == "error"]
    # Sanity: no error-level diagnostics in this fixture
    # (it intentionally exercises only warnings)
    # But the runner-derived 'skipped' criterion has a derivation without a truth table,
    # which IS a warning, so we expect that too.
    # The check: ok must remain True regardless.
    assert result["ok"] is True, (
        f"warnings only should keep ok=True; errors={error_codes!r}; "
        f"diagnostics={result['diagnostics']!r}"
    )


def test_time_window_heuristic_scans_only_definition_and_extraction_guidance():
    """The heuristic must NOT fire on phrases appearing only in Examples / Boundary /
    Failure modes / other sections. It scans only prompt + Definition + Extraction guidance.
    """
    import tempfile, textwrap
    from pathlib import Path as _Path
    with tempfile.TemporaryDirectory() as tmp:
        pkg = _Path(tmp) / "pkg"
        (pkg / "references" / "criteria").mkdir(parents=True)
        (pkg / "meta.yaml").write_text(textwrap.dedent("""\
            task_type: phenotype_validation
            review_unit: patient
            manual_version: '2026-05-07'
            index_anchor: index_date
            time_windows:
              - id: lookback_24mo
                anchor: index_anchor
                start_offset: -P24M
                end_offset: P0D
            final_output: x
            overview_prose: section-scoping fixture
        """))
        # Criterion has NO time_window. The phrase "history of" appears ONLY in
        # the Examples section (and Boundary, Failure modes). Definition + Extraction
        # guidance sections are window-free prose. The heuristic must NOT fire.
        (pkg / "references" / "criteria" / "x.md").write_text(textwrap.dedent("""\
            ---
            field_id: x
            prompt: Is the patient currently active?
            answer_schema: {type: enum, enum: [yes, no]}
            ---

            ## Definition

            Whether the patient is currently active in the registry.

            ## Extraction guidance

            Look at the active flag in the registry.

            ## Examples

            **Satisfying**
            - "Patient with history of CHF, active" → yes (history of is mentioned but not load-bearing)

            **Non-satisfying**
            - "Inactive patient ever prior to discharge" → no

            ## Boundary

            - Past visits do not count.

            ## Failure modes

            - Reviewer confuses prior status with current.
        """))
        result = validate_package(pkg)
        # The heuristic should NOT fire on phrases inside Examples / Boundary / Failure modes.
        # The prompt says "currently" but the criterion has NO time_window, so
        # time_window_likely_unneeded should NOT fire either (no window to be unneeded).
        # time_window_likely_missing should NOT fire because all windowed phrases
        # are in non-scanned sections.
        time_warnings = [
            d for d in result["diagnostics"]
            if d["code"] in ("time_window_likely_unneeded", "time_window_likely_missing")
        ]
        assert not time_warnings, (
            f"heuristic fired on phrases in Examples/Boundary/Failure modes; "
            f"diagnostics={time_warnings!r}"
        )


def test_overview_prose_trajectory_residue_flagged():
    """meta.overview_prose containing reversion language emits a warning."""
    result = validate_package(FIXTURES / "known-bad-overview-prose")
    warnings = [
        d for d in result["diagnostics"]
        if d["code"] == "overview_prose_trajectory_residue"
    ]
    assert warnings, f"expected overview_prose_trajectory_residue warning; got {result['diagnostics']!r}"
    assert all(w.get("level") == "warning" for w in warnings)
    # The matched phrase must appear in the message verbatim
    matched_anything = any(
        any(phrase in w["message"].lower()
            for phrase in ["initially", "we revised", "first version", "we pivoted", "after revising"])
        for w in warnings
    )
    assert matched_anything, f"expected matched phrase named in message; got {warnings!r}"
    # Warnings only — ok must stay True
    assert result["ok"] is True


def test_overview_prose_check_skip_suppresses():
    """meta.overview_prose_check: skip suppresses the trajectory-residue heuristic."""
    import tempfile, shutil
    src = FIXTURES / "known-bad-overview-prose"
    with tempfile.TemporaryDirectory() as tmp:
        from pathlib import Path as _Path
        dst = _Path(tmp) / "pkg"
        shutil.copytree(src, dst)
        # Add overview_prose_check: skip to meta.yaml
        meta_path = dst / "meta.yaml"
        meta_text = meta_path.read_text()
        meta_path.write_text(meta_text + "\noverview_prose_check: skip\n")
        result = validate_package(dst)
        residue_warnings = [
            d for d in result["diagnostics"]
            if d["code"] == "overview_prose_trajectory_residue"
        ]
        assert not residue_warnings, (
            f"overview_prose_check: skip should suppress; got {residue_warnings!r}"
        )
        assert result["ok"] is True


def test_time_window_heuristic_still_fires_on_definition_section():
    """Sanity: section-scoped heuristic still fires when phrase IS in Definition."""
    import tempfile, textwrap
    from pathlib import Path as _Path
    with tempfile.TemporaryDirectory() as tmp:
        pkg = _Path(tmp) / "pkg"
        (pkg / "references" / "criteria").mkdir(parents=True)
        (pkg / "meta.yaml").write_text(textwrap.dedent("""\
            task_type: phenotype_validation
            review_unit: patient
            manual_version: '2026-05-07'
            index_anchor: index_date
            time_windows:
              - id: lookback_24mo
                anchor: index_anchor
                start_offset: -P24M
                end_offset: P0D
            final_output: x
            overview_prose: still-fires fixture
        """))
        (pkg / "references" / "criteria" / "x.md").write_text(textwrap.dedent("""\
            ---
            field_id: x
            prompt: Does the patient have a CHF diagnosis?
            answer_schema: {type: enum, enum: [yes, no]}
            ---

            ## Definition

            History of congestive heart failure documented at any prior encounter.

            ## Extraction guidance

            Look at problem list and discharge summaries.
        """))
        result = validate_package(pkg)
        warnings = [
            d for d in result["diagnostics"]
            if d["code"] == "time_window_likely_missing"
        ]
        assert warnings, (
            f"heuristic should fire when phrase is in Definition; "
            f"diagnostics={result['diagnostics']!r}"
        )
