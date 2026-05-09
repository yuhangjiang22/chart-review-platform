// app/server/__tests__/deployment-issues.test.ts
//
// Tests for the deployment-issues append-only queue (blueprint §5).
//
// Covers:
//  - appendIssue persists a JSONL line with server-generated issue_id and reported_at
//  - listIssues returns issues in append order
//  - listIssues returns empty array when no log file exists
//  - guideline_sha validation rejects path-traversal and non-hex input
//  - Required-field validation rejects malformed drafts
//  - Multiple appends to the same sha produce a single concatenated log
//  - Issues for different shas are isolated to their own files
//  - listIssues skips lines that fail JSON parse without breaking the read

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  appendIssue,
  appendPromotion,
  appendTriageUpdate,
  listIssues,
  deploymentIssuesPath,
  deploymentIssuesRoot,
} from "../domain/issue/index.js";

let TMP: string;

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "di-test-"));
  process.env.CHART_REVIEW_PLATFORM_ROOT = TMP;
});

afterEach(() => {
  delete process.env.CHART_REVIEW_PLATFORM_ROOT;
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe("appendIssue", () => {
  it("persists an issue and returns it with issue_id + reported_at", () => {
    const issue = appendIssue({
      guideline_sha: "abc123def456",
      patient_id: "p_001",
      reporter_id: "alice",
      description: "agent missed the pathology report",
    });

    expect(issue.issue_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(issue.guideline_sha).toBe("abc123def456");
    expect(issue.patient_id).toBe("p_001");
    expect(issue.reporter_id).toBe("alice");
    expect(issue.description).toBe("agent missed the pathology report");
    expect(issue.reported_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("writes the issue as a JSON line to the per-sha file", () => {
    const issue = appendIssue({
      guideline_sha: "abc123",
      patient_id: "p_001",
      reporter_id: "alice",
      description: "missing evidence",
    });

    const filePath = deploymentIssuesPath("abc123");
    const text = fs.readFileSync(filePath, "utf8");
    const lines = text.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({ kind: "issue", ...issue });
  });

  it("preserves field_id and suggested_correction when present", () => {
    const issue = appendIssue({
      guideline_sha: "abc123",
      patient_id: "p_001",
      field_id: "imaging_lung_lesion",
      reporter_id: "alice",
      description: "looks like a family-history misread",
      suggested_correction: "false",
    });

    expect(issue.field_id).toBe("imaging_lung_lesion");
    expect(issue.suggested_correction).toBe("false");
  });

  it("appends multiple issues to the same sha as separate lines", () => {
    appendIssue({ guideline_sha: "abc123", patient_id: "p_001", reporter_id: "alice", description: "first" });
    appendIssue({ guideline_sha: "abc123", patient_id: "p_002", reporter_id: "bob", description: "second" });
    appendIssue({ guideline_sha: "abc123", patient_id: "p_003", reporter_id: "alice", description: "third" });

    const text = fs.readFileSync(deploymentIssuesPath("abc123"), "utf8");
    const lines = text.split("\n").filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]).description).toBe("first");
    expect(JSON.parse(lines[1]).description).toBe("second");
    expect(JSON.parse(lines[2]).description).toBe("third");
  });

  it("isolates issues for different guideline shas to separate files", () => {
    appendIssue({ guideline_sha: "abc123", patient_id: "p_001", reporter_id: "alice", description: "for sha A" });
    appendIssue({ guideline_sha: "deadbeef", patient_id: "p_002", reporter_id: "bob", description: "for sha B" });

    expect(fs.existsSync(deploymentIssuesPath("abc123"))).toBe(true);
    expect(fs.existsSync(deploymentIssuesPath("deadbeef"))).toBe(true);

    const a = listIssues("abc123");
    const b = listIssues("deadbeef");
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].description).toBe("for sha A");
    expect(b[0].description).toBe("for sha B");
  });

  it("rejects drafts missing required fields", () => {
    expect(() =>
      appendIssue({ guideline_sha: "abc123", patient_id: "", reporter_id: "alice", description: "x" }),
    ).toThrow(/required/);
    expect(() =>
      appendIssue({ guideline_sha: "abc123", patient_id: "p_001", reporter_id: "", description: "x" }),
    ).toThrow(/required/);
    expect(() =>
      appendIssue({ guideline_sha: "abc123", patient_id: "p_001", reporter_id: "alice", description: "" }),
    ).toThrow(/required/);
    expect(() =>
      appendIssue({ guideline_sha: "", patient_id: "p_001", reporter_id: "alice", description: "x" }),
    ).toThrow(/required/);
  });
});

describe("guideline_sha validation", () => {
  it("rejects path-traversal attempts via deploymentIssuesPath", () => {
    expect(() => deploymentIssuesPath("../../etc/passwd")).toThrow(/invalid guideline_sha/);
    expect(() => deploymentIssuesPath("..")).toThrow(/invalid guideline_sha/);
    expect(() => deploymentIssuesPath("foo/bar")).toThrow(/invalid guideline_sha/);
  });

  it("rejects non-hex characters and absurdly long strings", () => {
    expect(() => deploymentIssuesPath("not-hex-zzz")).toThrow(/invalid guideline_sha/);
    expect(() => deploymentIssuesPath("")).toThrow(/invalid guideline_sha/);
    expect(() => deploymentIssuesPath("a".repeat(65))).toThrow(/invalid guideline_sha/);
  });

  it("accepts hex-only strings of reasonable length (uppercase OK)", () => {
    expect(() => deploymentIssuesPath("abc123")).not.toThrow();
    expect(() => deploymentIssuesPath("DEADBEEF")).not.toThrow();
    expect(() => deploymentIssuesPath("a".repeat(64))).not.toThrow();
  });
});

describe("listIssues", () => {
  it("returns an empty array when no log file exists for the sha", () => {
    expect(listIssues("abc123")).toEqual([]);
  });

  it("returns issues in append order", () => {
    const a = appendIssue({ guideline_sha: "abc123", patient_id: "p_001", reporter_id: "alice", description: "first" });
    const b = appendIssue({ guideline_sha: "abc123", patient_id: "p_002", reporter_id: "bob", description: "second" });

    const issues = listIssues("abc123");
    expect(issues).toHaveLength(2);
    expect(issues[0].issue_id).toBe(a.issue_id);
    expect(issues[1].issue_id).toBe(b.issue_id);
  });

  it("skips lines that fail to parse without breaking the read", () => {
    appendIssue({ guideline_sha: "abc123", patient_id: "p_001", reporter_id: "alice", description: "valid" });
    // Hand-corrupt the log: append a garbage line + another valid one.
    const filePath = deploymentIssuesPath("abc123");
    fs.appendFileSync(filePath, "not-json-at-all\n");
    appendIssue({ guideline_sha: "abc123", patient_id: "p_002", reporter_id: "bob", description: "also valid" });

    const issues = listIssues("abc123");
    expect(issues).toHaveLength(2);
    expect(issues[0].description).toBe("valid");
    expect(issues[1].description).toBe("also valid");
  });
});

describe("deploymentIssuesRoot", () => {
  it("resolves relative to CHART_REVIEW_PLATFORM_ROOT when the env var is set", () => {
    expect(deploymentIssuesRoot()).toBe(path.join(TMP, "deployment-issues"));
  });
});

// ---------------------------------------------------------------------------
// Triage updates: roll up the latest triage state onto each issue
// ---------------------------------------------------------------------------

describe("appendTriageUpdate", () => {
  it("attaches the latest triage state to the issue when listed", () => {
    const issue = appendIssue({
      guideline_sha: "abc123",
      patient_id: "p_001",
      reporter_id: "alice",
      description: "agent missed pathology",
    });

    appendTriageUpdate("abc123", issue.issue_id, {
      category: "agent_error",
      triaged_by: "methodologist_1",
      note: "agent skipped the path report section",
      corrected_answer: "true",
    });

    const issues = listIssues("abc123");
    expect(issues).toHaveLength(1);
    const t = issues[0].triage;
    expect(t).toBeDefined();
    expect(t!.category).toBe("agent_error");
    expect(t!.triaged_by).toBe("methodologist_1");
    expect(t!.note).toBe("agent skipped the path report section");
    expect(t!.corrected_answer).toBe("true");
    expect(t!.triaged_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("keeps only the most recent triage when multiple updates target the same issue", () => {
    const issue = appendIssue({
      guideline_sha: "abc123",
      patient_id: "p_001",
      reporter_id: "alice",
      description: "x",
    });

    appendTriageUpdate("abc123", issue.issue_id, { category: "data_issue", triaged_by: "m1" });
    appendTriageUpdate("abc123", issue.issue_id, { category: "guideline_gap", triaged_by: "m2", note: "rule unclear" });
    appendTriageUpdate("abc123", issue.issue_id, { category: "dismiss", triaged_by: "m3" });

    const [rolled] = listIssues("abc123");
    expect(rolled.triage!.category).toBe("dismiss");
    expect(rolled.triage!.triaged_by).toBe("m3");
  });

  it("rolls up triage independently per issue_id", () => {
    const a = appendIssue({ guideline_sha: "abc123", patient_id: "p_001", reporter_id: "alice", description: "a" });
    const b = appendIssue({ guideline_sha: "abc123", patient_id: "p_002", reporter_id: "bob", description: "b" });

    appendTriageUpdate("abc123", a.issue_id, { category: "agent_error", triaged_by: "m" });
    appendTriageUpdate("abc123", b.issue_id, { category: "dismiss", triaged_by: "m" });

    const issues = listIssues("abc123");
    const rolledA = issues.find((i) => i.issue_id === a.issue_id)!;
    const rolledB = issues.find((i) => i.issue_id === b.issue_id)!;
    expect(rolledA.triage!.category).toBe("agent_error");
    expect(rolledB.triage!.category).toBe("dismiss");
  });

  it("leaves untriaged issues without a triage field", () => {
    const a = appendIssue({ guideline_sha: "abc123", patient_id: "p_001", reporter_id: "alice", description: "a" });
    const b = appendIssue({ guideline_sha: "abc123", patient_id: "p_002", reporter_id: "bob", description: "b" });

    appendTriageUpdate("abc123", a.issue_id, { category: "dismiss", triaged_by: "m" });

    const issues = listIssues("abc123");
    expect(issues.find((i) => i.issue_id === a.issue_id)!.triage).toBeDefined();
    expect(issues.find((i) => i.issue_id === b.issue_id)!.triage).toBeUndefined();
  });

  it("rejects an unknown issue_id", () => {
    appendIssue({ guideline_sha: "abc123", patient_id: "p_001", reporter_id: "alice", description: "real" });
    expect(() =>
      appendTriageUpdate("abc123", "not-a-real-uuid", { category: "dismiss", triaged_by: "m" }),
    ).toThrow(/not found/);
  });

  it("rejects an invalid category", () => {
    const issue = appendIssue({ guideline_sha: "abc123", patient_id: "p_001", reporter_id: "alice", description: "x" });
    expect(() =>
      // @ts-expect-error testing runtime validation
      appendTriageUpdate("abc123", issue.issue_id, { category: "bogus", triaged_by: "m" }),
    ).toThrow(/invalid triage category/);
  });

  it("rejects a triage update with no triaged_by", () => {
    const issue = appendIssue({ guideline_sha: "abc123", patient_id: "p_001", reporter_id: "alice", description: "x" });
    expect(() =>
      appendTriageUpdate("abc123", issue.issue_id, { category: "dismiss", triaged_by: "" }),
    ).toThrow(/triaged_by is required/);
  });

  it("preserves the original filing order in listIssues regardless of triage interleaving", () => {
    const a = appendIssue({ guideline_sha: "abc123", patient_id: "p_001", reporter_id: "alice", description: "first" });
    const b = appendIssue({ guideline_sha: "abc123", patient_id: "p_002", reporter_id: "bob", description: "second" });
    appendTriageUpdate("abc123", a.issue_id, { category: "agent_error", triaged_by: "m" });
    appendTriageUpdate("abc123", b.issue_id, { category: "data_issue", triaged_by: "m" });

    const issues = listIssues("abc123");
    expect(issues[0].issue_id).toBe(a.issue_id);
    expect(issues[1].issue_id).toBe(b.issue_id);
  });

  it("skips entries without a recognized `kind` field (no pre-discriminator fallback)", () => {
    // Hand-write a pre-discriminator log entry — these are no longer supported.
    // The reader skips them rather than guessing they're issues.
    const filePath = deploymentIssuesPath("abc123");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const legacy = {
      issue_id: "legacy-uuid-1",
      guideline_sha: "abc123",
      patient_id: "p_legacy",
      reporter_id: "old_reviewer",
      reported_at: "2026-04-01T00:00:00.000Z",
      description: "filed before kind discriminator existed",
    };
    fs.writeFileSync(filePath, `${JSON.stringify(legacy)}\n`);

    const issues = listIssues("abc123");
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Promotions: latest promotion is rolled up onto each issue
// ---------------------------------------------------------------------------

describe("appendPromotion", () => {
  it("attaches the latest promotion state to the issue when listed", () => {
    const issue = appendIssue({
      guideline_sha: "abc123",
      patient_id: "p_001",
      reporter_id: "alice",
      description: "agent missed pathology",
    });
    appendTriageUpdate("abc123", issue.issue_id, { category: "agent_error", triaged_by: "m" });
    appendPromotion("abc123", issue.issue_id, { promoted_to_iter: "iter_004", promoted_by: "m" });

    const [rolled] = listIssues("abc123");
    expect(rolled.promoted).toBeDefined();
    expect(rolled.promoted!.promoted_to_iter).toBe("iter_004");
    expect(rolled.promoted!.promoted_by).toBe("m");
    expect(rolled.promoted!.promoted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Triage state stays intact alongside the promotion.
    expect(rolled.triage!.category).toBe("agent_error");
  });

  it("keeps only the most recent promotion when an issue is re-promoted", () => {
    const issue = appendIssue({
      guideline_sha: "abc123",
      patient_id: "p_001",
      reporter_id: "alice",
      description: "x",
    });
    appendTriageUpdate("abc123", issue.issue_id, { category: "guideline_gap", triaged_by: "m" });
    appendPromotion("abc123", issue.issue_id, { promoted_to_iter: "iter_002", promoted_by: "m" });
    appendPromotion("abc123", issue.issue_id, { promoted_to_iter: "iter_005", promoted_by: "m" });

    const [rolled] = listIssues("abc123");
    expect(rolled.promoted!.promoted_to_iter).toBe("iter_005");
  });

  it("rolls up promotions independently per issue_id", () => {
    const a = appendIssue({ guideline_sha: "abc123", patient_id: "p_001", reporter_id: "alice", description: "a" });
    const b = appendIssue({ guideline_sha: "abc123", patient_id: "p_002", reporter_id: "bob", description: "b" });
    appendTriageUpdate("abc123", a.issue_id, { category: "agent_error", triaged_by: "m" });
    appendTriageUpdate("abc123", b.issue_id, { category: "guideline_gap", triaged_by: "m" });
    appendPromotion("abc123", a.issue_id, { promoted_to_iter: "iter_002", promoted_by: "m" });

    const issues = listIssues("abc123");
    const rolledA = issues.find((i) => i.issue_id === a.issue_id)!;
    const rolledB = issues.find((i) => i.issue_id === b.issue_id)!;
    expect(rolledA.promoted!.promoted_to_iter).toBe("iter_002");
    expect(rolledB.promoted).toBeUndefined();
  });

  it("rejects an unknown issue_id", () => {
    appendIssue({ guideline_sha: "abc123", patient_id: "p_001", reporter_id: "alice", description: "x" });
    expect(() =>
      appendPromotion("abc123", "not-a-real-uuid", { promoted_to_iter: "iter_002", promoted_by: "m" }),
    ).toThrow(/not found/);
  });

  it("rejects missing promoted_by or promoted_to_iter", () => {
    const issue = appendIssue({ guideline_sha: "abc123", patient_id: "p_001", reporter_id: "alice", description: "x" });
    expect(() =>
      appendPromotion("abc123", issue.issue_id, { promoted_to_iter: "iter_002", promoted_by: "" }),
    ).toThrow(/promoted_by is required/);
    expect(() =>
      appendPromotion("abc123", issue.issue_id, { promoted_to_iter: "", promoted_by: "m" }),
    ).toThrow(/promoted_to_iter is required/);
  });
});
