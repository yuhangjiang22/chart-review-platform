#!/usr/bin/env python3
"""Aggregate RUCAM real-data validation across the adjudicated fixtures.

Reads ONLY structured answers (per-item scores, total, category) from each
patient's agent_draft.json and the stashed gold. Prints a per-patient
scorecard + an aggregate (per-item mean bias / MAE, total error, category
accuracy). Does NOT read evidence/notes/transcripts.

Usage (from concur root):
  ./python/.venv/bin/python scripts/rucam-realtest/validate.py --run-id <RUN_ID>
"""
import argparse, json, sys
from pathlib import Path

ITEMS = ["item_1_time_to_onset", "item_2_course", "item_3_risk_factors",
         "item_4_concomitant", "item_5_exclusion", "item_6_hepatotoxicity",
         "item_7_rechallenge"]
SHORT = ["1onset", "2course", "3risk", "4concom", "5exclu", "6heptx", "7rechal"]


def as_int(v):
    try:
        return int(float(v))
    except (ValueError, TypeError):
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run-id", required=True, action="append",
                    help="run id(s); repeat to span multiple runs (first run with a patient's draft wins)")
    ap.add_argument("--runs-root", default="var/runs")
    ap.add_argument("--corpus", default="corpus/patients")
    ap.add_argument("--tolerance", type=int, default=2)
    args = ap.parse_args()

    def find_draft(pid):
        for rid in args.run_id:
            p = Path(args.runs_root) / rid / "per_patient" / pid / "agent_draft.json"
            if p.is_file():
                return p
        return None

    fixtures = sorted(Path(args.corpus).glob("patient_real_rucam_*"))
    if not fixtures:
        sys.exit("no patient_real_rucam_* fixtures found")

    rows = []
    for fx in fixtures:
        pid = fx.name
        draft_p = find_draft(pid)
        exp_p = fx / "expected_rucam.json"
        if not exp_p.is_file():
            continue
        gold = json.loads(exp_p.read_text())
        if draft_p is None:
            rows.append({"pid": pid, "missing": True, "gold": gold})
            continue
        fa = json.loads(draft_p.read_text()).get("field_assessments", [])
        ans = {f.get("field_id"): f.get("answer") for f in fa} if isinstance(fa, list) else {}
        a_items = [as_int(ans.get(it)) for it in ITEMS]
        a_total = as_int(ans.get("rucam_total_score"))
        if a_total is None and all(x is not None for x in a_items):
            a_total = sum(a_items)
        a_cat = ans.get("rucam_causality_category")
        rows.append({"pid": pid, "missing": False, "gold": gold,
                     "a_items": a_items, "a_total": a_total, "a_cat": a_cat})

    # per-patient table
    print("=== per-patient (agent vs gold) ===")
    hdr = f"{'fixture':<16}{'agent_total':>12}{'gold_total':>11}{'diff':>6}  {'agent_cat':<16}{'gold_cat':<12}"
    print(hdr)
    done = [r for r in rows if not r.get("missing")]
    for r in rows:
        if r.get("missing"):
            print(f"{r['pid']:<16}{'(no draft)':>12}")
            continue
        g = r["gold"]
        diff = (r["a_total"] - g["gold_total"]) if r["a_total"] is not None else None
        print(f"{r['pid']:<16}{str(r['a_total']):>12}{g['gold_total']:>11}"
              f"{('' if diff is None else f'{diff:+d}'):>6}  "
              f"{str(r['a_cat']):<16}{str(g['gold_category']):<12}")

    if not done:
        sys.exit("no drafts to aggregate")

    # per-item aggregate (agent - gold)
    print("\n=== per-item bias (agent minus gold), across", len(done), "patients ===")
    print(f"{'item':<10}{'mean_bias':>10}{'MAE':>7}{'n':>4}   per-patient (agent/gold)")
    item_bias_sum = [0.0] * 7
    for j in range(7):
        diffs = []
        cells = []
        for r in done:
            a = r["a_items"][j]
            g = r["gold"]["gold_items"].get(str(j + 1), r["gold"]["gold_items"].get(j + 1))
            if a is not None and g is not None:
                diffs.append(a - g)
                cells.append(f"{a}/{g}")
        if diffs:
            mb = sum(diffs) / len(diffs)
            mae = sum(abs(d) for d in diffs) / len(diffs)
            item_bias_sum[j] = mb
            flag = "  <<< over" if mb >= 1.0 else ("  << under" if mb <= -1.0 else "")
            print(f"{SHORT[j]:<10}{mb:>+10.2f}{mae:>7.2f}{len(diffs):>4}   {' '.join(cells)}{flag}")

    # totals
    tdiffs = [r["a_total"] - r["gold"]["gold_total"] for r in done if r["a_total"] is not None]
    cat_hits = sum(1 for r in done
                   if str(r["a_cat"]).lower() == str(r["gold"]["gold_category"]).lower())
    over = sum(1 for d in tdiffs if d > args.tolerance)
    print("\n=== totals ===")
    print(f"patients run:            {len(done)}/{len(rows)}")
    if tdiffs:
        print(f"total mean bias:         {sum(tdiffs)/len(tdiffs):+.2f}")
        print(f"total MAE:               {sum(abs(d) for d in tdiffs)/len(tdiffs):.2f}")
        print(f"over-scored by > {args.tolerance}:      {over}/{len(tdiffs)}")
    else:
        print("total mean bias:         n/a (no patient has a computable total — "
              "an item is Pending, e.g. onset_latency_days unset)")
    print(f"category exact match:    {cat_hits}/{len(done)}")
    print("\n(positive item bias = agent scores HIGHER than human = under-penalizing)")


if __name__ == "__main__":
    main()
