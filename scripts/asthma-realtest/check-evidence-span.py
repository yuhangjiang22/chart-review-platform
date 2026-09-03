#!/usr/bin/env python3
"""Is each cited note inside the span its answer was supposed to be judged over?

WHY THIS EXISTS. The event work-list prompt names the notes in each event's span
and tells the agent not to reach outside it, and nothing enforces that. The
faithfulness gate checks that a quoted string really appears in the note it is
attributed to — NOT that the note can describe the state of care at the event. So
an answer about a 2021 visit came back cited to a 2018 discharge summary and every
automated check passed, because the quote really was in that note.

The reviewer's UI flags such a citation per-event ("3.1y before this event"), which
only helps someone already looking at that event. This turns it into a number
you get for every run: what fraction of cited evidence sits outside the span its
answer was judged over. A prompt instruction that holds on a 6-note fixture and
fails on a 37-note real chart looks identical without it.

WHAT IS AND IS NOT A VIOLATION.

  EVENT answers are checked HARD. The span is declared: NOTE_LEAD_IN_DAYS before
  the event date (a medication list from the previous visit is legitimate evidence
  of the regimen in force today) through the end of the judgment window — the
  ETL's `deadline` when the anchor carries one, else the rule's
  `event_window_days`, else the event date itself — plus NOTE_DOC_LAG_DAYS for
  documentation lag, since a chart is written after the fact.

  VIOLATIONS ARE BUCKETED BY DISTANCE and the widening is reported, not silently
  applied. Moving a line to make a number look better is the obvious failure mode
  of a check like this one, so a citation inside the lag grace is counted and named
  separately from one outside it. A run whose only violations are one day out is a
  different finding from one citing a note three years before the event, and the
  headline number must not merge them.

  PERIOD answers are only DESCRIBED. Their lookback is not declared anywhere per
  question, and it genuinely differs: T1-SpirometryDate reaches 24 months,
  T0-AsthmaDx reaches as far back as the diagnosis, T2-WrittenActionPlan is
  12 months. Calling a 20-month-old citation a violation would be wrong for the
  first and right for the last, so this reports the age distribution and leaves
  the judgement to a reader who knows which question they are looking at.

PHI. Prints note FILENAMES (a date plus a note type) and answer values, never
quote text or note bodies. Safe to paste into a report; the same filenames already
appear in the reviewer's UI.

Usage (from chart-review-platform/):
  python3 scripts/asthma-realtest/check-evidence-span.py                # newest run
  python3 scripts/asthma-realtest/check-evidence-span.py <run_id> [...]
  python3 scripts/asthma-realtest/check-evidence-span.py --all          # every run
"""
import glob
import json
import os
import re
import sys
from collections import Counter
from datetime import date, timedelta

# Mirror NOTE_LEAD_IN_DAYS / NOTE_DOC_LAG_DAYS in
# packages/pipeline-extract-adherence/src/event-prompt.ts. Kept as literals rather
# than imported because this is a Python-side audit of a TypeScript pipeline; if
# either constant moves, the number here has to move with it. An audit that uses a
# tighter span than the prompt promises reports violations the agent was never
# told about.
NOTE_LEAD_IN_DAYS = 90
NOTE_DOC_LAG_DAYS = 3

RUBRIC = ".claude/skills/chart-review-asthma-adherence/references/rules"


def parse_day(s):
    m = re.match(r"(\d{4}-\d{2}-\d{2})", str(s or ""))
    if not m:
        return None
    try:
        return date.fromisoformat(m.group(1))
    except ValueError:
        return None


def load_windows():
    """rule_id -> event_window_days, read from the rubric so the check cannot
    drift from the rule it is checking."""
    try:
        import yaml
    except ImportError:
        print("[span] PyYAML not available — event_window_days unknown, spans "
              "will end at the event date unless the anchor carries a deadline",
              file=sys.stderr)
        return {}
    out = {}
    for fp in sorted(glob.glob(f"{RUBRIC}/*.yaml")):
        for r in (yaml.safe_load(open(fp)) or {}).get("rules", []) or []:
            if r.get("event_window_days") is not None:
                out[r["rule_id"]] = r["event_window_days"]
    return out


def event_span(event, windows):
    """(start, end) of the span this event's answers may cite from, or None when
    the event carries no parseable date."""
    d = parse_day(event.get("anchor", {}).get("date"))
    if d is None:
        return None
    meta = event.get("anchor", {}).get("meta") or {}
    judged = parse_day(meta.get("deadline"))
    if judged is None:
        judged = d + timedelta(days=windows.get(event.get("rule_id"), 0))
    return (d - timedelta(days=NOTE_LEAD_IN_DAYS),
            judged + timedelta(days=NOTE_DOC_LAG_DAYS))


def check_draft(fp, windows, violations, stats, period_ages):
    doc = json.load(open(fp))
    pid = doc.get("patient_id", "?")

    for event in doc.get("rule_events") or []:
        if (event.get("anchor") or {}).get("type") == "window":
            continue
        span = event_span(event, windows)
        d = parse_day((event.get("anchor") or {}).get("date"))
        for a in event.get("answers") or []:
            for ev in a.get("evidence") or []:
                note = ev.get("note_id")
                if not note:
                    stats["omop rows (no note to place)"] += 1
                    continue
                nd = parse_day(note)
                if nd is None or span is None:
                    stats["undateable (filename or event carries no date)"] += 1
                    continue
                if span[0] <= nd <= span[1]:
                    stats["in span"] += 1
                else:
                    stats["OUT OF SPAN"] += 1
                    violations.append({
                        "patient": pid, "rule": event.get("rule_id"),
                        "event_date": str(d), "span": f"{span[0]} … {span[1]}",
                        "question": a.get("question_id"), "note": note,
                        "days_off": (span[0] - nd).days if nd < span[0] else (nd - span[1]).days,
                    })

    # Period answers: described, not judged (see the module docstring).
    idx = None
    for e in doc.get("rule_events") or []:
        for cand in [parse_day(((e.get("anchor") or {}).get("meta") or {}).get("deadline"))]:
            if cand and (idx is None or cand > idx):
                idx = cand
    for a in doc.get("question_answers") or []:
        if a.get("source") == "derived":
            continue
        for ev in a.get("evidence") or []:
            nd = parse_day(ev.get("note_id"))
            if nd is None or idx is None:
                continue
            months = round((idx - nd).days / 30.44)
            period_ages.append((a.get("question_id"), ev.get("note_id"), months))


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if "--all" in sys.argv:
        runs = sorted({p.split("/")[2] for p in glob.glob("var/runs/*/per_patient/*/agent_draft.json")})
    elif args:
        runs = args
    else:
        drafts = sorted(glob.glob("var/runs/*/per_patient/*/agent_draft.json"), key=os.path.getmtime)
        if not drafts:
            print("[span] no agent drafts under var/runs/")
            return 0
        runs = [drafts[-1].split("/")[2]]

    windows = load_windows()
    violations, stats, period_ages = [], Counter(), []
    drafts = []
    for rid in runs:
        drafts += sorted(glob.glob(f"var/runs/{rid}/per_patient/*/agent_draft.json"))
    for fp in drafts:
        check_draft(fp, windows, violations, stats, period_ages)

    print(f"[span] runs={len(runs)} drafts={len(drafts)} "
          f"event_window_days known for {len(windows)} rule(s)\n")
    print("  EVENT citations (hard check — the rule declares its span)")
    total = stats["in span"] + stats["OUT OF SPAN"]
    for k in ["in span", "OUT OF SPAN", "omop rows (no note to place)",
              "undateable (filename or event carries no date)"]:
        pct = f"  {100 * stats[k] / total:5.1f}%" if total and k in ("in span", "OUT OF SPAN") else ""
        print(f"    {k:<48s} {stats[k]:>6}{pct}")

    if violations:
        near = [v for v in violations if v["days_off"] <= NOTE_DOC_LAG_DAYS]
        far = [v for v in violations if v["days_off"] > NOTE_DOC_LAG_DAYS]
        print(f"\n  {len(violations)} violation(s) — {len(far)} beyond the lag grace, "
              f"{len(near)} within {NOTE_DOC_LAG_DAYS} days of the span")
        for label, group in (("BEYOND THE GRACE", far), (f"within {NOTE_DOC_LAG_DAYS} days", near)):
            if not group:
                continue
            print(f"\n    {label}:")
            for v in group:
                print(f"      {v['patient']}  {v['rule']} @{v['event_date']}  span {v['span']}")
                print(f"        {v['question']} cited {v['note']}  ({v['days_off']} days outside)")

    if period_ages:
        print("\n  PERIOD citations (described only — per-question lookback is not declared)")
        buckets = Counter()
        for _, _, m in period_ages:
            buckets["<= 12 months" if m <= 12 else "13-24 months" if m <= 24 else "> 24 months"] += 1
        for k in ["<= 12 months", "13-24 months", "> 24 months"]:
            print(f"    {k:<48s} {buckets[k]:>6}")
        old = [(q, n, m) for q, n, m in period_ages if m > 24]
        if old:
            print("    citations older than 24 months (check the question's own lookback):")
            for q, n, m in old:
                print(f"      {q} cited {n}  (~{m} months before index)")

    # Only citations BEYOND the documentation-lag grace fail the check. One inside
    # it is reported (see above) but is filing lag, not evidence that cannot
    # describe the event.
    return 1 if any(v["days_off"] > NOTE_DOC_LAG_DAYS for v in violations) else 0


if __name__ == "__main__":
    sys.exit(main())
