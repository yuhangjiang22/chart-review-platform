import Anthropic from "@anthropic-ai/sdk";
import {
  DerivedAdjudicationSchema,
  type DerivedAdjudication,
} from "./schema";
import type { FieldAssessment } from "../domain/review/review-state";

export interface ClassifyInput {
  patient_id: string;
  field_id: string;
  iter_id: string;
  field_prompt: string;
  human_assessment: FieldAssessment;
  human_comment: string | null;
  agent_1: { agent_id: string; assessment: FieldAssessment; audit_text: string };
  agent_2: { agent_id: string; assessment: FieldAssessment; audit_text: string };
  guideline_text: string;
}

const HAIKU = "claude-haiku-4-5";
const SONNET = "claude-sonnet-4-6";

const SYSTEM_PROMPT = `You are an adjudication classifier for a chart-review pilot.

Given:
- The human reviewer's committed assessment for one criterion (the truth).
- Two agents' draft assessments and their tool-call trajectories.
- The guideline criterion text.

Produce one JSON object matching the schema below. Use ONLY the data given.

REQUIRED JSON OUTPUT (no prose, no markdown fences):
{
  "agent_1": {
    "answer_match_human": boolean,
    "evidence_overlap_jaccard": number in [0,1],
    "notes_read_jaccard": number in [0,1],
    "human_evidence_seen_by_agent": boolean,
    "classification": one of ["correct","wrong_answer_clear_rule","wrong_answer_gap_arguable","right_answer_wrong_evidence","missed_human_evidence"],
    "rationale_short": one sentence
  },
  "agent_2": { same shape },
  "pair": { "classification": one of ["both_correct","one_wrong","both_wrong_same_way","both_wrong_different_ways"] },
  "gap_signal": {
    "candidate": boolean,
    "reason": short string,
    "suggested_revision": markdown patch text OR null
  },
  "trajectory_features": {
    "notes_unique_to_agent_1": [string],
    "notes_unique_to_agent_2": [string],
    "notes_only_human_cited": [string]
  }
}

Rules:
- If both agents disagree with the human and their reasoning suggests the rubric is silent or ambiguous, set gap_signal.candidate = true and propose a suggested_revision.
- Classify "missed_human_evidence" only if the agent did not appear to read the note(s) the human cited.
- Classify "right_answer_wrong_evidence" when the answer matches but cited evidence diverges.
- Be conservative on gap_signal.candidate — single-patient signals usually aren't enough by themselves.`;

function buildUserMessage(input: ClassifyInput): string {
  return [
    `# Criterion`,
    `id: ${input.field_id}`,
    `prompt: ${input.field_prompt}`,
    ``,
    `# Guideline (active criterion text)`,
    input.guideline_text,
    ``,
    `# Human truth`,
    JSON.stringify(input.human_assessment, null, 2),
    `Reviewer comment: ${input.human_comment ?? "(none)"}`,
    ``,
    `# Agent 1 (${input.agent_1.agent_id}) draft`,
    JSON.stringify(input.agent_1.assessment, null, 2),
    ``,
    `# Agent 1 trajectory (truncated)`,
    input.agent_1.audit_text,
    ``,
    `# Agent 2 (${input.agent_2.agent_id}) draft`,
    JSON.stringify(input.agent_2.assessment, null, 2),
    ``,
    `# Agent 2 trajectory (truncated)`,
    input.agent_2.audit_text,
    ``,
    `Respond with ONLY the JSON object — no prose, no markdown.`,
  ].join("\n");
}

function extractText(message: Anthropic.Message): string {
  for (const block of message.content) {
    if (block.type === "text") return block.text;
  }
  return "";
}

async function callOnce(
  client: Anthropic,
  model: typeof HAIKU | typeof SONNET,
  input: ClassifyInput,
): Promise<{ raw: string; cost_usd: number }> {
  const sys = SYSTEM_PROMPT + "\n\nGUIDELINE_HASH:" + input.field_id; // pin cache key per criterion
  const message = (await client.messages.create({
    model,
    max_tokens: 1500,
    system: [
      { type: "text", text: sys, cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content: buildUserMessage(input) }],
  } as Parameters<typeof client.messages.create>[0])) as Anthropic.Message;
  // Conservative cost estimate; refine when usage block is parsed elsewhere.
  const inTok = message.usage.input_tokens;
  const outTok = message.usage.output_tokens;
  const ratePerMTokIn = model === HAIKU ? 1.0 : 3.0;
  const ratePerMTokOut = model === HAIKU ? 5.0 : 15.0;
  const cost_usd = (inTok / 1_000_000) * ratePerMTokIn + (outTok / 1_000_000) * ratePerMTokOut;
  return { raw: extractText(message), cost_usd };
}

function tryBuildRecord(
  raw: string,
  input: ClassifyInput,
  model: typeof HAIKU | typeof SONNET,
  cost_usd: number,
): DerivedAdjudication | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const record = {
    patient_id: input.patient_id,
    field_id: input.field_id,
    iter_id: input.iter_id,
    ...(parsed as object),
    reviewer_comment: input.human_comment,
    classifier: {
      model,
      ts: new Date().toISOString(),
      cost_usd,
    },
  };
  const result = DerivedAdjudicationSchema.safeParse(record);
  return result.success ? result.data : null;
}

function degradedRecord(input: ClassifyInput): DerivedAdjudication {
  const ts = new Date().toISOString();
  const blank = {
    answer_match_human: false,
    evidence_overlap_jaccard: 0,
    notes_read_jaccard: 0,
    human_evidence_seen_by_agent: false,
    classification: "validation_failed" as const,
    rationale_short: "Classifier output failed schema validation on both Haiku and Sonnet.",
  };
  return {
    patient_id: input.patient_id,
    field_id: input.field_id,
    iter_id: input.iter_id,
    agent_1: blank,
    agent_2: blank,
    pair: { classification: "both_wrong_different_ways" },
    gap_signal: { candidate: false, reason: "validation_failed", suggested_revision: null },
    trajectory_features: {
      notes_unique_to_agent_1: [],
      notes_unique_to_agent_2: [],
      notes_only_human_cited: [],
    },
    reviewer_comment: input.human_comment,
    classifier: { model: SONNET, ts, cost_usd: 0 },
  };
}

export async function classifyField(input: ClassifyInput): Promise<DerivedAdjudication> {
  const client = new Anthropic();
  const { raw: rawHaiku, cost_usd: costHaiku } = await callOnce(client, HAIKU, input);
  const fromHaiku = tryBuildRecord(rawHaiku, input, HAIKU, costHaiku);
  if (fromHaiku) return fromHaiku;
  const { raw: rawSonnet, cost_usd: costSonnet } = await callOnce(client, SONNET, input);
  const fromSonnet = tryBuildRecord(rawSonnet, input, SONNET, costSonnet);
  if (fromSonnet) return fromSonnet;
  return degradedRecord(input);
}
