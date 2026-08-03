import { describe, it, expect } from "vitest";
import { evalDerivation, type MinimalTask } from "./index.js";

// Derivations shipped on the item_*.md criteria — kept in sync with the rubric.
// Each RUCAM item score is COMPUTED from extracted sub-facts (see the criteria
// files); the agent answers the sub-facts, the engine computes the item score.

const ITEM1 =
  'onset_path == "not_calculable" ? 0 : onset_path == "initial_treatment" ? ((onset_latency_days >= 5 AND onset_latency_days <= 90) ? 2 : 1) : onset_path == "re_exposure" ? (injury_track == "hepatocellular" ? ((onset_latency_days >= 1 AND onset_latency_days <= 15) ? 2 : 1) : ((onset_latency_days >= 1 AND onset_latency_days <= 90) ? 2 : 1)) : (injury_track == "hepatocellular" ? (onset_latency_days <= 15 ? 1 : 0) : (onset_latency_days <= 30 ? 1 : 0))';

const ITEM2 =
  '(dechallenge_outcome == "not_stopped" OR dechallenge_outcome == "no_followup") ? 0 : injury_track == "hepatocellular" ? (dechallenge_outcome == "ge50_le8d" ? 3 : dechallenge_outcome == "ge50_le30d" ? 2 : dechallenge_outcome == "ge50_le180d" ? 0 : -2) : ((dechallenge_outcome == "ge50_le8d" OR dechallenge_outcome == "ge50_le30d" OR dechallenge_outcome == "ge50_le180d") ? 2 : dechallenge_outcome == "lt50_with_data" ? 1 : 0)';

const ITEM4 =
  'concomitant_attribution == "yes" ? -3 : (concomitant_worst_timing == "suggestive" AND concomitant_worst_hepatotoxic == "yes") ? -2 : (concomitant_worst_timing == "suggestive" OR concomitant_worst_timing == "compatible") ? -1 : 0';

const ITEM5 =
  'alt_cause_explains == "yes" ? -3 : (n_group1_ruled_out >= 6 AND group2_all_ruled_out == "yes") ? 2 : n_group1_ruled_out >= 6 ? 1 : n_group1_ruled_out >= 4 ? 0 : -2';

const ITEM6 =
  'hepatotoxicity_class == "labeled" ? 2 : hepatotoxicity_class == "probable" ? 1 : 0';

const ITEM7 =
  'rechallenge_result == "positive_alone" ? 3 : rechallenge_result == "positive_with_codrug" ? 1 : rechallenge_result == "below_uln" ? -2 : 0';

const TASK: MinimalTask = {
  fields: [
    // shared sub-fact
    { id: "injury_track" },
    // item 1 sub-facts
    { id: "onset_path" },
    { id: "onset_latency_days" },
    { id: "item_1_time_to_onset", derivation: ITEM1 },
    // item 2 sub-facts
    { id: "dechallenge_outcome" },
    { id: "item_2_course", derivation: ITEM2 },
    // item 4 sub-facts
    { id: "concomitant_worst_timing" },
    { id: "concomitant_worst_hepatotoxic" },
    { id: "concomitant_attribution" },
    { id: "item_4_concomitant", derivation: ITEM4 },
    // item 5 sub-facts
    { id: "n_group1_ruled_out" },
    { id: "group2_all_ruled_out" },
    { id: "alt_cause_explains" },
    { id: "item_5_exclusion", derivation: ITEM5 },
    // item 6 sub-fact
    { id: "hepatotoxicity_class" },
    { id: "item_6_hepatotoxicity", derivation: ITEM6 },
    // item 7 sub-fact
    { id: "rechallenge_result" },
    { id: "item_7_rechallenge", derivation: ITEM7 },
  ],
};

const score = (field: string, a: Record<string, unknown>) =>
  evalDerivation(TASK, a, field);

describe("RUCAM item 1 (time to onset) derived", () => {
  const s = (a: Record<string, unknown>) => score("item_1_time_to_onset", a);
  it("not_calculable → 0 (sub-facts still present)", () => {
    expect(s({ onset_path: "not_calculable", onset_latency_days: 0, injury_track: "hepatocellular" })).toBe(0);
  });
  it("initial_treatment 5–90d → 2, outside → 1", () => {
    expect(s({ onset_path: "initial_treatment", onset_latency_days: 30, injury_track: "hepatocellular" })).toBe(2);
    expect(s({ onset_path: "initial_treatment", onset_latency_days: 3, injury_track: "hepatocellular" })).toBe(1);
    expect(s({ onset_path: "initial_treatment", onset_latency_days: 120, injury_track: "mixed" })).toBe(1);
  });
  it("re_exposure hepatocellular 1–15d → 2, else 1", () => {
    expect(s({ onset_path: "re_exposure", onset_latency_days: 10, injury_track: "hepatocellular" })).toBe(2);
    expect(s({ onset_path: "re_exposure", onset_latency_days: 20, injury_track: "hepatocellular" })).toBe(1);
  });
  it("re_exposure cholestatic/mixed 1–90d → 2, else 1", () => {
    expect(s({ onset_path: "re_exposure", onset_latency_days: 60, injury_track: "cholestatic" })).toBe(2);
    expect(s({ onset_path: "re_exposure", onset_latency_days: 100, injury_track: "cholestatic" })).toBe(1);
  });
  it("from_cessation hepatocellular ≤15d → 1, else 0", () => {
    expect(s({ onset_path: "from_cessation", onset_latency_days: 10, injury_track: "hepatocellular" })).toBe(1);
    expect(s({ onset_path: "from_cessation", onset_latency_days: 20, injury_track: "hepatocellular" })).toBe(0);
  });
  it("from_cessation cholestatic/mixed ≤30d → 1, else 0", () => {
    expect(s({ onset_path: "from_cessation", onset_latency_days: 25, injury_track: "mixed" })).toBe(1);
    expect(s({ onset_path: "from_cessation", onset_latency_days: 40, injury_track: "mixed" })).toBe(0);
  });
  it("Pending when a sub-fact is missing", () => {
    expect(s({ onset_path: "initial_treatment", injury_track: "hepatocellular" })).toBeNull();
    expect(s({ onset_latency_days: 30, injury_track: "hepatocellular" })).toBeNull();
  });
});

describe("RUCAM item 2 (course after cessation) derived", () => {
  const s = (a: Record<string, unknown>) => score("item_2_course", a);
  it("not stopped / no follow-up → 0", () => {
    expect(s({ dechallenge_outcome: "not_stopped", injury_track: "hepatocellular" })).toBe(0);
    expect(s({ dechallenge_outcome: "no_followup", injury_track: "cholestatic" })).toBe(0);
  });
  it("hepatocellular: 8d→3, 30d→2, 180d→0, <50%/rise→-2", () => {
    expect(s({ dechallenge_outcome: "ge50_le8d", injury_track: "hepatocellular" })).toBe(3);
    expect(s({ dechallenge_outcome: "ge50_le30d", injury_track: "hepatocellular" })).toBe(2);
    expect(s({ dechallenge_outcome: "ge50_le180d", injury_track: "hepatocellular" })).toBe(0);
    expect(s({ dechallenge_outcome: "lt50_with_data", injury_track: "hepatocellular" })).toBe(-2);
    expect(s({ dechallenge_outcome: "increase", injury_track: "hepatocellular" })).toBe(-2);
  });
  it("cholestatic/mixed: any ≥50% fall→2, <50%→1, rise→0", () => {
    expect(s({ dechallenge_outcome: "ge50_le8d", injury_track: "cholestatic" })).toBe(2);
    expect(s({ dechallenge_outcome: "ge50_le180d", injury_track: "mixed" })).toBe(2);
    expect(s({ dechallenge_outcome: "lt50_with_data", injury_track: "cholestatic" })).toBe(1);
    expect(s({ dechallenge_outcome: "increase", injury_track: "mixed" })).toBe(0);
  });
  it("Pending when a sub-fact is missing", () => {
    expect(s({ injury_track: "hepatocellular" })).toBeNull();
    expect(s({ dechallenge_outcome: "ge50_le8d" })).toBeNull();
  });
});

describe("RUCAM item 4 (concomitant drugs) derived", () => {
  const s = (a: Record<string, unknown>) => score("item_4_concomitant", a);
  const base = { concomitant_worst_hepatotoxic: "no", concomitant_attribution: "no" };
  it("attribution to a co-drug → -3 (overrides)", () => {
    expect(s({ concomitant_worst_timing: "suggestive", concomitant_worst_hepatotoxic: "yes", concomitant_attribution: "yes" })).toBe(-3);
  });
  it("suggestive + known hepatotoxin → -2", () => {
    expect(s({ concomitant_worst_timing: "suggestive", concomitant_worst_hepatotoxic: "yes", concomitant_attribution: "no" })).toBe(-2);
  });
  it("suggestive (not hepatotoxic) or compatible → -1", () => {
    expect(s({ ...base, concomitant_worst_timing: "suggestive" })).toBe(-1);
    expect(s({ ...base, concomitant_worst_timing: "compatible" })).toBe(-1);
  });
  it("incompatible or none → 0", () => {
    expect(s({ ...base, concomitant_worst_timing: "incompatible" })).toBe(0);
    expect(s({ ...base, concomitant_worst_timing: "none" })).toBe(0);
  });
  it("Pending when a sub-fact is missing", () => {
    expect(s({ concomitant_worst_timing: "suggestive", concomitant_attribution: "no" })).toBeNull();
  });
});

describe("RUCAM item 5 (exclusion of other causes) derived", () => {
  const s = (a: Record<string, unknown>) => score("item_5_exclusion", a);
  it("clear alternative cause → -3 (overrides count)", () => {
    expect(s({ n_group1_ruled_out: 6, group2_all_ruled_out: "yes", alt_cause_explains: "yes" })).toBe(-3);
  });
  it("all Group I + all Group II → 2", () => {
    expect(s({ n_group1_ruled_out: 6, group2_all_ruled_out: "yes", alt_cause_explains: "no" })).toBe(2);
  });
  it("all Group I only → 1", () => {
    expect(s({ n_group1_ruled_out: 6, group2_all_ruled_out: "no", alt_cause_explains: "no" })).toBe(1);
  });
  it("4–5 Group I → 0", () => {
    expect(s({ n_group1_ruled_out: 5, group2_all_ruled_out: "no", alt_cause_explains: "no" })).toBe(0);
    expect(s({ n_group1_ruled_out: 4, group2_all_ruled_out: "no", alt_cause_explains: "no" })).toBe(0);
  });
  it("fewer than 4 → -2", () => {
    expect(s({ n_group1_ruled_out: 3, group2_all_ruled_out: "no", alt_cause_explains: "no" })).toBe(-2);
    expect(s({ n_group1_ruled_out: 0, group2_all_ruled_out: "no", alt_cause_explains: "no" })).toBe(-2);
  });
  it("Pending when a sub-fact is missing", () => {
    expect(s({ group2_all_ruled_out: "yes", alt_cause_explains: "no" })).toBeNull();
  });
});

describe("RUCAM item 6 (prior hepatotoxicity) derived", () => {
  const s = (a: Record<string, unknown>) => score("item_6_hepatotoxicity", a);
  it("labeled→2, probable→1, none→0", () => {
    expect(s({ hepatotoxicity_class: "labeled" })).toBe(2);
    expect(s({ hepatotoxicity_class: "probable" })).toBe(1);
    expect(s({ hepatotoxicity_class: "none" })).toBe(0);
  });
  it("Pending when the class is missing", () => {
    expect(s({})).toBeNull();
  });
});

describe("RUCAM item 7 (rechallenge) derived", () => {
  const s = (a: Record<string, unknown>) => score("item_7_rechallenge", a);
  it("positive_alone→3, positive_with_codrug→1, below_uln→-2, none→0", () => {
    expect(s({ rechallenge_result: "positive_alone" })).toBe(3);
    expect(s({ rechallenge_result: "positive_with_codrug" })).toBe(1);
    expect(s({ rechallenge_result: "below_uln" })).toBe(-2);
    expect(s({ rechallenge_result: "none_or_insufficient" })).toBe(0);
  });
  it("Pending when the result is missing", () => {
    expect(s({})).toBeNull();
  });
});

// End-to-end: the whole RUCAM tree is now two-level — sub-facts feed the seven
// derived item scores, which feed total_score, which feeds the causality band.
// The engine recurses through both levels; a single missing sub-fact must
// cascade all the way to a Pending category (never a fabricated total).
const ITEM3 =
  '(((rf_alcohol == "yes") OR (injury_track != "hepatocellular" AND rf_pregnancy == "yes")) ? 1 : 0) + ((rf_age_ge_55 == "yes") ? 1 : 0)';
const TOTAL =
  "item_1_time_to_onset + item_2_course + item_3_risk_factors + item_4_concomitant + item_5_exclusion + item_6_hepatotoxicity + item_7_rechallenge";
const CATEGORY = `(${TOTAL}) >= 9 ? "highly_probable" : (${TOTAL}) >= 6 ? "probable" : (${TOTAL}) >= 3 ? "possible" : (${TOTAL}) >= 1 ? "unlikely" : "excluded"`;

const FULL_TASK: MinimalTask = {
  fields: [
    ...TASK.fields,
    { id: "rf_alcohol" },
    { id: "rf_pregnancy" },
    { id: "rf_age_ge_55" },
    { id: "item_3_risk_factors", derivation: ITEM3 },
    { id: "rucam_total_score", derivation: TOTAL },
    { id: "rucam_causality_category", derivation: CATEGORY },
  ],
};

describe("RUCAM full chain: sub-facts → items → total → category", () => {
  // A worked case scoring 2+3+1+0+2+2+0 = 10 → highly_probable.
  const subfacts = {
    injury_track: "hepatocellular",
    onset_path: "initial_treatment",
    onset_latency_days: 30, // item_1 = 2
    dechallenge_outcome: "ge50_le8d", // item_2 = 3
    rf_alcohol: "no",
    rf_pregnancy: "no",
    rf_age_ge_55: "yes", // item_3 = 1
    concomitant_worst_timing: "none",
    concomitant_worst_hepatotoxic: "no",
    concomitant_attribution: "no", // item_4 = 0
    n_group1_ruled_out: 6,
    group2_all_ruled_out: "yes",
    alt_cause_explains: "no", // item_5 = 2
    hepatotoxicity_class: "labeled", // item_6 = 2
    rechallenge_result: "none_or_insufficient", // item_7 = 0
  };

  it("total_score composes through the derived items", () => {
    expect(evalDerivation(FULL_TASK, subfacts, "rucam_total_score")).toBe(10);
  });

  it("causality_category maps the composed total", () => {
    expect(evalDerivation(FULL_TASK, subfacts, "rucam_causality_category")).toBe("highly_probable");
  });

  it("one missing sub-fact cascades to a Pending category — never a fabricated total", () => {
    const { hepatotoxicity_class: _drop, ...missing } = subfacts;
    expect(evalDerivation(FULL_TASK, missing, "item_6_hepatotoxicity")).toBeNull();
    expect(evalDerivation(FULL_TASK, missing, "rucam_total_score")).toBeNull();
    expect(evalDerivation(FULL_TASK, missing, "rucam_causality_category")).toBeNull();
  });
});
