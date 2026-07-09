#!/usr/bin/env python3
"""Assemble a review batch from results/ner/*.json files.

Usage:
    python3 batch_init.py \
        --batch-id 2026-05-28-7c3a \
        --reviewers alice bob \
        --include-note-id sdoh_ad_demo community_intervention_study
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Ensure the vendor root (parent of this pipeline/ dir) is on sys.path so
# that `claude_agent.*` resolves when this script is run directly.
sys.path.insert(0, str(Path(__file__).parent.parent))

from claude_agent.review.batch import init_batch


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--results-root", type=Path, default=Path("results/ner"))
    p.add_argument("--review-root", type=Path, default=Path("review"))
    p.add_argument("--batch-id", required=True)
    p.add_argument("--reviewers", nargs="+", required=True,
                   help="Two or more reviewer ids (e.g. alice bob)")
    p.add_argument("--include-note-id", nargs="*", default=None,
                   help="If set, only these note_ids are included; else all in results-root")
    p.add_argument("--notes-csv", type=Path, default=None,
                   help="Notes CSV that backs this batch (note_id → note_text mapping for review).")
    args = p.parse_args(argv)
    try:
        batch_dir = init_batch(
            results_root=args.results_root,
            review_root=args.review_root,
            batch_id=args.batch_id,
            reviewers=args.reviewers,
            include_note_ids=args.include_note_id,
            notes_csv=args.notes_csv,
        )
    except FileExistsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    print(f"batch initialized at {batch_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
