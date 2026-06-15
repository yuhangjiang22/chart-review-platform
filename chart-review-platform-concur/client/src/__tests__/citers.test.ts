import { describe, it, expect } from "vitest";
import {
  buildCiterEvidence,
  buildCitersByRowKey,
  buildCitersByNoteSpan,
  citerKey,
  citerLabel,
  type Citer,
} from "../citers";
import type { Evidence, FieldAssessment } from "../types";
import type { AgentFieldDraft } from "../ui/PatientReview";

const NOTE_EV_A: Evidence = {
  source: "note", note_id: "n1", span_offsets: [10, 20], verbatim_quote: "x",
};
const NOTE_EV_B: Evidence = {
  source: "note", note_id: "n1", span_offsets: [30, 40], verbatim_quote: "y",
};
const OMOP_EV_I10: Evidence = {
  source: "omop", table: "conditions", row_id: "510001", concept_name: "HTN", value: "I10",
};

const a1Draft: AgentFieldDraft = { agent_id: "agent_1", answer: "false", evidence: [NOTE_EV_A, OMOP_EV_I10] };
const a2Draft: AgentFieldDraft = { agent_id: "agent_2", answer: "no",    evidence: [OMOP_EV_I10] };
const committed: FieldAssessment = {
  field_id: "f", source: "reviewer", status: "approved",
  updated_at: "", updated_by: "alice",
  evidence: [NOTE_EV_B, OMOP_EV_I10],
};

describe("citers — buildCiterEvidence", () => {
  it("returns one entry per agent + one for the human (You always reads draftEvidence)", () => {
    // You's evidence comes from draftEvidence (the live editing state),
    // never from committed — see the comment in buildCiterEvidence for why.
    const out = buildCiterEvidence({
      drafts: [a1Draft, a2Draft],
      committed,           // ignored for "you"; present for shape-compat
      draftEvidence: [NOTE_EV_A], // live state — this is what shows
      derived: null,
    });
    expect(out).toHaveLength(3);
    expect(out[0].citer.kind).toBe("agent");
    expect(out[0].citer.kind === "agent" && out[0].citer.slot).toBe(1);
    expect(out[0].evidence).toEqual([NOTE_EV_A, OMOP_EV_I10]);
    expect(out[1].citer.kind === "agent" && out[1].citer.slot).toBe(2);
    expect(out[2].citer.kind).toBe("you");
    expect(out[2].evidence).toEqual([NOTE_EV_A]);
  });

  it("You shows draftEvidence when no committed exists too", () => {
    const out = buildCiterEvidence({
      drafts: [a1Draft], committed: null,
      draftEvidence: [NOTE_EV_A], derived: null,
    });
    const you = out.find((x) => x.citer.kind === "you")!;
    expect(you.evidence).toEqual([NOTE_EV_A]);
  });

  it("excludes derived entry when no derived assessment provided", () => {
    const out = buildCiterEvidence({
      drafts: [], committed, draftEvidence: [], derived: null,
    });
    expect(out.find((x) => x.citer.kind === "derived")).toBeUndefined();
  });
});

describe("citers — buildCitersByRowKey", () => {
  it("maps <table>:<row_id> → list of citers, deduped, in canonical order", () => {
    const map = buildCitersByRowKey([
      { citer: { kind: "agent", agent_id: "agent_1", slot: 1, label: "Agent 1" }, evidence: [OMOP_EV_I10] },
      { citer: { kind: "agent", agent_id: "agent_2", slot: 2, label: "Agent 2" }, evidence: [OMOP_EV_I10] },
      { citer: { kind: "you" }, evidence: [OMOP_EV_I10] },
    ]);
    const citers = map.get("conditions:510001")!;
    expect(citers.map((c) => c.kind)).toEqual(["agent", "agent", "you"]);
  });

  it("includes structured-source rows under the same key", () => {
    const struct: Evidence = {
      source: "structured", table: "drugs", row_id: 42, concept_name: "Aspirin",
    };
    const map = buildCitersByRowKey([
      { citer: { kind: "you" }, evidence: [struct] },
    ]);
    expect(map.get("drugs:42")?.map((c) => c.kind)).toEqual(["you"]);
  });
});

describe("citers — buildCitersByNoteSpan", () => {
  it("groups overlapping citations on the same offsets into one entry with multiple citers", () => {
    const map = buildCitersByNoteSpan(
      [
        { citer: { kind: "agent", agent_id: "agent_1", slot: 1, label: "Agent 1" }, evidence: [NOTE_EV_A] },
        { citer: { kind: "you" }, evidence: [NOTE_EV_A] },
      ],
      "n1",
    );
    const key = "10-20";
    expect(map.get(key)?.citers.length).toBe(2);
  });

  it("filters by active note_id (with and without .txt extension)", () => {
    const otherNote: Evidence = { ...NOTE_EV_A, note_id: "other" };
    const map = buildCitersByNoteSpan(
      [{ citer: { kind: "you" }, evidence: [otherNote] }],
      "n1",
    );
    expect(map.size).toBe(0);
  });
});

describe("citers — citerKey", () => {
  it("returns stable strings for matching", () => {
    const c: Citer = { kind: "agent", agent_id: "agent_1", slot: 1, label: "Agent 1" };
    expect(citerKey(c)).toBe("agent:agent_1");
    expect(citerKey({ kind: "you" })).toBe("you");
    expect(citerKey({ kind: "derived" })).toBe("derived");
  });
});

describe("citers — citerLabel", () => {
  it("returns user-facing names", () => {
    expect(citerLabel({ kind: "you" })).toBe("You");
    expect(citerLabel({ kind: "agent", agent_id: "x", slot: 1, label: "Agent 1" })).toBe("Agent 1");
    expect(citerLabel({ kind: "derived" })).toBe("Derived");
  });
});
