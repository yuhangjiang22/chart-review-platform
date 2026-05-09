// app/server/__tests__/rule-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs"; import path from "path"; import os from "os";
import { writeProposal, readProposal, listProposals, transitionStatus, findSiblingsOnField, RuleProposal } from "../domain/proposal/index.js";

let TMP: string;
beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "rule-store-test-"));
  process.env.CHART_REVIEW_PROPOSALS_ROOT = path.join(TMP, "proposals");
});
afterEach(() => fs.rmSync(TMP, { recursive: true, force: true }));

const TID = "lung-cancer-phenotype";

function makeProposal(overrides: Partial<RuleProposal> = {}): RuleProposal {
  return {
    rule_id: "rule-2026-04-30-abc123",
    task_id: TID,
    field_id: "cytology_supports_lung_primary",
    status: "draft",
    created_at: "2026-04-30T13:45:00Z",
    created_by: "alice",
    nl_rule: "test rule",
    proposed_edit: {
      field_id: "cytology_supports_lung_primary",
      edit_type: "is_applicable_when_replace",
      payload: "foo == 'no'",
      rationale: "test",
    },
    ...overrides,
  };
}

describe("writeProposal + readProposal", () => {
  it("roundtrips a proposal", () => {
    const p = makeProposal();
    writeProposal(p);
    const loaded = readProposal(TID, p.rule_id);
    expect(loaded?.rule_id).toBe(p.rule_id);
    expect(loaded?.proposed_edit?.payload).toBe("foo == 'no'");
  });

  it("returns null for missing proposal", () => {
    expect(readProposal(TID, "missing-rule")).toBe(null);
  });

  it("creates the proposals/<task_id>/ directory if absent", () => {
    const p = makeProposal();
    writeProposal(p);
    expect(fs.existsSync(path.join(TMP, "proposals", TID))).toBe(true);
  });
});

describe("listProposals", () => {
  it("returns all proposals for a task", () => {
    writeProposal(makeProposal({ rule_id: "r1" }));
    writeProposal(makeProposal({ rule_id: "r2", status: "applied" }));
    writeProposal(makeProposal({ rule_id: "r3", status: "rejected" }));
    const all = listProposals(TID);
    expect(all.map((p) => p.rule_id).sort()).toEqual(["r1", "r2", "r3"]);
  });

  it("filters by status when provided", () => {
    writeProposal(makeProposal({ rule_id: "r1", status: "draft" }));
    writeProposal(makeProposal({ rule_id: "r2", status: "pending_methodologist_review" }));
    writeProposal(makeProposal({ rule_id: "r3", status: "applied" }));
    const pending = listProposals(TID, { status: "pending_methodologist_review" });
    expect(pending.map((p) => p.rule_id)).toEqual(["r2"]);
  });

  it("returns empty array for unknown task", () => {
    expect(listProposals("nonexistent_task")).toEqual([]);
  });
});

describe("transitionStatus", () => {
  it("updates status and writes back to disk", () => {
    const p = makeProposal({ rule_id: "r1", status: "draft" });
    writeProposal(p);
    transitionStatus(TID, "r1", "pending_methodologist_review");
    const loaded = readProposal(TID, "r1");
    expect(loaded?.status).toBe("pending_methodologist_review");
  });

  it("throws on invalid transition (e.g., applied -> draft)", () => {
    const p = makeProposal({ rule_id: "r1", status: "applied" });
    writeProposal(p);
    expect(() => transitionStatus(TID, "r1", "draft")).toThrow(/invalid transition/i);
  });
});

describe("findSiblingsOnField", () => {
  it("returns pending proposals targeting the same field", () => {
    writeProposal(makeProposal({ rule_id: "r1", field_id: "f1", status: "pending_methodologist_review" }));
    writeProposal(makeProposal({ rule_id: "r2", field_id: "f1", status: "pending_methodologist_review" }));
    writeProposal(makeProposal({ rule_id: "r3", field_id: "f2", status: "pending_methodologist_review" }));
    const siblings = findSiblingsOnField(TID, "f1", "r1");
    expect(siblings.map((s) => s.rule_id)).toEqual(["r2"]);
  });

  it("excludes non-pending proposals from siblings", () => {
    writeProposal(makeProposal({ rule_id: "r1", field_id: "f1", status: "pending_methodologist_review" }));
    writeProposal(makeProposal({ rule_id: "r2", field_id: "f1", status: "applied" }));
    const siblings = findSiblingsOnField(TID, "f1", "r1");
    expect(siblings.length).toBe(0);
  });
});
