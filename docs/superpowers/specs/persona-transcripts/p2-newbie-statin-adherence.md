# P2 — newbie — statin adherence

**Persona:** Junior researcher, first chart-review project. Has clinical training but no experience with phenotyping or rubric design. Doesn't know terms like "output shape," "index date," "atomic criterion," "derivation." Asks "what does that mean?" frequently. Trusts the agent's recommendation but needs each step explained.

**Study goal:** "I want to know if patients with high cholesterol are taking their statin."

---

## Transcript

**P2 (turn 1):** I want to study if patients with high cholesterol are taking their statin. Where do I start?

**Agent (turn 2):** Good question — let me walk you through it. Chart review needs us to lock down a few things before we can draft criteria. The first decision is the **output shape**: what's the single answer we want for each patient at the end? Three common shapes for your problem:

1. **Outcome-first** — one labeled answer per patient (e.g. `adherent` / `partial` / `non_adherent`). Cleanest if your downstream goal is to say "X% of patients are adherent."
2. **Evidence-first** — separate fields like `was_a_statin_prescribed`, `proportion_of_days_covered`, etc., with the adherence label *derived* from those numbers.
3. **Hybrid** — a label PLUS 1–2 supporting evidence fields.

Recommendation: **outcome-first** for your goal — the headline result is just whether each patient is adherent. The supporting data (days covered, prescription dates) becomes evidence under the label. Want to go with that, or push back?

**P2 (turn 3):** Wait — what's "evidence" here? Like the actual chart text?

**Agent (turn 4):** Yes — when we say "evidence," we mean a verbatim quote from the chart (e.g. "patient on atorvastatin 40mg daily") plus the note ID and character offsets, so a future reviewer can verify the answer was supported by what's actually written. Every answer the agent gives gets a chunk of evidence attached. The "outcome-first" vs "evidence-first" distinction is about the *shape of the answer schema*, not whether evidence is captured — evidence is captured either way.

OK with outcome-first?

**P2 (turn 5):** Yes. What's an "index date"?

**Agent (turn 6):** The index date is the reference time-zero for the review. For "is this patient adherent to their statin?" we need to fix a moment in the patient's record and ask "as of this date, what's their adherence picture?" Common choices for a medication-adherence study:

1. The most recent encounter (use today's view)
2. The date the statin was first prescribed
3. A random date in the year (for cohort sampling)

For your study, I'd recommend **the most recent encounter date** — it answers "right now, are they adherent?" Want me to use that?

**P2 (turn 7):** OK. So now what?

**Agent (turn 8):** Now criteria. We need to break "is the patient adherent to their statin?" into atomic pieces — each piece a single question with a single answer. For statin adherence the canonical decomposition is:

1. **`statin_active_at_index`** — yes/no — is there a statin prescription currently active?
2. **`proportion_days_covered_180d`** — a number 0.0 to 1.0 — fraction of the past 180 days the patient had statin in their hand. (This is "PDC," a standard pharmacy-adherence measure.)
3. **`adherence_label`** — a final rolled-up answer (`adherent` / `partial` / `non_adherent` / `not_applicable`) computed from the two above.

We also need an **eligibility filter**: the population is "patients with a high-cholesterol diagnosis." Some patients won't have a statin prescription — that's `not_applicable`, not `non_adherent`, because there was nothing to be adherent to.

3 criteria total. Sound about right?

**P2 (turn 9):** What's "PDC"? And is 180 days enough?

**Agent (turn 10):** PDC = Proportion of Days Covered. It's a number from 0 to 1: if a patient was prescribed 180 days of statin in a 180-day window and they refilled enough of it that they had pills available on (say) 144 of those days, PDC = 144/180 = 0.80. The pharmacy industry threshold for "adherent" is PDC ≥ 0.80.

180 days is the standard window CMS uses for the Medicare adherence quality measure. You could go shorter (90 days) for more recent behavior or longer (365 days) for chronic averages — 180 is the conventional default. OK?

**P2 (turn 11):** OK. What's "not_applicable" again?

**Agent (turn 12):** It's the value the rubric returns when the question doesn't apply to this patient. For statin adherence: if a patient was never prescribed a statin, it's wrong to call them "non_adherent" (that implies they failed to take a prescription they had) — they're `not_applicable` (the question of adherence doesn't apply because there's nothing to adhere to). The agent's reviewer skills need a way to mark "this patient is filtered out, don't penalize." That's `not_applicable`.

**P2 (turn 13):** Got it. Make it.

**Agent (turn 14):** One more thing — Phase 4.6 in our process asks: which criteria need a time window?

- `statin_active_at_index` — point-in-time check at the index date — NO window
- `proportion_days_covered_180d` — explicitly looks at 180 days — needs `lookback_180d` window
- `adherence_label` — derived — NO window

Drafting now. v0 is small (3 criteria, well under our 1-5 cap for phenotype rubrics). After this, you'll TRY it on patients and see if the answers make sense, then we'll iterate.

---

## Where the persona would derail without scaffolding

- **Turn 3 ("what's evidence?"):** Without an explanation, the user might assume "outcome-first" means we don't capture evidence at all — and skip past the most important auditability feature.
- **Turn 5 ("what's an index date?"):** A minor question, but if the agent had used the term opaquely, the user would have confidently picked something nonsensical.
- **Turn 9-10 ("what's PDC?"):** If the agent had used the acronym without unpacking, the user would have nodded along and discovered later that they didn't actually understand their own rubric.
- **Turn 11 ("what's not_applicable again?"):** Asked already in turn 8 — newbie users circle back. Patient re-explanation is the right behavior.

## Critical: the agent never glossed over

In every turn where P2 said "what does that mean?" the agent unpacked the concept in plain terms before continuing. A skill that ignored "what?" prompts and pushed forward would have produced a draft P2 didn't actually own.
