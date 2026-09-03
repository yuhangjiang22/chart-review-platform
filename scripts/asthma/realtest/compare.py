#!/usr/bin/env python3
"""Compare asthma-adherence agent drafts against the human annotation export.

Reads agent_draft.json from one or more var/runs/<run_id>/per_patient/<pid>/
directories and scores question-level agreement against the reviewer answers
in docs/annotations_asthma_v0.4.json (or a later export passed via --gold).

Prints per-question agreement (with the disagreeing patients), a per-patient
summary, and the rule-verdict distribution. No PHI is printed — only patient
ids (already salted hashes), question ids, and enum/numeric answers.

Usage (from the platform root):
  python3 scripts/asthma/realtest/compare.py --runs 2026-08-24T14-52-09-413Z ...
  python3 scripts/asthma/realtest/compare.py --all-runs   # scan every run dir
"""
import argparse
import json
import os
import sys
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def norm(v):
    """Normalize an answer for comparison: bools/None/strings to one canon."""
    if v is None:
        return "null"
    s = str(v).strip().lower()
    return "null" if s in ("", "none", "null") else s


def load_drafts(run_dirs):
    """patient_id -> (run_id, draft) — later runs in the arg list win."""
    drafts = {}
    for rd in run_dirs:
        pp = os.path.join(rd, "per_patient")
        if not os.path.isdir(pp):
            continue
        for pid in os.listdir(pp):
            fp = os.path.join(pp, pid, "agent_draft.json")
            if os.path.isfile(fp):
                with open(fp) as f:
                    drafts[pid] = (os.path.basename(rd), json.load(f))
    return drafts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gold", default=os.path.join(ROOT, "docs", "annotations_asthma_v0.4.json"))
    ap.add_argument("--runs", nargs="*", default=[], help="run ids under var/runs/")
    ap.add_argument("--all-runs", action="store_true", help="scan every var/runs/ dir")
    a = ap.parse_args()

    runs_root = os.path.join(ROOT, "var", "runs")
    run_dirs = [os.path.join(runs_root, r) for r in a.runs]
    if a.all_runs:
        run_dirs = sorted(
            os.path.join(runs_root, d) for d in os.listdir(runs_root)
            if os.path.isdir(os.path.join(runs_root, d))
        )
    if not run_dirs:
        sys.exit("no runs given — pass --runs <run_id ...> or --all-runs")

    with open(a.gold) as f:
        gold = json.load(f)
    gold_by_pid = {p["patient_id"]: p for p in gold["patients"]}
    drafts = load_drafts(run_dirs)

    scored = sorted(set(gold_by_pid) & set(drafts))
    missing = sorted(set(gold_by_pid) - set(drafts))
    print(f"gold patients: {len(gold_by_pid)}  drafted: {len(drafts)}  scored: {len(scored)}")
    if missing:
        print(f"not yet drafted ({len(missing)}): {' '.join(missing)}")

    per_q = defaultdict(lambda: [0, 0, []])  # qid -> [agree, total, diffs]
    per_p = {}
    verdicts = defaultdict(int)
    for pid in scored:
        run_id, draft = drafts[pid]
        agent = {q["question_id"]: q.get("answer") for q in draft.get("question_answers", [])}
        human = {q["question_id"]: q.get("answer") for q in gold_by_pid[pid]["question_answers"]}
        agree = tot = 0
        for qid in sorted(set(agent) & set(human)):
            tot += 1
            if norm(agent[qid]) == norm(human[qid]):
                agree += 1
                per_q[qid][0] += 1
            else:
                per_q[qid][2].append((pid, norm(agent[qid]), norm(human[qid])))
            per_q[qid][1] += 1
        per_p[pid] = (agree, tot, run_id)
        for v in draft.get("rule_verdicts", []):
            verdicts[(v.get("rule_id"), v.get("verdict"))] += 1

    print("\n== per-question agreement (agent vs human gold; shared questions only) ==")
    for qid, (agr, tot, diffs) in sorted(per_q.items(), key=lambda kv: kv[1][0] / max(kv[1][1], 1)):
        print(f"  {agr:2d}/{tot:2d}  {qid}")
        for pid, av, hv in diffs:
            print(f"          {pid}: agent={av!r} gold={hv!r}")

    print("\n== per-patient ==")
    for pid, (agr, tot, run_id) in sorted(per_p.items(), key=lambda kv: kv[1][0] / max(kv[1][1], 1)):
        print(f"  {agr:2d}/{tot:2d}  {pid}  ({run_id})")

    print("\n== rule-verdict distribution ==")
    for (rule, verdict), n in sorted(verdicts.items()):
        print(f"  {n:3d}  {rule}: {verdict}")

    total_agree = sum(v[0] for v in per_p.values())
    total_tot = sum(v[1] for v in per_p.values())
    if total_tot:
        print(f"\noverall: {total_agree}/{total_tot} = {total_agree / total_tot:.1%}")


if __name__ == "__main__":
    main()
