import shutil
from pathlib import Path

import yaml

from chart_review.codify import codify, write_artifacts


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


def test_writes_keyword_set_md_files(tmp_path):
    pkg, bundle = _setup(tmp_path)
    written = write_artifacts(package_dir=pkg, bundle=bundle)
    kw_dir = pkg / "references" / "keyword_sets"
    assert (kw_dir / "kw_lung_pathology.md").is_file()
    assert (kw_dir / "kw_lung_imaging.md").is_file()
    assert any("kw_lung_pathology.md" in str(p) for p in written)


def test_writes_code_set_md_files(tmp_path):
    pkg, bundle = _setup(tmp_path)
    write_artifacts(package_dir=pkg, bundle=bundle)
    cs_dir = pkg / "references" / "code_sets"
    assert (cs_dir / "codes_lung_pathology.md").is_file()


def test_writes_note_type_filters_file(tmp_path):
    pkg, bundle = _setup(tmp_path)
    write_artifacts(package_dir=pkg, bundle=bundle)
    f = pkg / "references" / "note_type_filters.md"
    assert f.is_file()


def test_written_files_have_yaml_frontmatter(tmp_path):
    pkg, bundle = _setup(tmp_path)
    write_artifacts(package_dir=pkg, bundle=bundle)
    text = (pkg / "references" / "keyword_sets" / "kw_lung_pathology.md").read_text()
    assert text.startswith("---\n")
    assert "\n---\n" in text
    fm = yaml.safe_load(text.split("---\n")[1])
    assert fm["id"] == "kw_lung_pathology"
    assert "biopsy" in fm["terms"]


def test_re_run_is_idempotent_on_clean_inputs(tmp_path):
    pkg, bundle = _setup(tmp_path)
    write_artifacts(package_dir=pkg, bundle=bundle)
    first = (pkg / "references" / "keyword_sets" / "kw_lung_pathology.md").read_text()
    # Re-run with the SAME bundle (so codified_at differs, but everything else
    # is identical).
    write_artifacts(package_dir=pkg, bundle=bundle)
    second = (pkg / "references" / "keyword_sets" / "kw_lung_pathology.md").read_text()
    # Strip the codified_at line for the comparison (it's the only timestamp).
    def strip_ts(s):
        return "\n".join(line for line in s.splitlines() if "codified_at" not in line)
    assert strip_ts(first) == strip_ts(second)
