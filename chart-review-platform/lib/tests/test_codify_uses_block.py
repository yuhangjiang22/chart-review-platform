import re
import shutil
from pathlib import Path

import yaml

from chart_review.codify import codify, write_artifacts, update_uses_blocks


FIX = Path(__file__).resolve().parent / "fixtures" / "codify"


def _setup(tmp_path):
    pkg = tmp_path / "package"
    shutil.copytree(FIX / "locked-task", pkg)
    bundle = codify(
        package_dir=pkg,
        reviews_root=FIX / "reviews",
        task_id="locked-task",
    )
    return pkg, bundle


def _read_frontmatter(md_path: Path) -> dict:
    text = md_path.read_text()
    m = re.match(r"^---\n(.*?)\n---", text, re.DOTALL)
    return yaml.safe_load(m.group(1))


def test_adds_kw_id_to_criterion_uses(tmp_path):
    pkg, bundle = _setup(tmp_path)
    write_artifacts(package_dir=pkg, bundle=bundle)
    update_uses_blocks(package_dir=pkg, bundle=bundle)
    fm = _read_frontmatter(pkg / "references" / "criteria" / "lung_pathology.md")
    assert "kw_lung_pathology" in fm.get("uses", {}).get("keyword_sets", [])


def test_adds_codes_id_to_criterion_uses(tmp_path):
    pkg, bundle = _setup(tmp_path)
    write_artifacts(package_dir=pkg, bundle=bundle)
    update_uses_blocks(package_dir=pkg, bundle=bundle)
    fm = _read_frontmatter(pkg / "references" / "criteria" / "lung_pathology.md")
    assert "codes_lung_pathology" in fm.get("uses", {}).get("code_sets", [])


def test_preserves_hand_authored_uses(tmp_path):
    pkg, bundle = _setup(tmp_path)
    write_artifacts(package_dir=pkg, bundle=bundle)
    update_uses_blocks(package_dir=pkg, bundle=bundle)
    # lung_status had a sentinel kw_hand_authored_anchor in its uses.
    fm = _read_frontmatter(pkg / "references" / "criteria" / "lung_status.md")
    kws = fm.get("uses", {}).get("keyword_sets", [])
    assert "kw_hand_authored_anchor" in kws


def test_re_run_replaces_only_codify_prefixed_ids(tmp_path):
    """Second call with a different bundle replaces only kw_* / codes_* entries."""
    pkg, bundle = _setup(tmp_path)
    write_artifacts(package_dir=pkg, bundle=bundle)
    update_uses_blocks(package_dir=pkg, bundle=bundle)
    # Append a hand-authored kw to lung_pathology (simulating a manual edit between runs).
    crit = pkg / "references" / "criteria" / "lung_pathology.md"
    text = crit.read_text()
    text2 = text.replace(
        "uses:\n  keyword_sets:\n    - kw_lung_pathology",
        "uses:\n  keyword_sets:\n    - kw_lung_pathology\n    - kw_my_hand_anchor",
    )
    # If the criterion didn't have a uses block to start, add one.
    if text == text2:
        # The first run added uses; we can edit. Re-read and try a different anchor.
        fm_text_match = re.match(r"^---\n(.*?)\n---\n(.*)$", text, re.DOTALL)
        assert fm_text_match
        fm = yaml.safe_load(fm_text_match.group(1))
        fm.setdefault("uses", {}).setdefault("keyword_sets", []).append("kw_my_hand_anchor")
        new_fm = yaml.safe_dump(fm, sort_keys=False)
        crit.write_text(f"---\n{new_fm}---\n{fm_text_match.group(2)}")
    # Now re-run codify (a fresh bundle produces the same kw_lung_pathology
    # but should NOT remove kw_my_hand_anchor).
    bundle2 = codify(
        package_dir=pkg,
        reviews_root=FIX / "reviews",
        task_id="locked-task",
    )
    write_artifacts(package_dir=pkg, bundle=bundle2)
    update_uses_blocks(package_dir=pkg, bundle=bundle2)
    fm_after = _read_frontmatter(crit)
    kws = fm_after.get("uses", {}).get("keyword_sets", [])
    assert "kw_my_hand_anchor" in kws
    assert "kw_lung_pathology" in kws
