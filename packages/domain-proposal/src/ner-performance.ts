/**
 * Per-iter NER performance against reviewer-validated spans.
 *
 * For each agent in a pilot iter, computes precision / recall / F1
 * against the reviewer's validated review_state.json — overall and
 * broken down by entity_type. Used by the DECIDE phase UI to show
 * methodologists how well each agent did this round.
 *
 * Matching semantics:
 *   - Spans are joined by span_id (hash of note_id+start+end+entity_type).
 *   - Only spans inside validated_notes count as ground truth — spans in
 *     unvalidated notes are silently dropped from both sides so they
 *     don't pollute the metrics.
 *   - TP = agent span that survived reviewer validation unchanged
 *   - FP = agent span the reviewer deleted (no matching span_id in review_state)
 *   - FN = reviewer span that no agent proposed
 *   - concept_edits = same span_id survived but reviewer changed concept_name
 *     (counted separately; not folded into TP/FP/FN since the boundary was right)
 */
import fs from "fs";
import path from "path";
import { PLATFORM_ROOT } from "@chart-review/patients";
import { runDir } from "@chart-review/infra-batch-run";

function reviewsRoot(): string {
  return process.env.CHART_REVIEW_REVIEWS_ROOT
    ?? path.join(PLATFORM_ROOT, "var", "reviews");
}

interface SpanLite {
  span_id: string;
  note_id: string;
  entity_type: string;
  concept_name?: string;
  proposed_by?: string[];
}

function pickSpan(s: { [k: string]: unknown }): SpanLite {
  return {
    span_id: String(s.span_id ?? ""),
    note_id: String(s.note_id ?? ""),
    entity_type: String(s.entity_type ?? ""),
    concept_name: typeof s.concept_name === "string" ? s.concept_name : undefined,
    proposed_by: Array.isArray(s.proposed_by) ? (s.proposed_by as string[]) : undefined,
  };
}

export interface AgentCounts {
  tp: number;
  fp: number;
  fn: number;
  concept_edits: number;
}

export interface AgentMetrics extends AgentCounts {
  precision: number;
  recall: number;
  f1: number;
}

export interface EntityTypeMetrics extends AgentMetrics {
  entity_type: string;
}

export interface AgentReport {
  agent_id: string;
  overall: AgentMetrics;
  by_entity_type: EntityTypeMetrics[];
}

export interface PerformanceReport {
  iter_id: string;
  run_id: string;
  task_id: string;
  patients_total: number;
  patients_with_validation: number;
  agents: AgentReport[];
}

function safeDiv(num: number, denom: number): number {
  return denom === 0 ? 0 : num / denom;
}

function toMetrics(c: AgentCounts): AgentMetrics {
  const precision = safeDiv(c.tp, c.tp + c.fp);
  const recall = safeDiv(c.tp, c.tp + c.fn);
  const f1 = safeDiv(2 * precision * recall, precision + recall);
  return {
    ...c,
    precision: Math.round(precision * 100) / 100,
    recall: Math.round(recall * 100) / 100,
    f1: Math.round(f1 * 100) / 100,
  };
}

function loadAgentSpansForRun(
  runId: string,
  patientId: string,
): Array<{ agent_id: string; spans: SpanLite[] }> {
  const dir = path.join(runDir(runId), "per_patient", patientId, "agents");
  if (!fs.existsSync(dir)) return [];
  const out: Array<{ agent_id: string; spans: SpanLite[] }> = [];
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith(".json") || f.endsWith("_transcript.jsonl")) continue;
    const agentId = f.replace(/\.json$/, "");
    try {
      const draft = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as {
        span_labels?: Array<{ [k: string]: unknown }>;
      };
      out.push({ agent_id: agentId, spans: (draft.span_labels ?? []).map(pickSpan) });
    } catch { /* skip malformed */ }
  }
  return out;
}

function loadReviewerSpans(
  taskId: string,
  patientId: string,
): { spans: SpanLite[]; validated_notes: Set<string> } | null {
  const rsPath = path.join(reviewsRoot(), patientId, taskId, "review_state.json");
  if (!fs.existsSync(rsPath)) return null;
  try {
    const rs = JSON.parse(fs.readFileSync(rsPath, "utf8")) as {
      span_labels?: Array<{ [k: string]: unknown }>;
      validated_notes?: string[];
    };
    return {
      spans: (rs.span_labels ?? []).map(pickSpan),
      validated_notes: new Set(rs.validated_notes ?? []),
    };
  } catch {
    return null;
  }
}

export function computeNerPerformance(
  taskId: string,
  iterId: string,
  runId: string,
  patientIds: string[],
): PerformanceReport {
  // counters: agent_id → entity_type → AgentCounts (and "__overall__" key
  // for the cross-entity-type aggregate).
  const counters = new Map<string, Map<string, AgentCounts>>();

  let patientsWithValidation = 0;

  function bump(agentId: string, entityType: string, field: keyof AgentCounts) {
    if (!counters.has(agentId)) counters.set(agentId, new Map());
    const perType = counters.get(agentId)!;
    for (const key of [entityType, "__overall__"]) {
      const existing = perType.get(key) ?? { tp: 0, fp: 0, fn: 0, concept_edits: 0 };
      existing[field] += 1;
      perType.set(key, existing);
    }
  }

  for (const pid of patientIds) {
    const reviewer = loadReviewerSpans(taskId, pid);
    if (!reviewer || reviewer.validated_notes.size === 0) continue;
    patientsWithValidation++;

    // Restrict reviewer spans to validated notes.
    const reviewerSpans = reviewer.spans.filter((s) => reviewer.validated_notes.has(s.note_id));
    const reviewerById = new Map(reviewerSpans.map((s) => [s.span_id, s]));

    const agentDrafts = loadAgentSpansForRun(runId, pid);
    if (agentDrafts.length === 0) continue;

    for (const { agent_id, spans } of agentDrafts) {
      // Restrict agent spans to validated notes too.
      const agentSpans = spans.filter((s) => reviewer.validated_notes.has(s.note_id));
      const agentIds = new Set(agentSpans.map((s) => s.span_id));

      for (const s of agentSpans) {
        const r = reviewerById.get(s.span_id);
        if (!r) {
          bump(agent_id, s.entity_type, "fp");
        } else if (
          r.concept_name !== undefined
          && s.concept_name !== undefined
          && r.concept_name !== s.concept_name
        ) {
          // boundary right, concept wrong — still a TP for span-detection,
          // but counted as a concept edit too.
          bump(agent_id, s.entity_type, "tp");
          bump(agent_id, s.entity_type, "concept_edits");
        } else {
          bump(agent_id, s.entity_type, "tp");
        }
      }
      for (const r of reviewerSpans) {
        if (!agentIds.has(r.span_id)) {
          bump(agent_id, r.entity_type, "fn");
        }
      }
    }
  }

  // Build the report from the counter map.
  const agentReports: AgentReport[] = [];
  for (const [agentId, perType] of [...counters.entries()].sort()) {
    const overallCounts = perType.get("__overall__") ?? { tp: 0, fp: 0, fn: 0, concept_edits: 0 };
    const byType: EntityTypeMetrics[] = [];
    for (const [et, counts] of [...perType.entries()].sort()) {
      if (et === "__overall__") continue;
      byType.push({ entity_type: et, ...toMetrics(counts) });
    }
    agentReports.push({
      agent_id: agentId,
      overall: toMetrics(overallCounts),
      by_entity_type: byType,
    });
  }

  return {
    iter_id: iterId,
    run_id: runId,
    task_id: taskId,
    patients_total: patientIds.length,
    patients_with_validation: patientsWithValidation,
    agents: agentReports,
  };
}
