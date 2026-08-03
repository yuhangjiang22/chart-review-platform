/**
 * Verify-after-applied — re-run the targeted criterion on every patient
 * that motivated a proposal, and report which patients now match the
 * captured human ground truth.
 *
 * The actual agent re-run is injected as `reRunCriterion` so this module
 * stays pure (and so tests don't have to spin up the full batch-run
 * machinery). Production wires it to the existing criterion-rerun path.
 */
import * as fs from "fs";
import * as path from "path";
import { readProposal } from "./rule-store.js";
import { PLATFORM_ROOT } from "@chart-review/patients";

export interface VerifyResult {
  patient_id: string;
  agent_answer: unknown;
  ground_truth: unknown;
  matches: boolean;
}

export interface VerifyApplicationReport {
  rule_id: string;
  field_id: string;
  results: VerifyResult[];
  fixed_count: number;          // matches === true
  still_failing_count: number;  // matches === false
  computed_at: string;
}

export interface VerifyApplicationArgs {
  taskId: string;
  ruleId: string;
  reRunCriterion: (taskId: string, patientId: string, fieldId: string) => Promise<unknown>;
}

function reviewsRoot(): string {
  return process.env.CHART_REVIEW_REVIEWS_ROOT ?? path.join(PLATFORM_ROOT, "var", "reviews");
}

function readGroundTruth(taskId: string, patientId: string, fieldId: string): unknown {
  const p = path.join(reviewsRoot(), patientId, taskId, "review_state.json");
  if (!fs.existsSync(p)) return undefined;
  const state = JSON.parse(fs.readFileSync(p, "utf8")) as {
    field_assessments?: Array<{ field_id: string; answer: unknown; source: string; status: string }>;
  };
  const fa = (state.field_assessments ?? []).find(
    (x) => x.field_id === fieldId && x.source === "reviewer" && x.status === "approved",
  );
  return fa?.answer;
}

export async function verifyProposalApplication(args: VerifyApplicationArgs): Promise<VerifyApplicationReport> {
  const proposal = readProposal(args.taskId, args.ruleId);
  if (!proposal) throw new Error(`proposal not found: ${args.taskId}/${args.ruleId}`);
  if (proposal.status !== "applied") {
    throw new Error(`proposal ${args.ruleId} is not in applied status (current: ${proposal.status})`);
  }

  const ids = new Set<string>();
  if (proposal.trigger?.patient_id) ids.add(proposal.trigger.patient_id);
  for (const exp of proposal.expected_outcome ?? []) {
    if (exp.record_id) ids.add(exp.record_id);
  }
  const patientIds = [...ids];

  const results: VerifyResult[] = [];
  for (const patientId of patientIds) {
    const agentAnswer = await args.reRunCriterion(args.taskId, patientId, proposal.field_id);
    const groundTruth = readGroundTruth(args.taskId, patientId, proposal.field_id);
    results.push({
      patient_id: patientId,
      agent_answer: agentAnswer,
      ground_truth: groundTruth,
      matches: agentAnswer === groundTruth,
    });
  }

  return {
    rule_id: args.ruleId,
    field_id: proposal.field_id,
    results,
    fixed_count: results.filter((r) => r.matches).length,
    still_failing_count: results.filter((r) => !r.matches).length,
    computed_at: new Date().toISOString(),
  };
}
