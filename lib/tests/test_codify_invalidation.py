import re
import shutil
from pathlib import Path

import yaml

from chart_review.codify import codify, write_artifacts


FIX = Path(__file__).resolve().parent / "fixtures" / "codify"


def _read_frontmatter(md_path: Path) -> dict:
    text = md_path.read_text()
    m = re.match(r"^---\n(.*?)\n---", text, re.DOTALL)
    return yaml.safe_load(m.group(1))


def test_derived_from_carries_current_manual_version(tmp_path):
    pkg = tmp_path / "package"
    shutil.copytree(FIX / "locked-task", pkg)
    bundle = codify(package_dir=pkg, reviews_root=FIX / "reviews", task_id="locked-task")
    assert bundle["guideline_manual_version"] == "1.0.0"
    write_artifacts(package_dir=pkg, bundle=bundle)
    fm = _read_frontmatter(pkg / "references" / "keyword_sets" / "kw_lung_pathology.md")
    assert fm["derived_from"]["guideline_manual_version"] == "1.0.0"


def test_re_run_after_version_bump_writes_new_version(tmp_path):
    pkg = tmp_path / "package"
    shutil.copytree(FIX / "locked-task", pkg)
    write_artifacts(
        package_dir=pkg,
        bundle=codify(package_dir=pkg, reviews_root=FIX / "reviews", task_id="locked-task"),
    )
    # Bump the guideline's manual_version.
    meta_path = pkg / "meta.yaml"
    meta = yaml.safe_load(meta_path.read_text())
    meta["manual_version"] = "1.1.0"
    meta_path.write_text(yaml.safe_dump(meta, sort_keys=False))
    # Re-run.
    bundle2 = codify(package_dir=pkg, reviews_root=FIX / "reviews", task_id="locked-task")
    assert bundle2["guideline_manual_version"] == "1.1.0"
    write_artifacts(package_dir=pkg, bundle=bundle2)
    fm = _read_frontmatter(pkg / "references" / "keyword_sets" / "kw_lung_pathology.md")
    assert fm["derived_from"]["guideline_manual_version"] == "1.1.0"
