// iaa-events.test.ts — unit tests for the pure functions extracted out of
// the iaa-events CLI (Important 4, Task 7 re-review), plus a fixture-driven
// integration suite that spawns the CLI itself as a subprocess against a
// temp-dir fixture. Motivation for the CLI-level suite (from the review):
// "ZERO tests cover the CLI (~515 lines), and the CLI is where Critical 1
// [contaminated-gold refusal] and the agent-side-provenance fix [C1] are
// actually enforced: a refactor reverting side A to `rule_events` would
// leave the entire suite green." The unit tests below exercise the
// extracted logic directly; the integration suite proves the WIRING (main()
// actually calls them, in the right order, with the right data) by running
// the real script end-to-end.
//
// SAFETY: every filesystem-touching test in this file builds its own
// `platformRoot`/`reviewsRoot` under os.tmpdir() and points the CLI at them
// via CHART_REVIEW_PLATFORM_ROOT / CHART_REVIEW_REVIEWS_ROOT — both env
// vars are read fresh per call (packages/patients/src/index.ts,
// packages/rubric/src/skill-bundle.ts), so a subprocess with these set
// never resolves into the real platform checkout. Nothing here reads or
// writes real `var/reviews` or any tracked `.claude/skills/*/sessions/`
// manifest.

import { describe, it, expect, afterEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  parseArgs,
  toEventSides,
  readReviewStateFile,
  isBlindContaminatedSideB,
  findContaminatedPatients,
  resolveAgentId,
  checkProvenance,
  isIncomplete,
  type RuleEventsFile,
} from "./iaa-events.js";
import type { PerEventReport } from "@chart-review/eval-adherence-iaa";
import type { RuleEvent } from "@chart-review/platform-types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Walk up to the platform root rather than counting "../.." — this file moved one
// level deeper when the asthma scripts were consolidated, and a hard-coded depth
// silently pointed the spawned CLI at a path that no longer existed.
const REPO_ROOT = (() => {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))
        && fs.existsSync(path.join(dir, "node_modules", ".bin", "tsx"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(`could not locate the platform root above ${__dirname}`);
})();

// ── parseArgs mutates process.exitCode as a side effect on failure paths —
//    always restore it so a failing-arg unit test can't leak an exit code
//    into the real vitest process. ──────────────────────────────────────
afterEach(() => {
  process.exitCode = undefined;
});

describe("parseArgs", () => {
  it("parses all flags, including --allow-non-blind-gold", () => {
    const args = parseArgs([
      "--task", "t1", "--session-a", "sA", "--session-b", "sB", "--agent-id", "ag1",
      "--patients", "p1,p2, p3", "--json", "--force", "--allow-incomplete", "--allow-non-blind-gold",
    ]);
    expect(args).toEqual({
      task: "t1", sessionA: "sA", sessionB: "sB", agentId: "ag1",
      patients: ["p1", "p2", "p3"], json: true, force: true,
      allowIncomplete: true, allowNonBlindGold: true, help: false,
    });
  });

  it("defaults allowNonBlindGold to false", () => {
    const args = parseArgs(["--session-a", "sA", "--session-b", "sB"]);
    expect(args?.allowNonBlindGold).toBe(false);
  });

  it("returns null and sets exitCode 1 on an unrecognized flag", () => {
    const args = parseArgs(["--bogus"]);
    expect(args).toBeNull();
    expect(process.exitCode).toBe(1);
  });

  it("returns null and sets exitCode 1 when a value-flag is missing its value", () => {
    const args = parseArgs(["--session-a"]);
    expect(args).toBeNull();
    expect(process.exitCode).toBe(1);
  });

  it("--help sets help:true regardless of position", () => {
    expect(parseArgs(["--help"])?.help).toBe(true);
    expect(parseArgs(["-h"])?.help).toBe(true);
  });
});

describe("toEventSides — the EventSide mapper (Important 4)", () => {
  it("maps anchored (dated, non-window) events with anchored:true", () => {
    const events: RuleEvent[] = [
      { event_id: "R@d1@e1", rule_id: "R", anchor: { type: "encounter", date: "2024-01-01", origin: "omop" }, verdict: "CONCORDANT" },
    ];
    const [side] = toEventSides("p1", events);
    expect(side).toMatchObject({
      patient_id: "p1", event_id: "R@d1@e1", rule_id: "R", anchored: true, origin: "omop", verdict: "CONCORDANT",
    });
  });

  it("maps window anchors (type==='window', no date) with anchored:false", () => {
    const events: RuleEvent[] = [
      { event_id: "R@window", rule_id: "R", anchor: { type: "window", origin: "omop" } },
    ];
    const [side] = toEventSides("p1", events);
    expect(side?.anchored).toBe(false);
  });

  it("treats a non-window anchor missing `date` as NOT anchored", () => {
    const events: RuleEvent[] = [
      { event_id: "R@nodate", rule_id: "R", anchor: { type: "encounter", origin: "omop" } },
    ];
    const [side] = toEventSides("p1", events);
    expect(side?.anchored).toBe(false);
  });

  it("carries through origin, evaluable, and verdict unchanged", () => {
    const events: RuleEvent[] = [
      { event_id: "R@d1@e1", rule_id: "R", anchor: { type: "encounter", date: "2024-01-01", origin: "note" }, evaluable: false, evaluable_reason: "x" },
    ];
    const [side] = toEventSides("p1", events);
    expect(side?.origin).toBe("note");
    expect(side?.evaluable).toBe(false);
    expect(side?.verdict).toBeUndefined();
  });
});

describe("isBlindContaminatedSideB — the contamination predicate (Critical 1)", () => {
  it("is false for a clean gold: no import marker, no shadow maps, every scored event stamped source:reviewer", () => {
    const data: RuleEventsFile = {
      rule_events: [
        { event_id: "e1", rule_id: "R", anchor: { type: "encounter", date: "2024-01-01", origin: "omop" }, verdict: "CONCORDANT", source: "reviewer" },
      ],
    };
    expect(isBlindContaminatedSideB(data)).toBe(false);
  });

  it("is true when imported_from_run is set", () => {
    expect(isBlindContaminatedSideB({ imported_from_run: "run_1" })).toBe(true);
  });

  it("is true when agent_rule_events is a non-empty shadow map", () => {
    expect(isBlindContaminatedSideB({ agent_rule_events: { agent1: [{ event_id: "e1", rule_id: "R", anchor: { type: "window", origin: "omop" } }] } })).toBe(true);
  });

  it("is true when agent_question_answers or agent_rule_verdicts is non-empty", () => {
    expect(isBlindContaminatedSideB({ agent_question_answers: { q1: [{ any: true }] as unknown as [] } })).toBe(true);
    expect(isBlindContaminatedSideB({ agent_rule_verdicts: { r1: [{ any: true }] as unknown as [] } })).toBe(true);
  });

  it("is false when a shadow map key exists but maps to an empty array (no entries)", () => {
    expect(isBlindContaminatedSideB({ agent_rule_events: { agent1: [] } })).toBe(false);
  });

  it("is true when a SCORED rule_event's source is not 'reviewer' (the third, independent tell)", () => {
    const data: RuleEventsFile = {
      rule_events: [
        { event_id: "e1", rule_id: "R", anchor: { type: "encounter", date: "2024-01-01", origin: "omop" }, verdict: "CONCORDANT", source: "agent" },
      ],
    };
    expect(isBlindContaminatedSideB(data)).toBe(true);
  });

  it("is true when a NOT_EVALUABLE (scored) event's source is missing", () => {
    const data: RuleEventsFile = {
      rule_events: [
        { event_id: "e1", rule_id: "R", anchor: { type: "encounter", date: "2024-01-01", origin: "omop" }, evaluable: false },
      ],
    };
    expect(isBlindContaminatedSideB(data)).toBe(true);
  });

  it("is false for an UNSCORED stub (no verdict, evaluable !== false) even with a missing source — nothing to attribute yet", () => {
    const data: RuleEventsFile = {
      rule_events: [
        { event_id: "e1", rule_id: "R", anchor: { type: "encounter", date: "2024-01-01", origin: "omop" } },
      ],
    };
    expect(isBlindContaminatedSideB(data)).toBe(false);
  });
});

describe("findContaminatedPatients", () => {
  it("returns only the patient_ids whose side B is contaminated", () => {
    const clean: RuleEventsFile = { rule_events: [] };
    const dirty: RuleEventsFile = { imported_from_run: "run_1" };
    const result = findContaminatedPatients([
      { patient_id: "p1", b: { data: clean } },
      { patient_id: "p2", b: { data: dirty } },
      { patient_id: "p3", b: { data: clean } },
    ]);
    expect(result).toEqual(["p2"]);
  });
});

describe("resolveAgentId — the C1 agent-id resolver (Important 4)", () => {
  it("returns the sole agent_id found across comparable patients when none is given explicitly", () => {
    const comparable = [
      { a: { data: { agent_rule_events: { agentX: [] } } as RuleEventsFile } },
      { a: { data: { agent_rule_events: { agentX: [] } } as RuleEventsFile } },
    ];
    expect(resolveAgentId(comparable)).toEqual({ ok: true, agentId: "agentX" });
  });

  it("an explicit --agent-id always wins, even if it's absent from every patient's shadow map", () => {
    const comparable = [{ a: { data: { agent_rule_events: { agentX: [] } } as RuleEventsFile } }];
    expect(resolveAgentId(comparable, "agentZ")).toEqual({ ok: true, agentId: "agentZ" });
  });

  it("fails when NO agent_rule_events shadow map is found anywhere (refuses to fall back to rule_events)", () => {
    const comparable = [{ a: { data: {} as RuleEventsFile } }];
    const result = resolveAgentId(comparable);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no agent_rule_events shadow map/);
  });

  it("fails with an ambiguity error when more than one agent_id is found and none is given", () => {
    const comparable = [
      { a: { data: { agent_rule_events: { agentX: [] } } as RuleEventsFile } },
      { a: { data: { agent_rule_events: { agentY: [] } } as RuleEventsFile } },
    ];
    const result = resolveAgentId(comparable);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/ambiguous agent_id/);
  });
});

describe("checkProvenance — the provenance gate predicate (Important 4)", () => {
  it("reports no mismatch when both sides' worklist_hash agree", () => {
    const prov = { seeded_by: "runner" as const, ts: "t", guideline_sha: "g", anchor_lists: {}, worklist_hash: "H1" };
    const comparable = [{ patient_id: "p1", a: { data: { rule_events_provenance: prov } as RuleEventsFile }, b: { data: { rule_events_provenance: prov } as RuleEventsFile } }];
    const result = checkProvenance(comparable);
    expect(result.mismatches).toEqual([]);
    expect(result.unchecked).toEqual([]);
  });

  it("reports a mismatch when worklist_hash differs", () => {
    const provA = { seeded_by: "runner" as const, ts: "t", guideline_sha: "g", anchor_lists: {}, worklist_hash: "H1" };
    const provB = { seeded_by: "blind-seed-route" as const, ts: "t", guideline_sha: "g", anchor_lists: {}, worklist_hash: "H2" };
    const comparable = [{ patient_id: "p1", a: { data: { rule_events_provenance: provA } as RuleEventsFile }, b: { data: { rule_events_provenance: provB } as RuleEventsFile } }];
    const result = checkProvenance(comparable);
    expect(result.mismatches).toEqual([{ patient_id: "p1", hash_a: "H1", hash_b: "H2" }]);
  });

  it("marks a patient unchecked when provenance is missing on either side", () => {
    const comparable = [{ patient_id: "p1", a: { data: {} as RuleEventsFile }, b: { data: {} as RuleEventsFile } }];
    const result = checkProvenance(comparable);
    expect(result.unchecked).toEqual(["p1"]);
    expect(result.mismatches).toEqual([]);
  });
});

describe("isIncomplete — the completeness gate predicate (Important 4)", () => {
  function report(overrides: Partial<PerEventReport>): PerEventReport {
    return {
      per_rule: [], verdict_kappa: Number.NaN, verdict_n: 0, verdict_agreement: Number.NaN,
      label_marginals: { a: {}, b: {} }, confusion: [],
      n_unscored_a: 0, n_unscored_b: 0, n_unscored_both: 0,
      completeness_a: 1, completeness_b: 1,
      enumeration: { matched: 0, a_only: 0, b_only: 0, jaccard: Number.NaN, by_origin: { omop: { matched: 0, a_only: 0, b_only: 0, jaccard: Number.NaN }, note: { matched: 0, a_only: 0, b_only: 0, jaccard: Number.NaN } } },
      window_rules: 0,
      ...overrides,
    };
  }

  it("false when matched===0 (nothing to be incomplete about)", () => {
    expect(isIncomplete(report({ enumeration: { matched: 0, a_only: 0, b_only: 0, jaccard: Number.NaN, by_origin: { omop: { matched: 0, a_only: 0, b_only: 0, jaccard: Number.NaN }, note: { matched: 0, a_only: 0, b_only: 0, jaccard: Number.NaN } } } }))).toBe(false);
  });

  it("false when both completeness_a and completeness_b are 1", () => {
    expect(isIncomplete(report({ enumeration: { matched: 5, a_only: 0, b_only: 0, jaccard: 1, by_origin: { omop: { matched: 5, a_only: 0, b_only: 0, jaccard: 1 }, note: { matched: 0, a_only: 0, b_only: 0, jaccard: Number.NaN } } }, completeness_a: 1, completeness_b: 1 }))).toBe(false);
  });

  it("true when completeness_a < 1", () => {
    expect(isIncomplete(report({ enumeration: { matched: 5, a_only: 0, b_only: 0, jaccard: 1, by_origin: { omop: { matched: 5, a_only: 0, b_only: 0, jaccard: 1 }, note: { matched: 0, a_only: 0, b_only: 0, jaccard: Number.NaN } } }, completeness_a: 0.8, completeness_b: 1 }))).toBe(true);
  });

  it("true when completeness_b < 1", () => {
    expect(isIncomplete(report({ enumeration: { matched: 5, a_only: 0, b_only: 0, jaccard: 1, by_origin: { omop: { matched: 5, a_only: 0, b_only: 0, jaccard: 1 }, note: { matched: 0, a_only: 0, b_only: 0, jaccard: Number.NaN } } }, completeness_a: 1, completeness_b: 0.5 }))).toBe(true);
  });
});

describe("readReviewStateFile — missing / parse_error / permission_error (minor)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "iaa-events-readfile-"));
  afterAll(() => {
    fs.chmodSync(tmp, 0o755); // in case the permission_error test's finally didn't run
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns reason 'missing' for a nonexistent path", () => {
    const result = readReviewStateFile(path.join(tmp, "does-not-exist.json"));
    expect(result).toEqual({ ok: false, reason: "missing" });
  });

  it("returns reason 'parse_error' for a file that exists but isn't valid JSON", () => {
    const fp = path.join(tmp, "corrupt.json");
    fs.writeFileSync(fp, "{ not: valid json");
    const result = readReviewStateFile(fp);
    expect(result).toEqual({ ok: false, reason: "parse_error" });
  });

  it("returns ok:true with the parsed data for a well-formed file", () => {
    const fp = path.join(tmp, "good.json");
    fs.writeFileSync(fp, JSON.stringify({ rule_events: [] }));
    const result = readReviewStateFile(fp);
    expect(result).toEqual({ ok: true, data: { rule_events: [] } });
  });

  it("returns reason 'permission_error' (distinct from parse_error) when the file exists but can't be read", () => {
    if (process.getuid && process.getuid() === 0) {
      // root ignores file-mode read restrictions — skip rather than false-fail.
      return;
    }
    const fp = path.join(tmp, "unreadable.json");
    fs.writeFileSync(fp, JSON.stringify({ rule_events: [] }));
    fs.chmodSync(fp, 0o000);
    try {
      const result = readReviewStateFile(fp);
      expect(result).toEqual({ ok: false, reason: "permission_error" });
    } finally {
      fs.chmodSync(fp, 0o644); // restore so mkdtemp cleanup (if any) can remove it
    }
  });
});

// ── Fixture-driven CLI integration suite ────────────────────────────────
//
// Spawns the real script as a subprocess via tsx, pointed at an isolated
// temp-dir "platform" (session manifests) and "reviews" root (review_state
// files) via CHART_REVIEW_PLATFORM_ROOT / CHART_REVIEW_REVIEWS_ROOT. NEVER
// touches real var/reviews or a tracked sessions/ manifest.

interface Fixture {
  platformRoot: string;
  reviewsRoot: string;
}

function makeFixture(): Fixture {
  return {
    platformRoot: fs.mkdtempSync(path.join(os.tmpdir(), "iaa-events-cli-platform-")),
    reviewsRoot: fs.mkdtempSync(path.join(os.tmpdir(), "iaa-events-cli-reviews-")),
  };
}

function writeJsonFile(fp: string, data: unknown): void {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(data, null, 2));
}

function writeManifest(
  fixture: Fixture, task: string, sessionId: string,
  opts: { blind?: boolean; patientIds: string[] },
): void {
  const fp = path.join(fixture.platformRoot, ".claude", "skills", `chart-review-${task}`, "sessions", sessionId, "manifest.json");
  writeJsonFile(fp, {
    session_id: sessionId, session_num: 1, task_id: task, name: sessionId,
    started_at: "2026-01-01T00:00:00Z", started_by: "test", state: "active",
    cohort: { patient_ids: opts.patientIds }, skill_snapshot_sha: "test-sha",
    ...(opts.blind !== undefined ? { blind: opts.blind } : {}),
  });
}

function writeReviewState(
  fixture: Fixture, sessionId: string, patientId: string, task: string, data: unknown,
): void {
  const fp = path.join(fixture.reviewsRoot, sessionId, patientId, task, "review_state.json");
  writeJsonFile(fp, data);
}

function runCli(fixture: Fixture, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const tsxBin = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
  const scriptPath = path.join(REPO_ROOT, "scripts", "asthma-annotate", "iaa-events.ts");
  const res = spawnSync(tsxBin, [scriptPath, ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      CHART_REVIEW_PLATFORM_ROOT: fixture.platformRoot,
      CHART_REVIEW_REVIEWS_ROOT: fixture.reviewsRoot,
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

const TASK = "test-adherence";
const anchor = (date: string) => ({ type: "encounter", date, origin: "omop" as const });

describe("iaa-events CLI — fixture-driven integration (temp dirs only, never real var/reviews)", () => {
  const fixtures: string[] = [];

  afterEach(() => {
    for (const dir of fixtures.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function fresh(): Fixture {
    const f = makeFixture();
    fixtures.push(f.platformRoot, f.reviewsRoot);
    return f;
  }

  it("reads side A from the SHADOW draft, not the live rule_events array — the exact regression Important 4 is guarding against", () => {
    const f = fresh();
    writeManifest(f, TASK, "session_001", { blind: false, patientIds: ["p1"] });
    writeManifest(f, TASK, "session_002", { blind: true, patientIds: ["p1"] });

    // Side A's shadow draft disagrees with gold on one event...
    const shadow: RuleEvent[] = [
      { event_id: "R@d1@e1", rule_id: "R", anchor: anchor("2024-01-01"), verdict: "NON_CONCORDANT", source: "agent" },
      { event_id: "R@d2@e2", rule_id: "R", anchor: anchor("2024-02-01"), verdict: "CONCORDANT", source: "agent" },
    ];
    // ...but the LIVE rule_events array has since been "corrected" by a
    // human to perfectly match gold. If the CLI regressed to reading
    // rule_events for side A, this test would see 100% agreement instead.
    const corrected: RuleEvent[] = [
      { event_id: "R@d1@e1", rule_id: "R", anchor: anchor("2024-01-01"), verdict: "CONCORDANT", source: "reviewer" },
      { event_id: "R@d2@e2", rule_id: "R", anchor: anchor("2024-02-01"), verdict: "CONCORDANT", source: "reviewer" },
    ];
    writeReviewState(f, "session_001", "p1", TASK, { agent_rule_events: { agent1: shadow }, rule_events: corrected });

    const gold: RuleEvent[] = [
      { event_id: "R@d1@e1", rule_id: "R", anchor: anchor("2024-01-01"), verdict: "CONCORDANT", source: "reviewer" },
      { event_id: "R@d2@e2", rule_id: "R", anchor: anchor("2024-02-01"), verdict: "CONCORDANT", source: "reviewer" },
    ];
    writeReviewState(f, "session_002", "p1", TASK, { rule_events: gold });

    const res = runCli(f, ["--task", TASK, "--session-a", "session_001", "--session-b", "session_002", "--patients", "p1", "--json"]);
    expect(res.status).toBe(0);
    const envelope = JSON.parse(res.stdout);
    expect(envelope.report.verdict_n).toBe(2);
    // 1 of 2 agree (the shadow's NON_CONCORDANT vs gold's CONCORDANT) —
    // NOT 1.0, which is what reading `rule_events` would have produced.
    expect(envelope.report.verdict_agreement).toBeCloseTo(0.5);
    expect(envelope.report.verdict_agreement).not.toBe(1);
  });

  it("refuses a contaminated gold at exit 4, with NO override available", () => {
    const f = fresh();
    writeManifest(f, TASK, "session_001", { blind: false, patientIds: ["p1"] });
    writeManifest(f, TASK, "session_002", { blind: true, patientIds: ["p1"] }); // manifest SAYS blind...

    writeReviewState(f, "session_001", "p1", TASK, {
      agent_rule_events: { agent1: [{ event_id: "R@d1@e1", rule_id: "R", anchor: anchor("2024-01-01"), verdict: "CONCORDANT", source: "agent" }] },
      rule_events: [{ event_id: "R@d1@e1", rule_id: "R", anchor: anchor("2024-01-01"), verdict: "CONCORDANT", source: "reviewer" }],
    });
    // ...but session B's actual content is a re-imported agent draft
    // verbatim: imported_from_run set, non-empty agent_rule_events, and
    // rule_events stamped source:"agent" instead of "reviewer" — exactly
    // the reviewer's repro for Critical 1.
    writeReviewState(f, "session_002", "p1", TASK, {
      imported_from_run: "run_1",
      agent_rule_events: { agent1: [{ event_id: "R@d1@e1", rule_id: "R", anchor: anchor("2024-01-01"), verdict: "CONCORDANT", source: "agent" }] },
      rule_events: [{ event_id: "R@d1@e1", rule_id: "R", anchor: anchor("2024-01-01"), verdict: "CONCORDANT", source: "agent" }],
    });

    const res = runCli(f, ["--task", TASK, "--session-a", "session_001", "--session-b", "session_002", "--patients", "p1"]);
    expect(res.status).toBe(4);
    expect(res.stderr).toMatch(/CONTAMINATED GOLD/);
  });

  it("refuses by default when session B's manifest lacks blind:true, at exit 4", () => {
    const f = fresh();
    writeManifest(f, TASK, "session_001", { blind: false, patientIds: ["p1"] });
    writeManifest(f, TASK, "session_005", { blind: false, patientIds: ["p1"] }); // not blind

    writeReviewState(f, "session_001", "p1", TASK, {
      agent_rule_events: { agent1: [{ event_id: "R@d1@e1", rule_id: "R", anchor: anchor("2024-01-01"), verdict: "CONCORDANT", source: "agent" }] },
    });
    writeReviewState(f, "session_005", "p1", TASK, {
      rule_events: [{ event_id: "R@d1@e1", rule_id: "R", anchor: anchor("2024-01-01"), verdict: "CONCORDANT", source: "reviewer" }],
    });

    const res = runCli(f, ["--task", TASK, "--session-a", "session_001", "--session-b", "session_005", "--patients", "p1"]);
    expect(res.status).toBe(4);
    expect(res.stderr).toMatch(/NOT FLAGGED blind:true/);
  });

  it("--allow-non-blind-gold overrides the manifest check and proceeds to exit 0, with the override recorded in the envelope", () => {
    const f = fresh();
    writeManifest(f, TASK, "session_001", { blind: false, patientIds: ["p1"] });
    writeManifest(f, TASK, "session_005", { blind: false, patientIds: ["p1"] });

    writeReviewState(f, "session_001", "p1", TASK, {
      agent_rule_events: { agent1: [{ event_id: "R@d1@e1", rule_id: "R", anchor: anchor("2024-01-01"), verdict: "CONCORDANT", source: "agent" }] },
    });
    writeReviewState(f, "session_005", "p1", TASK, {
      rule_events: [{ event_id: "R@d1@e1", rule_id: "R", anchor: anchor("2024-01-01"), verdict: "CONCORDANT", source: "reviewer" }],
    });

    const res = runCli(f, ["--task", TASK, "--session-a", "session_001", "--session-b", "session_005", "--patients", "p1", "--allow-non-blind-gold", "--json"]);
    expect(res.status).toBe(0);
    const envelope = JSON.parse(res.stdout);
    expect(envelope.blind).toEqual({ session_a: false, session_b: false, neither_blind: true, non_blind_gold_override: true });
  });

  it("a clean blind gold with complete scoring succeeds at exit 0 and prints a human-readable report", () => {
    const f = fresh();
    writeManifest(f, TASK, "session_001", { blind: false, patientIds: ["p1"] });
    writeManifest(f, TASK, "session_002", { blind: true, patientIds: ["p1"] });

    writeReviewState(f, "session_001", "p1", TASK, {
      agent_rule_events: { agent1: [{ event_id: "R@d1@e1", rule_id: "R", anchor: anchor("2024-01-01"), verdict: "CONCORDANT", source: "agent" }] },
    });
    writeReviewState(f, "session_002", "p1", TASK, {
      rule_events: [{ event_id: "R@d1@e1", rule_id: "R", anchor: anchor("2024-01-01"), verdict: "NON_CONCORDANT", source: "reviewer" }],
    });

    const res = runCli(f, ["--task", TASK, "--session-a", "session_001", "--session-b", "session_002", "--patients", "p1"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/Global verdict kappa/);
    expect(res.stdout).toMatch(/blind=true/);
    expect(res.stderr).not.toMatch(/CONTAMINATED/);
  });

  it("--help exits 0 and documents exit codes 0-4", () => {
    const f = fresh();
    const res = runCli(f, ["--help"]);
    expect(res.status).toBe(0);
    for (const code of ["0 ", "1 ", "2 ", "3 ", "4 "]) {
      expect(res.stdout).toContain(code);
    }
    expect(res.stdout).toMatch(/--allow-non-blind-gold/);
  });
});
