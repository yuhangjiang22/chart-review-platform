/**
 * Adherence guideline-improvement driver.
 *
 * Parallel to ner-improvement.ts but for task_kind="adherence". The
 * driver pre-computes a question/rule-level diff between each agent's
 * draft and the reviewer's persisted answers, then asks the
 * `chart-review-adherence-improve` skill to cluster the disagreements
 * into proposals targeting `references/questions/*.yaml` and
 * `references/rules/*.yaml`.
 *
 * Inputs per patient:
 *   - reviews/<pid>/<task>/review_state.json — source=reviewer rows in
 *     `question_answers` / `rule_verdicts` (gold standard) +
 *     `agent_question_answers` / `agent_rule_verdicts` (per-agent shadow
 *     drafts captured at import time).
 *
 * Disagreement classifications:
 *   - question_disagreements: agent answer differs from reviewer answer
 *     on a question the reviewer has validated.
 *   - rule_disagreements: agent verdict differs from reviewer verdict on
 *     a rule the reviewer has adjudicated.
 *
 * Proposals land in `var/proposals/<task_id>/<proposal-id>.yaml` —
 * same dir convention as the phenotype and NER variants.
 */
import fs from "fs";
import path from "path";
import { runAgent } from "@chart-review/agent-provider";
import { PLATFORM_ROOT } from "@chart-review/patients";
import { guidelineDir } from "@chart-review/rubric";

function proposalsRoot(): string {
  return process.env.CHART_REVIEW_PROPOSALS_ROOT
    ?? path.join(PLATFORM_ROOT, "var", "proposals");
}

export interface ImproveAdherenceTaskOptions {
  task_id: string;
  /** Session-scoped reviews root (e.g. sessionReviewsRoot(sid) → <root>/var/reviews/<sessionId>).
   *  review_state.json is read at <reviewsRoot>/<pid>/<task_id>/review_state.json. Never the flat path. */
  reviewsRoot: string;
  patient_ids: string[];
  /** Optional: focus the analysis on a single question_id. */
  focus_question_id?: string;
}

export interface ImproveAdherenceTaskResult {
  ok: boolean;
  task_id: string;
  patients_analyzed: string[];
  proposals_dir: string;
  proposals: Array<{ proposal_id: string; path: string; size_bytes: number }>;
  proposal_count: number;
  error?: string;
  duration_ms: number;
  cost_usd?: number;
}

interface QuestionAnswerLite {
  question_id: string;
  answer: unknown;
  rationale?: string;
  confidence?: number;
  source?: string;
}

interface RuleVerdictLite {
  rule_id: string;
  verdict: string;
  rationale?: string;
  source?: string;
}

interface PerPatientDiff {
  patient_id: string;
  /** Only questions the reviewer has validated count as ground truth. */
  validated_questions: string[];
  validated_rules: string[];
  reviewer_question_answers: QuestionAnswerLite[];
  reviewer_rule_verdicts: RuleVerdictLite[];
  /** Per-agent disagreements with the reviewer's validated answers. */
  question_disagreements: Array<{
    agent_id: string;
    question_id: string;
    agent_answer: unknown;
    reviewer_answer: unknown;
    agent_rationale?: string;
    reviewer_rationale?: string;
    confidence?: number;
  }>;
  rule_disagreements: Array<{
    agent_id: string;
    rule_id: string;
    agent_verdict: string;
    reviewer_verdict: string;
    agent_rationale?: string;
    reviewer_rationale?: string;
  }>;
}

function normalize(v: unknown): unknown {
  if (v === undefined) return null;
  return v;
}
function sameAnswer(a: unknown, b: unknown): boolean {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

function buildPerPatientDiff(taskId: string, patientId: string, reviewsRoot: string): PerPatientDiff | null {
  const rsPath = path.join(reviewsRoot, patientId, taskId, "review_state.json");
  if (!fs.existsSync(rsPath)) return null;
  let rs: {
    question_answers?: QuestionAnswerLite[];
    rule_verdicts?: RuleVerdictLite[];
    validated_questions?: string[];
    validated_rules?: string[];
    agent_question_answers?: Record<string, QuestionAnswerLite[]>;
    agent_rule_verdicts?: Record<string, RuleVerdictLite[]>;
  };
  try { rs = JSON.parse(fs.readFileSync(rsPath, "utf8")); }
  catch { return null; }

  const reviewerQas = (rs.question_answers ?? []).filter((q) => q.source === "reviewer");
  const reviewerRvs = (rs.rule_verdicts  ?? []).filter((v) => v.source === "reviewer");
  const reviewerQaByQid = new Map(reviewerQas.map((q) => [q.question_id, q]));
  const reviewerRvByRid = new Map(reviewerRvs.map((v) => [v.rule_id, v]));
  const validatedQ = new Set(rs.validated_questions ?? []);
  const validatedR = new Set(rs.validated_rules ?? []);

  const qDis: PerPatientDiff["question_disagreements"] = [];
  const rDis: PerPatientDiff["rule_disagreements"] = [];

  for (const [agentId, draftQas] of Object.entries(rs.agent_question_answers ?? {})) {
    for (const aq of draftQas) {
      if (!validatedQ.has(aq.question_id)) continue;
      const rq = reviewerQaByQid.get(aq.question_id);
      if (!rq) continue;
      if (sameAnswer(aq.answer, rq.answer)) continue;
      qDis.push({
        agent_id: agentId,
        question_id: aq.question_id,
        agent_answer: aq.answer ?? null,
        reviewer_answer: rq.answer ?? null,
        agent_rationale: aq.rationale,
        reviewer_rationale: rq.rationale,
        confidence: aq.confidence,
      });
    }
  }
  for (const [agentId, draftRvs] of Object.entries(rs.agent_rule_verdicts ?? {})) {
    for (const av of draftRvs) {
      if (!validatedR.has(av.rule_id)) continue;
      const rv = reviewerRvByRid.get(av.rule_id);
      if (!rv) continue;
      if (av.verdict === rv.verdict) continue;
      rDis.push({
        agent_id: agentId,
        rule_id: av.rule_id,
        agent_verdict: av.verdict,
        reviewer_verdict: rv.verdict,
        agent_rationale: av.rationale,
        reviewer_rationale: rv.rationale,
      });
    }
  }

  return {
    patient_id: patientId,
    validated_questions: [...validatedQ],
    validated_rules: [...validatedR],
    reviewer_question_answers: reviewerQas,
    reviewer_rule_verdicts: reviewerRvs,
    question_disagreements: qDis,
    rule_disagreements: rDis,
  };
}

export async function improveAdherenceTask(
  opts: ImproveAdherenceTaskOptions,
): Promise<ImproveAdherenceTaskResult> {
  const startedAt = Date.now();
  if (!/^[a-z][a-z0-9-]+$/.test(opts.task_id)) {
    return {
      ok: false, task_id: opts.task_id, patients_analyzed: [],
      proposals_dir: "", proposals: [], proposal_count: 0,
      error: "task_id must be kebab-case", duration_ms: 0,
    };
  }
  const guidelinePath = guidelineDir(opts.task_id);
  if (!fs.existsSync(path.join(guidelinePath, "meta.yaml"))) {
    return {
      ok: false, task_id: opts.task_id, patients_analyzed: [],
      proposals_dir: "", proposals: [], proposal_count: 0,
      error: `task not found at ${guidelinePath}`, duration_ms: 0,
    };
  }

  const diffs: PerPatientDiff[] = [];
  const missing: string[] = [];
  for (const pid of opts.patient_ids) {
    if (!/^[a-zA-Z0-9_-]+$/.test(pid)) {
      return {
        ok: false, task_id: opts.task_id, patients_analyzed: [],
        proposals_dir: "", proposals: [], proposal_count: 0,
        error: `invalid patient_id: ${pid}`, duration_ms: 0,
      };
    }
    const d = buildPerPatientDiff(opts.task_id, pid, opts.reviewsRoot);
    if (!d) missing.push(pid); else diffs.push(d);
  }
  if (missing.length > 0) {
    return {
      ok: false, task_id: opts.task_id, patients_analyzed: [],
      proposals_dir: "", proposals: [], proposal_count: 0,
      error: `no review_state.json for: ${missing.join(", ")}`,
      duration_ms: 0,
    };
  }

  // Quick exit when there's literally nothing to cluster — saves the
  // round-trip to the LLM and gives the UI a deterministic "no signal"
  // message instead of "agent found nothing".
  const totalQ = diffs.reduce((n, d) => n + d.question_disagreements.length, 0);
  const totalR = diffs.reduce((n, d) => n + d.rule_disagreements.length, 0);
  const validatedTotal = diffs.reduce(
    (n, d) => n + d.validated_questions.length + d.validated_rules.length,
    0,
  );
  if (validatedTotal === 0) {
    return {
      ok: false, task_id: opts.task_id, patients_analyzed: diffs.map((d) => d.patient_id),
      proposals_dir: "", proposals: [], proposal_count: 0,
      error: "no validated questions or rules across cohort — accept or override at least one question in AdherenceReview first",
      duration_ms: Date.now() - startedAt,
    };
  }

  const proposalsDir = path.join(proposalsRoot(), opts.task_id);
  fs.mkdirSync(proposalsDir, { recursive: true });
  const before = new Set(
    fs.existsSync(proposalsDir)
      ? fs.readdirSync(proposalsDir).filter((n) => n.endsWith(".yaml"))
      : [],
  );

  // Per-question disagreement counts across the cohort so the agent can
  // see at a glance which questions are noisiest. Same idea as NER's
  // aggCounts.
  const qCounts = new Map<string, { agents: Set<string>; n: number }>();
  for (const d of diffs) {
    for (const x of d.question_disagreements) {
      const cur = qCounts.get(x.question_id) ?? { agents: new Set(), n: 0 };
      cur.agents.add(x.agent_id);
      cur.n++;
      qCounts.set(x.question_id, cur);
    }
  }
  const rCounts = new Map<string, { agents: Set<string>; n: number }>();
  for (const d of diffs) {
    for (const x of d.rule_disagreements) {
      const cur = rCounts.get(x.rule_id) ?? { agents: new Set(), n: 0 };
      cur.agents.add(x.agent_id);
      cur.n++;
      rCounts.set(x.rule_id, cur);
    }
  }

  const userPrompt = [
    "Use the `chart-review-adherence-improve` skill to analyze the diffs below and propose concrete edits to the questions / rules.",
    "",
    `Task: ${opts.task_id} (task_kind=adherence)`,
    `Task path: ${path.relative(PLATFORM_ROOT, guidelinePath)}`,
    `Questions dir: ${path.relative(PLATFORM_ROOT, path.join(guidelinePath, "references/questions"))}`,
    `Rules dir: ${path.relative(PLATFORM_ROOT, path.join(guidelinePath, "references/rules"))}`,
    `Proposals output dir: ${path.relative(PLATFORM_ROOT, proposalsDir)}`,
    "",
    opts.focus_question_id
      ? `## Focus question\n${opts.focus_question_id}\n`
      : "## Focus\nAll questions and rules.\n",
    "",
    "## Summary",
    `- ${diffs.length} patient${diffs.length === 1 ? "" : "s"} analyzed`,
    `- ${validatedTotal} reviewer-validated answers/verdicts (ground truth)`,
    `- ${totalQ} question disagreement${totalQ === 1 ? "" : "s"} (agent vs reviewer)`,
    `- ${totalR} rule disagreement${totalR === 1 ? "" : "s"} (agent vs reviewer)`,
    "",
    "## Question disagreement aggregate (across cohort)",
    "Format: question_id → n disagreements (across A agents).",
    ...[...qCounts.entries()]
      .sort((a, b) => b[1].n - a[1].n)
      .map(([qid, c]) => `  - ${qid}: ${c.n} disagreement${c.n === 1 ? "" : "s"} (${c.agents.size} agent${c.agents.size === 1 ? "" : "s"})`),
    qCounts.size === 0 ? "  (none — every validated question matched all agents)" : "",
    "",
    "## Rule disagreement aggregate (across cohort)",
    ...[...rCounts.entries()]
      .sort((a, b) => b[1].n - a[1].n)
      .map(([rid, c]) => `  - ${rid}: ${c.n} disagreement${c.n === 1 ? "" : "s"} (${c.agents.size} agent${c.agents.size === 1 ? "" : "s"})`),
    rCounts.size === 0 ? "  (none — every adjudicated rule matched all agents)" : "",
    "",
    "## Per-patient diff (the input you reason over)",
    "",
    "For each patient, the diff shows ONLY questions / rules the reviewer has validated. `agent_question_answers` and `agent_rule_verdicts` are the per-agent drafts captured at import time; reviewer-validated answers are in `reviewer_question_answers` (source=reviewer rows from review_state.question_answers).",
    "",
    "```json",
    JSON.stringify(diffs, null, 2),
    "```",
    "",
    "## What to do",
    "",
    "1. Cluster the disagreements by `question_id` (or `rule_id`). A cluster with ≥2 patients OR ≥2 agents on the same question, OR 1 striking single-shot, becomes a proposal.",
    "2. For each cluster, decide the cheapest fix to the question/rule YAML:",
    "   - **Sharper `retrieval_hints`**: if the agent missed evidence in a section that exists in chart but isn't named in hints (e.g., 'visit summaries also have prednisone bursts → add to hints').",
    "   - **Tighter `text`**: if the disagreement is semantic (agent and reviewer interpret the question differently — typically null vs 0, or 'no documentation' vs 'documented as absent').",
    "   - **Stricter `answer_schema`**: if the agent emits invalid values (out-of-range, wrong type).",
    "   - **Missing `depends_on`**: if the agent answered a question whose precondition wasn't actually met (e.g., asthma exacerbations without an asthma diagnosis).",
    "   - **Rule logic edit**: if the agent's verdict on a rule doesn't follow from its own question answers — the rule formula or attribution criteria need tightening.",
    "3. Write ONE proposal YAML per cluster at the proposals output dir. Each proposal must include:",
    "   - `proposal_id`: short kebab-case slug",
    "   - `target_file`: relative path to the questions/<tier>_*.yaml or rules/*.yaml it patches",
    "   - `change_kind`: one of edit_retrieval_hints / edit_question_text / edit_answer_schema / add_depends_on / edit_rule",
    "   - `question_id` or `rule_id`: the target",
    "   - `evidence`: { patient_ids: [...], examples: [{question_id, agent_answer, reviewer_answer, agent_rationale, reviewer_rationale}] }",
    "   - `proposed_patch`: minimal YAML delta (or text of the new field value)",
    "   - `rationale`: 2–4 sentences explaining why this edit prevents the disagreement next iter",
    "",
    "Do NOT modify files under the task's `references/` directly. Proposals only.",
    "",
    "**If after surveying every cluster you find nothing worth proposing**, that's a valid outcome — write zero proposals and emit a `text` summary explaining WHY (e.g., \"every disagreement was on confidence < 0.6 with sparse evidence; no cluster reached the threshold\"). Don't fabricate.",
  ].filter(Boolean).join("\n");

  let cost: number | undefined;
  let success = false;
  let errorMessage: string | undefined;
  const transcriptPath = path.join(
    PLATFORM_ROOT, "var", "logs", "adherence-improvement",
    `${opts.task_id}-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
  );

  try {
    for await (const event of runAgent({
      prompt: userPrompt,
      cwd: PLATFORM_ROOT,
      taskId: opts.task_id,
      guidelinePath,
      extraTools: ["Write"],
      maxTurns: 60,
      permissionMode: "acceptEdits",
      transcriptPath,
      extraSystemPrompt:
        "Activate the `chart-review-adherence-improve` skill via the Skill tool. "
        + "Follow its procedure to cluster the diff into proposed question / rule edits. "
        + "Each proposal goes to a separate YAML file at the proposals output directory "
        + "provided in the user message; never modify files under the task's `references/` "
        + "directory directly.",
    })) {
      if (event.type === "result") {
        success = event.subtype === undefined || event.subtype === "success";
        cost = event.cost_usd;
        if (success) errorMessage = undefined;
      } else if (event.type === "error") {
        errorMessage = event.error;
      }
    }
  } catch (e) {
    errorMessage = (e as Error).message;
  }

  const after = fs.existsSync(proposalsDir)
    ? fs.readdirSync(proposalsDir).filter((n) => n.endsWith(".yaml"))
    : [];
  const newProposals = after.filter((n) => !before.has(n)).map((n) => {
    const fp = path.join(proposalsDir, n);
    const stat = fs.statSync(fp);
    return { proposal_id: n.replace(/\.yaml$/, ""), path: fp, size_bytes: stat.size };
  });

  return {
    ok: success && !errorMessage,
    task_id: opts.task_id,
    patients_analyzed: diffs.map((d) => d.patient_id),
    proposals_dir: proposalsDir,
    proposals: newProposals,
    proposal_count: newProposals.length,
    error: errorMessage,
    duration_ms: Date.now() - startedAt,
    cost_usd: cost,
  };
}
