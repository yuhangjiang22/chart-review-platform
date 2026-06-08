/**
 * NER guideline-improvement driver.
 *
 * Parallel to guideline-improvement.ts but for task_kind="ner". The
 * agent receives BOTH sources for each patient:
 *
 *   - the raw agent drafts at runs/<latest>/per_patient/<pid>/agents/agent_*.json
 *   - the reviewer-validated review_state.json at reviews/<pid>/<task>/review_state.json
 *
 * From the diff between these two sets, the agent classifies each span
 * disagreement (deleted / added / concept-edited / status-edited),
 * clusters by entity_type, and writes proposals targeting
 * `references/entity_type_guidance/<entity_type>.yaml` in the scope
 * skill. Proposals land in `var/proposals/<task_id>/<proposal-id>.yaml`
 * — same dir convention as the phenotype variant.
 */
import fs from "fs";
import path from "path";
import { runAgent } from "@chart-review/agent-provider";
import { PLATFORM_ROOT } from "@chart-review/patients";
import { guidelineDir } from "@chart-review/rubric";
import { listRuns, runDir } from "@chart-review/infra-batch-run";

function proposalsRoot(): string {
  return process.env.CHART_REVIEW_PROPOSALS_ROOT
    ?? path.join(PLATFORM_ROOT, "var", "proposals");
}

export interface ImproveNerTaskOptions {
  task_id: string;
  /** Session-scoped reviews root (e.g. sessionReviewsRoot(sid) → <root>/var/reviews/<sessionId>).
   *  review_state.json is read at <reviewsRoot>/<pid>/<task_id>/review_state.json. Never the flat path. */
  reviewsRoot: string;
  patient_ids: string[];
  /** Optional: focus the analysis on a single entity_type (e.g. "Dementia"). */
  focus_entity_type?: string;
}

export interface ImproveNerTaskResult {
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

interface SpanLite {
  span_id: string;
  note_id: string;
  text: string;
  entity_type: string;
  concept_name?: string;
  status?: string;
  proposed_by?: string[];
}

interface PerPatientDiff {
  patient_id: string;
  validated_notes: string[];
  agent_drafts: Array<{ agent_id: string; spans: SpanLite[] }>;
  reviewer_spans: SpanLite[];
  /** Spans an agent proposed that the reviewer DELETED (in agent draft, not in review_state). */
  deleted_by_reviewer: Array<{ span: SpanLite; deleted_from: string[] }>;
  /** Spans the reviewer ADDED that no agent proposed (proposed_by includes "reviewer", excludes agents). */
  added_by_reviewer: SpanLite[];
  /** Spans where reviewer changed concept_name from what the agent first proposed. */
  concept_name_edited: Array<{ span_id: string; agent_concept: string; reviewer_concept: string; entity_type: string; note_id: string; text: string }>;
}

function pickSpanLite(s: { [k: string]: unknown }): SpanLite {
  return {
    span_id: String(s.span_id ?? ""),
    note_id: String(s.note_id ?? ""),
    text: String(s.text ?? ""),
    entity_type: String(s.entity_type ?? ""),
    concept_name: typeof s.concept_name === "string" ? s.concept_name : undefined,
    status: typeof s.status === "string" ? s.status : undefined,
    proposed_by: Array.isArray(s.proposed_by) ? (s.proposed_by as string[]) : undefined,
  };
}

function latestRunForTaskWithPatient(taskId: string, patientId: string): string | null {
  const runs = listRuns({ task_id: taskId });
  for (const r of runs.sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""))) {
    const dir = path.join(runDir(r.run_id), "per_patient", patientId, "agents");
    if (fs.existsSync(dir)) {
      const hasAgent = fs.readdirSync(dir).some((f) => f.endsWith(".json"));
      if (hasAgent) return r.run_id;
    }
  }
  return null;
}

function loadAgentDrafts(runId: string, patientId: string): Array<{ agent_id: string; spans: SpanLite[] }> {
  const dir = path.join(runDir(runId), "per_patient", patientId, "agents");
  if (!fs.existsSync(dir)) return [];
  const out: Array<{ agent_id: string; spans: SpanLite[] }> = [];
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith(".json")) continue;
    const agentId = f.replace(/\.json$/, "");
    try {
      const draft = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as {
        span_labels?: Array<{ [k: string]: unknown }>;
      };
      const spans = (draft.span_labels ?? []).map(pickSpanLite);
      out.push({ agent_id: agentId, spans });
    } catch { /* skip malformed */ }
  }
  return out;
}

function computeDiff(
  agentDrafts: Array<{ agent_id: string; spans: SpanLite[] }>,
  reviewerSpans: SpanLite[],
): Pick<PerPatientDiff, "deleted_by_reviewer" | "added_by_reviewer" | "concept_name_edited"> {
  const reviewerById = new Map(reviewerSpans.map((s) => [s.span_id, s]));
  const deleted_by_reviewer: PerPatientDiff["deleted_by_reviewer"] = [];
  const concept_name_edited: PerPatientDiff["concept_name_edited"] = [];

  // For each agent's span, classify: kept / deleted / concept-edited
  const seenDeletedIds = new Set<string>();
  for (const draft of agentDrafts) {
    for (const s of draft.spans) {
      const inReview = reviewerById.get(s.span_id);
      if (!inReview) {
        // Span absent from review_state — reviewer deleted it (or never imported).
        if (seenDeletedIds.has(s.span_id)) {
          // Already tagged this span as deleted from another agent — extend the list.
          const existing = deleted_by_reviewer.find((d) => d.span.span_id === s.span_id);
          if (existing && !existing.deleted_from.includes(draft.agent_id)) {
            existing.deleted_from.push(draft.agent_id);
          }
          continue;
        }
        seenDeletedIds.add(s.span_id);
        deleted_by_reviewer.push({ span: s, deleted_from: [draft.agent_id] });
      } else if (
        inReview.concept_name !== undefined
        && s.concept_name !== undefined
        && inReview.concept_name !== s.concept_name
      ) {
        // Same span survived but reviewer changed concept_name.
        // Only record once per span_id (first agent we see).
        if (!concept_name_edited.find((e) => e.span_id === s.span_id)) {
          concept_name_edited.push({
            span_id: s.span_id,
            agent_concept: s.concept_name,
            reviewer_concept: inReview.concept_name,
            entity_type: s.entity_type,
            note_id: s.note_id,
            text: s.text,
          });
        }
      }
    }
  }
  // Reviewer-added spans: in review_state but no agent draft has the same span_id,
  // OR proposed_by lists "reviewer" only.
  const agentIds = new Set<string>();
  for (const draft of agentDrafts) {
    for (const s of draft.spans) agentIds.add(s.span_id);
  }
  const added_by_reviewer: SpanLite[] = reviewerSpans.filter(
    (s) =>
      !agentIds.has(s.span_id)
      || (Array.isArray(s.proposed_by)
        && s.proposed_by.length === 1
        && s.proposed_by[0] === "reviewer"),
  );
  return { deleted_by_reviewer, added_by_reviewer, concept_name_edited };
}

function buildPerPatientDiff(taskId: string, patientId: string, reviewsRoot: string): PerPatientDiff | null {
  const runIdOrNull = latestRunForTaskWithPatient(taskId, patientId);
  const agent_drafts = runIdOrNull ? loadAgentDrafts(runIdOrNull, patientId) : [];
  const rsPath = path.join(reviewsRoot, patientId, taskId, "review_state.json");
  if (!fs.existsSync(rsPath)) return null;
  const rs = JSON.parse(fs.readFileSync(rsPath, "utf8")) as {
    span_labels?: Array<{ [k: string]: unknown }>;
    validated_notes?: string[];
  };
  const reviewer_spans = (rs.span_labels ?? []).map(pickSpanLite);
  const validated_notes = rs.validated_notes ?? [];
  const diff = computeDiff(agent_drafts, reviewer_spans);
  return {
    patient_id: patientId,
    validated_notes,
    agent_drafts,
    reviewer_spans,
    ...diff,
  };
}

export async function improveNerTask(
  opts: ImproveNerTaskOptions,
): Promise<ImproveNerTaskResult> {
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

  const proposalsDir = path.join(proposalsRoot(), opts.task_id);
  fs.mkdirSync(proposalsDir, { recursive: true });
  const before = new Set(
    fs.existsSync(proposalsDir)
      ? fs.readdirSync(proposalsDir).filter((n) => n.endsWith(".yaml"))
      : [],
  );

  // Aggregate entity_type counts across the diff so the agent can see
  // which subtrees are noisiest at a glance.
  const aggCounts = new Map<string, { deleted: number; added: number; edited: number }>();
  function bump(et: string, k: "deleted" | "added" | "edited") {
    const cur = aggCounts.get(et) ?? { deleted: 0, added: 0, edited: 0 };
    cur[k]++;
    aggCounts.set(et, cur);
  }
  for (const d of diffs) {
    for (const x of d.deleted_by_reviewer) bump(x.span.entity_type, "deleted");
    for (const x of d.added_by_reviewer) bump(x.entity_type, "added");
    for (const x of d.concept_name_edited) bump(x.entity_type, "edited");
  }

  const userPrompt = [
    "Use the `chart-review-ner-improve` skill to analyze the diffs below and propose concrete annotation-guidance edits.",
    "",
    `Task: ${opts.task_id} (task_kind=ner)`,
    `Task path: ${path.relative(PLATFORM_ROOT, guidelinePath)}`,
    `Per-entity-type guidance dir: ${path.relative(PLATFORM_ROOT, path.join(guidelinePath, "references/entity_type_guidance"))}`,
    `Proposals output dir: ${path.relative(PLATFORM_ROOT, proposalsDir)}`,
    "",
    opts.focus_entity_type
      ? `## Focus entity_type\n${opts.focus_entity_type}\n`
      : "## Focus\nAll entity types.\n",
    "",
    "## Entity-type disagreement aggregate (across cohort)",
    "Format: entity_type → deleted (agent emitted, reviewer removed) / added (reviewer added, no agent had it) / edited (concept_name changed by reviewer).",
    ...[...aggCounts.entries()]
      .sort((a, b) =>
        (b[1].deleted + b[1].added + b[1].edited)
        - (a[1].deleted + a[1].added + a[1].edited),
      )
      .map(([et, c]) => `  - ${et}: ${c.deleted} deleted, ${c.added} added, ${c.edited} edited`),
    "",
    "## Per-patient diff (the input you reason over)",
    "",
    "For each patient, you receive BOTH the raw agent drafts AND the reviewer-validated review_state. The diff has been pre-computed:",
    "  - `deleted_by_reviewer`: spans the agent emitted but the reviewer removed (false positives)",
    "  - `added_by_reviewer`: spans the reviewer added manually that no agent proposed (false negatives)",
    "  - `concept_name_edited`: spans where reviewer kept the boundary but changed the concept_name (mapping errors)",
    "Only spans within `validated_notes[]` count as ground truth — spans in notes the reviewer hasn't validated yet have no signal.",
    "",
    "```json",
    JSON.stringify(diffs, null, 2),
    "```",
    "",
    "## What to do",
    "",
    "1. Cluster the disagreements by `entity_type`. A cluster with ≥2 spans across the cohort, OR 1 striking concept-name edit, becomes a proposal.",
    "2. For each cluster, decide the cheapest fix:",
    "   - false positives clustering on a pattern → add to `negative_examples` in that entity_type's YAML",
    "   - false negatives clustering on a pattern → add to `exemplars`",
    "   - concept-name edits clustering on the same surface form → either `add_concept_alias` (if the reviewer's concept exists in the ontology) or `edit_guidance` prose",
    "   - novel edge cases that don't fit any of the above → add to `edge_cases`",
    "3. Write ONE proposal YAML per cluster at the proposals output dir. Each proposal must include:",
    "   - `proposal_id`: short kebab-case slug",
    "   - `target_file`: relative path to the entity_type YAML it patches",
    "   - `change_kind`: one of add_negative_example / add_exemplar / add_edge_case / edit_guidance / add_concept_alias",
    "   - `entity_type`: the entity type the cluster targets",
    "   - `evidence`: { patient_ids: [...], span_examples: [{note_id, text, agent_concept?, reviewer_concept?, reason?}] }",
    "   - `proposed_patch`: minimal YAML delta",
    "   - `rationale`: 2–4 sentences explaining why this edit prevents the disagreement next iter",
    "",
    "Do NOT modify files under the task's `references/entity_type_guidance/` directly. Proposals only.",
    "",
    "**If after surveying every entity type's diff you find nothing worth proposing**, that's a valid outcome — write zero proposals and emit a `text` summary explaining WHY (e.g., \"every disagreement was a one-off; no clusters reached the threshold\"). Don't fabricate.",
  ].join("\n");

  let cost: number | undefined;
  let success = false;
  let errorMessage: string | undefined;
  const transcriptPath = path.join(
    PLATFORM_ROOT, "var", "logs", "ner-improvement",
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
        "Activate the `chart-review-ner-improve` skill via the Skill tool. "
        + "Follow its procedure to cluster the diff into proposed annotation-guidance "
        + "edits. Each proposal goes to a separate YAML file at the proposals output "
        + "directory provided in the user message; never modify files under the task's "
        + "`references/` directory directly.",
    })) {
      if (event.type === "result") {
        // Per AgentEvent docs: subtype is Anthropic-specific. Codex
        // doesn't set it — treat undefined as success. A result event
        // always supersedes any mid-stream error events; transient
        // events like content-filter blips during a reconnect are
        // recoverable, so clear errorMessage when the run completes.
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
