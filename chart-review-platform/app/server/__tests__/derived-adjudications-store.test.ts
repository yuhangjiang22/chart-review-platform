import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  writeDerivedAdjudication,
  listDerivedAdjudications,
  findDerivedAdjudicationsForPatient,
} from "../derived-adjudications/store.js";
import type { DerivedAdjudication } from "../derived-adjudications/schema.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "der-adj-"));

const rec = (overrides: Partial<DerivedAdjudication> = {}): DerivedAdjudication => ({
  patient_id: "p1",
  field_id: "C1",
  iter_id: "iter-1",
  agent_1: {
    answer_match_human: true,
    evidence_overlap_jaccard: 1,
    notes_read_jaccard: 1,
    human_evidence_seen_by_agent: true,
    classification: "correct",
    rationale_short: "match",
  },
  agent_2: {
    answer_match_human: true,
    evidence_overlap_jaccard: 1,
    notes_read_jaccard: 1,
    human_evidence_seen_by_agent: true,
    classification: "correct",
    rationale_short: "match",
  },
  pair: { classification: "both_correct" },
  gap_signal: { candidate: false, reason: "n/a", suggested_revision: null },
  trajectory_features: {
    notes_unique_to_agent_1: [],
    notes_unique_to_agent_2: [],
    notes_only_human_cited: [],
  },
  reviewer_comment: null,
  classifier: {
    model: "claude-haiku-4-5",
    ts: new Date().toISOString(),
    cost_usd: 0,
  },
  ...overrides,
});

describe("derived-adjudications store", () => {
  it("writes and lists a single record", () => {
    const dir = tmp();
    writeDerivedAdjudication(dir, rec());
    const all = listDerivedAdjudications(dir);
    expect(all).toHaveLength(1);
    expect(all[0].field_id).toBe("C1");
  });

  it("replaces existing record for same (patient, field)", () => {
    const dir = tmp();
    writeDerivedAdjudication(dir, rec({ pair: { classification: "both_correct" } }));
    writeDerivedAdjudication(dir, rec({ pair: { classification: "one_wrong" } }));
    const all = listDerivedAdjudications(dir);
    expect(all).toHaveLength(1);
    expect(all[0].pair.classification).toBe("one_wrong");
  });

  it("findDerivedAdjudicationsForPatient filters by patient_id", () => {
    const dir = tmp();
    writeDerivedAdjudication(dir, rec({ patient_id: "p1", field_id: "C1" }));
    writeDerivedAdjudication(dir, rec({ patient_id: "p1", field_id: "C2" }));
    writeDerivedAdjudication(dir, rec({ patient_id: "p2", field_id: "C1" }));
    expect(findDerivedAdjudicationsForPatient(dir, "p1")).toHaveLength(2);
    expect(findDerivedAdjudicationsForPatient(dir, "p2")).toHaveLength(1);
  });
});
