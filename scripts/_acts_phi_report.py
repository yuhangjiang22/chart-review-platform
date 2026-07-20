#!/usr/bin/env python3
"""PHI-SAFE report for the ACTS per-note Azure run on a private patient.

Reads the agent drafts (PHI) + note files (PHI) LOCALLY to compute quality
aggregates, but prints ONLY non-PHI metadata: field coverage (schema names),
faithfulness pass-rate, and counts. Never prints answer values or evidence
quotes. The human reviews value-level accuracy in the UI.

Usage: python3 scripts/_acts_phi_report.py <drafts.json> <patient_id>
"""
import sys, json, re, os, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]

# 29 ACTS fields; derived are computed, not extracted.
DERIVED = {"apoe2", "apoe3", "apoe4", "moca_severity", "mmse_severity", "cdr_severity"}


def norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "")).strip().lower()


def load_note_text(pid, note_id):
    p = ROOT / "corpus" / "patients" / pid / "notes" / f"{note_id}.txt"
    if not p.exists():
        return None
    return p.read_text(encoding="utf-8", errors="replace")


def main():
    drafts_fp, pid = sys.argv[1], sys.argv[2]
    data = json.load(open(drafts_fp))
    drafts = data.get("drafts", []) if isinstance(data, dict) else data
    if not drafts:
        print("NO DRAFTS — run produced no agent output")
        return

    # one per-note agent draft expected (agent_1)
    fas = []
    for d in drafts:
        fas.extend(d.get("field_assessments", []))

    # group by encounter (= note)
    by_note = {}
    for fa in fas:
        enc = fa.get("encounter_id") or "(patient-level)"
        by_note.setdefault(enc, []).append(fa)

    note_cache = {}
    cov_fields = set()
    faith_ok = faith_total = faith_missingnote = 0
    # aggregate-only (no per-field values printed → PHI-safe):
    NEG = {"0", "0.0", "none", "never", "unknown", "no", "n/a", "na", "false", "negative"}
    pos_total = neg_total = pos_no_ev = 0

    print(f"=== ACTS per-note extraction — patient {pid} (Azure gpt-5.2) ===")
    print(f"notes with assessments: {len(by_note)} | total assessments: {len(fas)}\n")
    print(f"{'note_id':<34} {'leaf':>5} {'deriv':>6} {'w/ev':>5} {'faith':>7}")
    print("-" * 62)
    for note_id in sorted(by_note):
        rows = by_note[note_id]
        leaf = [r for r in rows if r.get("field_id") not in DERIVED]
        deriv = [r for r in rows if r.get("field_id") in DERIVED]
        populated_leaf = [r for r in leaf if (r.get("answer") not in (None, "", "NA"))]
        with_ev = [r for r in populated_leaf if r.get("evidence")]
        for r in populated_leaf:
            cov_fields.add(r.get("field_id"))
            is_neg = str(r.get("answer", "")).strip().lower() in NEG
            if is_neg:
                neg_total += 1
            else:
                pos_total += 1
                if not r.get("evidence"):
                    pos_no_ev += 1
        # faithfulness: verify each evidence quote against the note bytes
        if note_id not in note_cache:
            note_cache[note_id] = load_note_text(pid, note_id)
        nt = note_cache[note_id]
        n_ok = n_tot = 0
        for r in with_ev:
            for ev in (r.get("evidence") or []):
                q = ev.get("verbatim_quote") or ev.get("quote") or ev.get("text") or ""
                if not q:
                    continue
                n_tot += 1
                # verify against the note the evidence itself cites
                ev_note = ev.get("note_id") or note_id
                if ev_note not in note_cache:
                    note_cache[ev_note] = load_note_text(pid, ev_note)
                ent = note_cache[ev_note]
                if ent is None:
                    faith_missingnote += 1
                elif norm(q) and norm(q) in norm(ent):
                    n_ok += 1
        faith_ok += n_ok
        faith_total += n_tot
        rate = f"{n_ok}/{n_tot}" if n_tot else "—"
        print(f"{note_id[:34]:<34} {len(populated_leaf):>5} {len(deriv):>6} {len(with_ev):>5} {rate:>7}")

    print("-" * 62)
    print(f"\nanswers: {pos_total} positive/substantive, {neg_total} negative-or-absent (0/none/never)")
    print(f"positive answers WITHOUT any evidence citation: {pos_no_ev}/{pos_total}"
          + ("  ← all positives cited" if pos_no_ev == 0 else "  ← unsupported positives to check"))
    print(f"\nfaithfulness (evidence quote present in note): {faith_ok}/{faith_total}"
          + (f"  ({100*faith_ok//faith_total}%)" if faith_total else "")
          + (f"  [{faith_missingnote} skipped: note file absent]" if faith_missingnote else ""))
    print(f"\ndistinct ACTS leaf fields ever populated ({len(cov_fields)}/23 leaf):")
    print("  " + ", ".join(sorted(cov_fields)))
    never = sorted({"impaired_cognition","apoe_genotype","postmenopause","lmp_date","cdr_global",
                    "gds_stage","moca_score","mmse_score","hachinski_score","mattis_drs","tics_score",
                    "gds_depression_score","cornell_csdd","npi_total","education_years","smoking_status",
                    "pack_year","pack_per_day","smoking_duration","quit_time","allergen","vaccine_name",
                    "vaccine_category"} - cov_fields)
    if never:
        print(f"\nleaf fields never populated (not documented in these notes): {', '.join(never)}")


if __name__ == "__main__":
    main()
