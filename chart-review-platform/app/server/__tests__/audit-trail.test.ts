/**
 * TDD tests for the 5 new AuditEntry step_types introduced in Phase B:
 * - accept_agent_draft
 * - bulk_accept
 * - record_validated
 * - blind_submit
 * - reviewer_session_summary
 *
 * REVIEWS_ROOT injection: audit-trail.ts reads the env var lazily (via
 * chatLogPath helper), so we can set process.env before calling
 * appendAuditEntry without needing vi.resetModules().
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { appendAuditEntry, readAuditEntries } from "../audit-trail.js";

let TMP: string;
beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "audit-test-"));
  process.env.CHART_REVIEW_REVIEWS_ROOT = TMP;
});

afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  delete process.env.CHART_REVIEW_REVIEWS_ROOT;
});

const C = { patientId: "p1", taskId: "t1", sessionId: "s1" };
const ts = "2026-04-29T12:00:00Z";

describe("new audit step_types", () => {
  it("accepts accept_agent_draft", () => {
    appendAuditEntry(C, {
      ts,
      session_id: "s1",
      step_type: "accept_agent_draft",
      field_id: "x",
      agent_answer_sha: "abc123",
      reviewer_id: "alice",
    });
    const es = readAuditEntries(C);
    expect(es[0].step_type).toBe("accept_agent_draft");
  });

  it("accepts bulk_accept", () => {
    appendAuditEntry(C, {
      ts,
      session_id: "s1",
      step_type: "bulk_accept",
      fields: ["x", "y"],
      count: 2,
      reviewer_id: "alice",
    });
    expect(readAuditEntries(C).pop()!.step_type).toBe("bulk_accept");
  });

  it("accepts record_validated", () => {
    appendAuditEntry(C, {
      ts,
      session_id: "s1",
      step_type: "record_validated",
      gate_results: {
        all_terminal: true,
        faithfulness_pass: true,
        alerts_dismissed: true,
        every_leaf_touched_or_bulk_accepted: true,
      },
      all_passed: true,
      reviewer_id: "alice",
    });
    expect(readAuditEntries(C).pop()!.step_type).toBe("record_validated");
  });

  it("accepts blind_submit", () => {
    appendAuditEntry(C, {
      ts,
      session_id: "s1",
      step_type: "blind_submit",
      field_id: "x",
      blind_answer_sha: "aaa",
      agent_answer_sha: "bbb",
      divergent: true,
      reviewer_id: "alice",
    });
    expect(readAuditEntries(C).pop()!.step_type).toBe("blind_submit");
  });

  it("accepts reviewer_session_summary", () => {
    appendAuditEntry(C, {
      ts,
      session_id: "s1",
      step_type: "reviewer_session_summary",
      notes_opened: 5,
      total_dwell_ms: 12000,
      searches_run: 2,
      ts_open: ts,
      ts_close: ts,
      reviewer_id: "alice",
    });
    expect(readAuditEntries(C).pop()!.step_type).toBe("reviewer_session_summary");
  });
});
