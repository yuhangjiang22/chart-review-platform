/**
 * Direct-LLM adherence extractor.
 *
 * Patient-level, NOT note-level (unlike NER): the model reasons across
 * the whole chart. Three serialized passes:
 *
 *   1. Tier 0 (eligibility) — answer T0 questions from the full chart.
 *      If the deterministic eligibility rule fails, skip T1+ and return.
 *   2. Tier 1+ (assessment, management, …) — for each tier in order,
 *      one LLM call. Prompt includes earlier tiers' QuestionAnswers as
 *      structured JSON so the model doesn't re-derive them.
 *   3. Rule eval — pure Node, no LLM (unless rule.nuanced).
 *
 * Token economy: the SYSTEM prompt is identical across all tier calls
 * within one run (skill metadata + ontology + attribution enum), so
 * Azure prompt-cache covers the prefix. Each tier's USER prompt grows
 * by the previous tier's structured answers (small JSON), not by
 * re-pasting notes.
 *
 * Note concatenation: notes are concatenated once with delimiter
 * headers and reused via prompt cache for every tier call. For very
 * large charts (>~50k tokens) a retriever pass should narrow this; we
 * defer that until phase 2 (it's a per-question retrieval_hints loop).
 */

import { listNotes, readNote } from "@chart-review/patients";
import type { QuestionAnswer, RuleVerdict } from "@chart-review/platform-types";
import type { CompiledTask } from "@chart-review/tasks";
import { evaluateAllRules } from "@chart-review/rule-engine";
import type { LlmJudgeRequest, LlmJudgeResponse } from "@chart-review/rule-engine";
import { loadAdherenceSkill, type AdherenceSkill, type QuestionDefinition } from "./skill-loader.js";

export interface DirectAdherenceExtractOpts {
  patientId: string;
  task: CompiledTask;
  /** Which LLM backend to use. "codex" → Azure Responses API (uses
   *  azureBaseUrl + azureApiKey). "claude" → @anthropic-ai/claude-agent-sdk's
   *  query() with no MCP servers and no tools — authenticates via the
   *  caller's Claude Code session so no ANTHROPIC_API_KEY is needed.
   *  Defaults to "codex" for backwards compatibility. */
  provider?: "codex" | "claude";
  azureBaseUrl?: string;
  azureApiKey?: string;
  model?: string;
  /** When true and the deterministic eligibility rule fails, skip
   *  later tiers. Default true. */
  gateOnEligibility?: boolean;
  /** Optional: an alternative model id for the nuanced LLM judge.
   *  When unset, reuses `model`. */
  judgeModel?: string;
}

export interface DirectAdherenceExtractResult {
  ok: boolean;
  question_answers: QuestionAnswer[];
  rule_verdicts: RuleVerdict[];
  excluded?: boolean;
  exclusion_reason?: string;
  usage_by_tier: Record<number, AzureUsage>;
  judge_usage?: AzureUsage[];
  errors: string[];
}

interface AzureUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
}

interface AzureResponse {
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
  usage?: AzureUsage;
  error?: { message?: string };
}

function buildNotesBlob(patientId: string): string {
  const notes = listNotes(patientId);
  const parts: string[] = [];
  for (const n of notes) {
    let body = "";
    try {
      body = readNote(patientId, n.filename);
    } catch { continue; }
    const noteId = n.filename.replace(/\.txt$/, "");
    const header = `--- NOTE id=${noteId}` +
      (n.date ? ` date=${n.date}` : "") +
      (n.doctype ? ` doctype=${n.doctype}` : "") + " ---";
    parts.push(`${header}\n${body}`);
  }
  return parts.join("\n\n");
}

function schemaHint(q: QuestionDefinition): string {
  const s = q.answer_schema;
  if (!s) return "string|number|boolean|null";
  if (s.enum) return `one of: ${s.enum.map((v) => JSON.stringify(v)).join(", ")} (or null)`;
  if (s.type === "boolean") return "true | false | null";
  if (s.type === "number") return "number | null";
  if (s.type === "string") return "string | null";
  return "string|number|boolean|null";
}

function buildSystemPrompt(skill: AdherenceSkill): string {
  return [
    "You are a structured-extraction backend for a clinical-adherence audit pipeline.",
    `Task id: ${skill.task_id}.`,
    "",
    "OUTPUT CONTRACT — STRICTLY ENFORCED",
    "Your ENTIRE response is a single JSON object. The FIRST character of your",
    "reply MUST be `{`. No preamble, no prose explanation, no markdown fences,",
    "no \"Looking at the chart\" sentences, no closing commentary. Anything other",
    "than valid JSON breaks the parser and fails the patient.",
    "",
    "JSON shape:",
    `  { "answers": [`,
    `      { "question_id": "<id from the user's list>",`,
    `        "answer": <typed value matching the question's schema, or null>,`,
    `        "confidence": <0..1>,`,
    `        "evidence": [{ "note_id": "<id>", "quote": "<verbatim substring>" }],`,
    `        "reasoning": "<one or two sentences>",`,
    `        "verifier_status": "confirmed" | "contradicted" | "no_check" }`,
    "  ] }",
    "",
    "Answer rules:",
    "- `answer` MUST match the question's schema (boolean → true/false/null, number → number/null, enum → one of the listed strings, string → string/null).",
    "- Use `answer: null` when the chart does not support an answer. Never guess.",
    "- `evidence.quote` must be a verbatim substring of the cited note.",
    "- Order answers exactly as listed in the user message; include every question_id.",
    "",
    "Attribution vocabulary (for downstream rule evaluation, do not infer here):",
    skill.attribution_categories.map((c) => `  - ${c}`).join("\n"),
    "",
    "REMINDER: Start with `{`. End with `}`. Nothing else.",
  ].join("\n");
}

function buildTierUserPrompt(args: {
  patientId: string;
  tier: number;
  questions: QuestionDefinition[];
  notesBlob: string;
  priorAnswers: QuestionAnswer[];
  isFirstTier: boolean;
}): string {
  const { patientId, tier, questions, notesBlob, priorAnswers, isFirstTier } = args;
  const sections: string[] = [];
  sections.push(`Patient: ${patientId}`);
  sections.push(`Tier ${tier} — ${tier === 0 ? "eligibility" : tier === 1 ? "assessment" : "management/treatment"}`);
  sections.push("");
  if (isFirstTier) {
    sections.push("--- CHART (verbatim notes) ---");
    sections.push(notesBlob);
    sections.push("--- END CHART ---");
    sections.push("");
  } else {
    sections.push("(Use the same chart you saw on prior turns.)");
    sections.push("");
    sections.push("--- EARLIER TIER ANSWERS ---");
    sections.push(JSON.stringify(priorAnswers.map((a) => ({
      question_id: a.question_id, tier: a.tier, answer: a.answer,
    })), null, 2));
    sections.push("--- END EARLIER TIER ANSWERS ---");
    sections.push("");
  }
  sections.push("Questions for this tier:");
  for (const q of questions) {
    const hint = q.retrieval_hints ? `\n    hint: ${q.retrieval_hints}` : "";
    sections.push(`- [${q.question_id}] ${q.text}\n    answer: ${schemaHint(q)}${hint}`);
  }
  sections.push("");
  sections.push("Return the JSON object now.");
  return sections.join("\n");
}

interface RawAnswer {
  question_id?: string;
  answer?: unknown;
  confidence?: number;
  evidence?: Array<{ note_id?: string; quote?: string; start?: number; end?: number }>;
  reasoning?: string;
  verifier_status?: "confirmed" | "contradicted" | "no_check";
}

function parseAnswers(text: string): RawAnswer[] {
  let s = text.trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) s = fence[1]!.trim();
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) return parsed as RawAnswer[];
    if (parsed && Array.isArray((parsed as { answers?: RawAnswer[] }).answers)) {
      return (parsed as { answers: RawAnswer[] }).answers;
    }
  } catch { /* fall through */ }
  return [];
}

/**
 * Claude-Code-SDK round-trip. No MCP servers, no tools — query() acts
 * as a one-shot Q&A. Auth comes from the running Claude Code session;
 * no ANTHROPIC_API_KEY required. Returns the same shape as callAzure
 * (text + optional usage) so the caller can switch providers without
 * branching.
 */
async function callClaude(opts: {
  system: string;
  user: string;
}): Promise<{ text: string; usage?: AzureUsage; error?: string }> {
  // Dynamic import to keep the Azure-only deploy path tree-shake-friendly
  // and to avoid pulling the SDK into every consumer of this package.
  let queryFn: typeof import("@anthropic-ai/claude-agent-sdk")["query"];
  try {
    ({ query: queryFn } = await import("@anthropic-ai/claude-agent-sdk"));
  } catch (e) {
    return { text: "", error: `claude-agent-sdk import failed: ${(e as Error).message}` };
  }

  let text = "";
  let finalResult = "";
  let usage: AzureUsage | undefined;
  try {
    for await (const msg of queryFn({
      prompt: opts.user,
      options: {
        systemPrompt: opts.system,
        permissionMode: "bypassPermissions",
        mcpServers: {},
        allowedTools: [],
        settingSources: [],
      },
    } as Parameters<typeof queryFn>[0]) as AsyncIterable<Record<string, unknown>>) {
      const t = msg.type;
      if (t === "assistant") {
        const message = msg.message as { content?: unknown[] } | undefined;
        for (const block of message?.content ?? []) {
          const b = block as { type?: string; text?: string };
          if (b.type === "text" && typeof b.text === "string") text += b.text;
        }
      } else if (t === "result") {
        if (typeof msg.result === "string") finalResult = msg.result;
        // claude-agent-sdk's result message carries usage in `usage`.
        const u = msg.usage as { input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number } | undefined;
        if (u) {
          usage = {
            input_tokens: u.input_tokens,
            cached_input_tokens: u.cache_read_input_tokens,
            output_tokens: u.output_tokens,
          };
        }
      }
    }
  } catch (e) {
    return { text: "", error: `claude query failed: ${(e as Error).message}` };
  }
  return { text: text || finalResult, usage };
}

async function callAzure(opts: {
  azureBaseUrl: string;
  azureApiKey: string;
  model: string;
  system: string;
  user: string;
  previousResponseId?: string;
}): Promise<{ text: string; usage?: AzureUsage; responseId?: string; error?: string }> {
  const r = await fetch(`${opts.azureBaseUrl}/responses`, {
    method: "POST",
    headers: {
      "api-key": opts.azureApiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: opts.model,
      input: [
        { role: "system", content: [{ type: "input_text", text: opts.system }] },
        { role: "user", content: [{ type: "input_text", text: opts.user }] },
      ],
      max_output_tokens: 8192,
      ...(opts.previousResponseId ? { previous_response_id: opts.previousResponseId } : {}),
    }),
  });
  if (!r.ok) {
    const body = await r.text();
    return { text: "", error: `HTTP ${r.status}: ${body.slice(0, 400)}` };
  }
  const body = (await r.json()) as AzureResponse & { id?: string };
  if (body.error) return { text: "", error: body.error.message ?? JSON.stringify(body.error) };
  let out = "";
  for (const item of body.output ?? []) {
    if (item.type !== "message") continue;
    for (const c of item.content ?? []) {
      if (c.type === "output_text" && typeof c.text === "string") out += c.text;
    }
  }
  return { text: out, usage: body.usage, responseId: body.id };
}

function normalizeAnswer(raw: RawAnswer, q: QuestionDefinition): QuestionAnswer["answer"] {
  if (raw.answer === undefined || raw.answer === null) return null;
  const a = raw.answer;
  if (q.answer_schema?.type === "boolean" && typeof a !== "boolean") {
    if (a === "true" || a === 1) return true;
    if (a === "false" || a === 0) return false;
    return null;
  }
  if (q.answer_schema?.type === "number" && typeof a !== "number") {
    const n = Number(a);
    return Number.isFinite(n) ? n : null;
  }
  if (q.answer_schema?.enum && !q.answer_schema.enum.includes(a as string | number | boolean)) {
    return null;
  }
  if (typeof a === "string" || typeof a === "number" || typeof a === "boolean") return a;
  return null;
}

export async function extractAdherenceDirect(
  opts: DirectAdherenceExtractOpts,
): Promise<DirectAdherenceExtractResult> {
  const skill = loadAdherenceSkill(opts.task.task_id);
  if (skill.questions_by_tier.size === 0) {
    return {
      ok: false, question_answers: [], rule_verdicts: [],
      usage_by_tier: {}, errors: ["no questions found in skill bundle"],
    };
  }
  const tiers = [...skill.questions_by_tier.keys()].sort((a, b) => a - b);
  const model = opts.model ?? "gpt-5.2";
  const systemPrompt = buildSystemPrompt(skill);
  const notesBlob = buildNotesBlob(opts.patientId);

  const allAnswers: QuestionAnswer[] = [];
  const usageByTier: Record<number, AzureUsage> = {};
  const errors: string[] = [];
  let excluded = false;
  let exclusionReason: string | undefined;
  let previousResponseId: string | undefined;
  const provider = opts.provider ?? "codex";

  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i]!;
    const questions = skill.questions_by_tier.get(tier)!;
    const user = buildTierUserPrompt({
      patientId: opts.patientId,
      tier,
      questions,
      notesBlob,
      priorAnswers: allAnswers,
      isFirstTier: i === 0,
    });
    const res = provider === "claude"
      ? await callClaude({ system: systemPrompt, user })
      : await callAzure({
          azureBaseUrl: opts.azureBaseUrl ?? "",
          azureApiKey: opts.azureApiKey ?? "",
          model,
          system: systemPrompt,
          user,
          previousResponseId,
        });
    if (res.usage) usageByTier[tier] = res.usage;
    if (res.error) {
      errors.push(`tier ${tier} ${provider} error: ${res.error}`);
      break;
    }
    previousResponseId = ("responseId" in res ? (res as { responseId?: string }).responseId : undefined);
    const raws = parseAnswers(res.text);
    const ts = new Date().toISOString();
    for (const q of questions) {
      const r = raws.find((x) => x.question_id === q.question_id);
      if (!r) {
        allAnswers.push({
          question_id: q.question_id, tier: q.tier, answer: null,
          source: "agent", ts,
        });
        continue;
      }
      allAnswers.push({
        question_id: q.question_id,
        tier: q.tier,
        answer: normalizeAnswer(r, q),
        confidence: r.confidence,
        evidence: r.evidence?.filter((e): e is { note_id: string; quote: string } =>
          typeof e.note_id === "string" && typeof e.quote === "string") ?? undefined,
        reasoning: r.reasoning,
        verifier_status: r.verifier_status,
        source: "agent",
        ts,
      });
    }

    // Eligibility gate. Only the eligibility rule (by convention
    // `R-T0-Eligible`) audits scope-out — other rules with
    // excluded_if legitimately resolve to EXCLUDED for in-scope
    // patients (e.g. "no controller prescribed" excludes the
    // adherence-was-assessed rule), and we don't want those to
    // short-circuit the whole audit.
    if (tier === 0 && (opts.gateOnEligibility ?? true)) {
      const eligibilityRule = skill.rules.find((r) => r.rule_id === "R-T0-Eligible");
      if (eligibilityRule) {
        const gateRes = await evaluateAllRules([eligibilityRule], allAnswers);
        if (gateRes[0]?.verdict === "EXCLUDED") {
          excluded = true;
          exclusionReason = `Excluded by ${gateRes[0].rule_id}`;
          break;
        }
      }
    }
  }

  // Rule eval — deterministic + optional LLM judge for nuanced rules.
  const llmJudge = async (req: LlmJudgeRequest): Promise<LlmJudgeResponse> => {
    const sys = [
      "You are the nuanced-rule judge for an adherence audit.",
      "Given a deterministic rule verdict and its supporting answers, decide whether",
      "the verdict and attribution category are correct.",
      "",
      "Return JSON: { \"verdict\": \"CONCORDANT\"|\"NON_CONCORDANT\"|\"EXCLUDED\", \"attribution\": \"<category>\", \"rationale\": \"<one-paragraph prose>\" }",
      "No markdown, no commentary.",
    ].join("\n");
    const userTxt = JSON.stringify({
      rule: { rule_id: req.rule.rule_id, description: req.rule.description },
      deterministic_verdict: req.deterministic_verdict,
      supporting_answers: req.supporting_answers,
      attribution_categories: skill.attribution_categories,
    }, null, 2);
    const res = provider === "claude"
      ? await callClaude({ system: sys, user: userTxt })
      : await callAzure({
          azureBaseUrl: opts.azureBaseUrl ?? "",
          azureApiKey: opts.azureApiKey ?? "",
          model: opts.judgeModel ?? model,
          system: sys,
          user: userTxt,
        });
    if (res.error || !res.text) {
      throw new Error(res.error ?? "empty judge response");
    }
    let parsed: { verdict?: string; attribution?: string; rationale?: string };
    try { parsed = JSON.parse(res.text.trim()); }
    catch { throw new Error("judge returned non-JSON"); }
    const v = parsed.verdict;
    return {
      verdict: v === "CONCORDANT" || v === "NON_CONCORDANT" || v === "EXCLUDED" ? v : undefined,
      attribution: parsed.attribution as LlmJudgeResponse["attribution"],
      rationale: parsed.rationale ?? "(no rationale)",
    };
  };

  const verdicts = excluded
    ? skill.rules.map((r) => ({
        rule_id: r.rule_id,
        verdict: "EXCLUDED" as const,
        source: "rule_engine" as const,
        ts: new Date().toISOString(),
      }))
    : await evaluateAllRules(skill.rules, allAnswers, { llmJudge });

  return {
    ok: true,
    question_answers: allAnswers,
    rule_verdicts: verdicts,
    excluded: excluded || undefined,
    exclusion_reason: exclusionReason,
    usage_by_tier: usageByTier,
    errors,
  };
}
