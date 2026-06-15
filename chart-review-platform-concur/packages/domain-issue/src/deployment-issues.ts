/**
 * Deployment-issues queue — minimum-viable backend for blueprint §5 (M2).
 *
 * In production, reviewers and clinical end-users surface field issues against
 * a locked guideline. Each issue is appended to a per-guideline-sha JSONL log
 * on disk. The triage UI (later) reads this log and lets a methodologist
 * categorize each entry (dismiss / agent_error / data_issue / guideline_gap)
 * and promote a batch into the next pilot's dev_patient_ids.
 *
 * This file ships only the append + list primitives. Triage state and the
 * promotion action will stack on top.
 *
 * Storage layout:
 *   <PLATFORM_ROOT>/deployment-issues/<guideline_sha>.jsonl
 *
 * One JSON object per line. Append-only. Never mutate existing lines.
 */

import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { PLATFORM_ROOT } from "@chart-review/patients";

/** Methodologist's classification of a filed issue. */
export type TriageCategory = "dismiss" | "agent_error" | "data_issue" | "guideline_gap";

export interface TriageState {
  category: TriageCategory;
  triaged_by: string;
  triaged_at: string;
  /** Methodologist's prose justification or note for the triage. */
  note?: string;
  /**
   * For agent_error / guideline_gap: the answer the methodologist believes is
   * correct. Free-form so it can carry both scalar values and structured
   * corrections (objects, arrays). Feeds promote-to-iter as ground-truth seed.
   */
  corrected_answer?: unknown;
}

/**
 * Record of an issue having been promoted into a new pilot iteration. The
 * promote-to-iter action takes a batch of triaged issues, creates a pilot
 * iter with their patient_ids as dev_patient_ids, and stamps each one with
 * this state so reviewers can see which issues drove the next iteration and
 * avoid re-promoting them.
 */
export interface PromotionState {
  promoted_to_iter: string;
  promoted_at: string;
  promoted_by: string;
}

/** A reviewer-or-end-user-flagged issue against a deployed locked guideline. */
export interface DeploymentIssue {
  /** Server-generated UUID. */
  issue_id: string;
  /** SHA of the locked guideline this issue is filed against. Frozen at filing time. */
  guideline_sha: string;
  /** The patient whose review surfaced the issue. */
  patient_id: string;
  /** Optional — present when the issue is scoped to a single criterion. */
  field_id?: string;
  /** Reviewer ID from auth. */
  reporter_id: string;
  /** ISO 8601. */
  reported_at: string;
  /** Free-form prose. The reviewer's account of what's wrong. */
  description: string;
  /**
   * Optional — what the reporter thinks the answer should be. May feed the
   * triage UI as a methodologist override candidate. Free-form so it can
   * carry both scalar answers and structured corrections.
   */
  suggested_correction?: unknown;
  /**
   * Latest triage state, rolled up at read time from triage_update entries
   * appended to the same log. Absent when the issue is untriaged.
   */
  triage?: TriageState;
  /**
   * Latest promotion state, rolled up at read time from promotion entries.
   * Present when this issue has been folded into a pilot iter via the
   * promote-to-iter action. The UI uses this to disable re-promotion.
   */
  promoted?: PromotionState;
}

/** Shape accepted by appendIssue — caller doesn't supply issue_id or reported_at. */
export interface IssueDraft {
  guideline_sha: string;
  patient_id: string;
  field_id?: string;
  reporter_id: string;
  description: string;
  suggested_correction?: unknown;
}

/** On-disk discriminated record. Every entry carries an explicit `kind`. */
type LogRecord =
  | ({ kind: "issue" } & DeploymentIssue)
  | { kind: "triage_update"; issue_id: string; guideline_sha: string; triage: TriageState }
  | { kind: "promotion"; issue_id: string; guideline_sha: string; promoted: PromotionState };

// ── path resolution ──────────────────────────────────────────────────────────

/** Re-read each call so tests can override the platform root via env. */
function platformRoot(): string {
  return process.env.CHART_REVIEW_PLATFORM_ROOT ?? PLATFORM_ROOT;
}

export function deploymentIssuesRoot(): string {
  return path.join(platformRoot(), "deployment-issues");
}

/**
 * Validate the guideline SHA against a permissive but injection-safe pattern.
 * Hex characters only — the on-disk SHAs are 16-char prefixes from
 * computeTaskSha. Throws on anything else so a malformed param can't be used
 * to escape the deployment-issues/ directory.
 */
function validateGuidelineSha(sha: string): void {
  if (!/^[a-fA-F0-9]+$/.test(sha) || sha.length === 0 || sha.length > 64) {
    throw new Error(`invalid guideline_sha: ${sha}`);
  }
}

export function deploymentIssuesPath(guidelineSha: string): string {
  validateGuidelineSha(guidelineSha);
  return path.join(deploymentIssuesRoot(), `${guidelineSha}.jsonl`);
}

// ── append ───────────────────────────────────────────────────────────────────

/**
 * Append a new issue to the per-sha log. Returns the persisted issue.
 *
 * The write is a single fs.appendFileSync — no temp+rename — because we want
 * an append-only log where partial writes are recoverable (a half-written line
 * is just a JSON parse error on read; the prior lines are still intact). For
 * concurrent appends, Node's fs.appendFileSync uses O_APPEND semantics on
 * POSIX which atomically positions writes at end-of-file.
 */
export function appendIssue(draft: IssueDraft): DeploymentIssue {
  if (!draft.guideline_sha || !draft.patient_id || !draft.description || !draft.reporter_id) {
    throw new Error("guideline_sha, patient_id, description, and reporter_id are required");
  }
  const filePath = deploymentIssuesPath(draft.guideline_sha);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const issue: DeploymentIssue = {
    issue_id: randomUUID(),
    guideline_sha: draft.guideline_sha,
    patient_id: draft.patient_id,
    field_id: draft.field_id,
    reporter_id: draft.reporter_id,
    reported_at: new Date().toISOString(),
    description: draft.description,
    suggested_correction: draft.suggested_correction,
  };

  // Tag with kind: "issue" for forward-compatibility with the discriminated
  // log. Old entries without kind are still readable as kind="issue".
  const record: LogRecord = { kind: "issue", ...issue };
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`);
  return issue;
}

// ── triage updates ───────────────────────────────────────────────────────────

const VALID_CATEGORIES: TriageCategory[] = ["dismiss", "agent_error", "data_issue", "guideline_gap"];

/**
 * Append a triage update for an existing issue. Append-only: each update is a
 * new line in the log, and listIssues rolls up by latest. Returns the persisted
 * triage state.
 *
 * Throws if:
 * - the issue_id doesn't exist in the log for this guideline_sha
 * - category isn't one of the four valid values
 */
export function appendTriageUpdate(
  guidelineSha: string,
  issueId: string,
  triage: { category: TriageCategory; triaged_by: string; note?: string; corrected_answer?: unknown },
): TriageState {
  if (!triage.triaged_by) throw new Error("triaged_by is required");
  if (!VALID_CATEGORIES.includes(triage.category)) {
    throw new Error(`invalid triage category: ${triage.category} (expected one of ${VALID_CATEGORIES.join(", ")})`);
  }

  // Verify the issue exists in the log so we don't accept triage for a stale
  // or fabricated issue_id.
  const existing = listIssues(guidelineSha);
  if (!existing.some((i) => i.issue_id === issueId)) {
    throw new Error(`issue ${issueId} not found for guideline_sha ${guidelineSha}`);
  }

  const triageState: TriageState = {
    category: triage.category,
    triaged_by: triage.triaged_by,
    triaged_at: new Date().toISOString(),
    note: triage.note,
    corrected_answer: triage.corrected_answer,
  };

  const record: LogRecord = {
    kind: "triage_update",
    issue_id: issueId,
    guideline_sha: guidelineSha,
    triage: triageState,
  };
  fs.appendFileSync(deploymentIssuesPath(guidelineSha), `${JSON.stringify(record)}\n`);
  return triageState;
}

// ── promotions ───────────────────────────────────────────────────────────────

/**
 * Append a promotion record marking that this issue was folded into a new
 * pilot iter via the promote-to-iter action. listIssues rolls up the latest
 * promotion onto each issue.
 *
 * Throws if the issue_id doesn't exist in the log for this guideline_sha.
 */
export function appendPromotion(
  guidelineSha: string,
  issueId: string,
  opts: { promoted_to_iter: string; promoted_by: string },
): PromotionState {
  if (!opts.promoted_by) throw new Error("promoted_by is required");
  if (!opts.promoted_to_iter) throw new Error("promoted_to_iter is required");

  const existing = listIssues(guidelineSha);
  if (!existing.some((i) => i.issue_id === issueId)) {
    throw new Error(`issue ${issueId} not found for guideline_sha ${guidelineSha}`);
  }

  const promotion: PromotionState = {
    promoted_to_iter: opts.promoted_to_iter,
    promoted_at: new Date().toISOString(),
    promoted_by: opts.promoted_by,
  };

  const record: LogRecord = {
    kind: "promotion",
    issue_id: issueId,
    guideline_sha: guidelineSha,
    promoted: promotion,
  };
  fs.appendFileSync(deploymentIssuesPath(guidelineSha), `${JSON.stringify(record)}\n`);
  return promotion;
}

// ── list ─────────────────────────────────────────────────────────────────────

/**
 * Read all issues for the given guideline_sha, in append order.
 *
 * The log holds two record kinds: original issues and triage_update entries.
 * This function returns the issues with the latest triage state rolled up
 * onto each one. Issue order is the original filing order.
 *
 * Returns an empty array when the log file doesn't exist (no issues filed
 * yet — not an error). Skips lines that don't parse as JSON: a half-written
 * line shouldn't break the whole list.
 */
export function listIssues(guidelineSha: string): DeploymentIssue[] {
  const filePath = deploymentIssuesPath(guidelineSha);
  if (!fs.existsSync(filePath)) return [];

  const text = fs.readFileSync(filePath, "utf8");
  const issues: DeploymentIssue[] = [];
  const issueIndex = new Map<string, number>();
  // Track the latest triage and promotion by issue_id so we apply only the most recent.
  const latestTriage = new Map<string, TriageState>();
  const latestPromotion = new Map<string, PromotionState>();

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let parsed: LogRecord;
    try {
      parsed = JSON.parse(line) as LogRecord;
    } catch {
      continue; // skip partial writes / hand-edit damage
    }
    if (parsed.kind === "triage_update") {
      latestTriage.set(parsed.issue_id, parsed.triage);
    } else if (parsed.kind === "promotion") {
      latestPromotion.set(parsed.issue_id, parsed.promoted);
    } else if (parsed.kind === "issue") {
      const issue = parsed as DeploymentIssue;
      issueIndex.set(issue.issue_id, issues.length);
      issues.push({ ...issue });
    }
    // Records without a recognized `kind` are skipped — corrupt or future-format entries.
  }

  // Apply rolled-up triage state.
  for (const [issueId, triage] of latestTriage) {
    const idx = issueIndex.get(issueId);
    if (idx !== undefined) issues[idx].triage = triage;
  }
  // Apply rolled-up promotion state.
  for (const [issueId, promotion] of latestPromotion) {
    const idx = issueIndex.get(issueId);
    if (idx !== undefined) issues[idx].promoted = promotion;
  }

  return issues;
}
