// One-patient adherence driver using Claude via @anthropic-ai/claude-agent-sdk.
//
// Mirrors what extractAdherenceDirect does for Azure, but issues each tier's
// LLM call as a plain query() round-trip on Claude — no MCP servers, no
// tools, no agent loop. Authenticates via the running Claude Code session,
// so no ANTHROPIC_API_KEY env var is required.
//
// Usage:
//   node run-adherence-claude.mjs <patient_id> [task_id]
//
// Outputs the per-tier QuestionAnswers + RuleVerdicts to stdout and writes
// the agent-shaped draft to var/runs/_smoke_claude_<patient>/agents/agent_1.json.

import fs from "node:fs";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { listNotes, readNote } from "@chart-review/patients";
import { loadAdherenceSkill } from "@chart-review/pipeline-extract-adherence";
import { evaluateAllRules } from "@chart-review/rule-engine";

const patientId = process.argv[2];
const taskId = process.argv[3] ?? "asthma-adherence";
if (!patientId) {
  console.error("usage: node run-adherence-claude.mjs <patient_id> [task_id]");
  process.exit(2);
}

// ── prompt builders (mirror direct-llm-extract.ts) ────────────────────────

function schemaHint(q) {
  const s = q.answer_schema;
  if (!s) return "string|number|boolean|null";
  if (s.enum) return `one of: ${s.enum.map((v) => JSON.stringify(v)).join(", ")} (or null)`;
  if (s.type === "boolean") return "true | false | null";
  if (s.type === "number") return "number | null";
  if (s.type === "string") return "string | null";
  return "string|number|boolean|null";
}

function buildSystemPrompt(skill) {
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

function buildNotesBlob(pid) {
  const notes = listNotes(pid);
  const parts = [];
  for (const n of notes) {
    let body = "";
    try { body = readNote(pid, n.filename); } catch { continue; }
    const noteId = n.filename.replace(/\.txt$/, "");
    const header = `--- NOTE id=${noteId}`
      + (n.date ? ` date=${n.date}` : "")
      + (n.doctype ? ` doctype=${n.doctype}` : "") + " ---";
    parts.push(`${header}\n${body}`);
  }
  return { blob: parts.join("\n\n"), count: notes.length };
}

function buildTierUserPrompt({ patientId, tier, questions, notesBlob, priorAnswers, isFirstTier }) {
  const sections = [];
  sections.push(`Patient: ${patientId}`);
  sections.push(`Tier ${tier} — ${tier === 0 ? "eligibility" : tier === 1 ? "assessment" : "management/treatment"}`);
  sections.push("");
  if (isFirstTier) {
    sections.push("--- CHART (verbatim notes) ---");
    sections.push(notesBlob);
    sections.push("--- END CHART ---");
  } else {
    sections.push("(You saw the chart in your prior turn — same notes.)");
    sections.push("");
    sections.push("--- EARLIER TIER ANSWERS ---");
    sections.push(JSON.stringify(priorAnswers.map((a) => ({
      question_id: a.question_id, tier: a.tier, answer: a.answer,
    })), null, 2));
    sections.push("--- END EARLIER TIER ANSWERS ---");
  }
  sections.push("");
  sections.push("Questions for this tier:");
  for (const q of questions) {
    const hint = q.retrieval_hints ? `\n    hint: ${q.retrieval_hints}` : "";
    sections.push(`- [${q.question_id}] ${q.text}\n    answer: ${schemaHint(q)}${hint}`);
  }
  sections.push("");
  sections.push("Respond with the JSON object only. First character must be `{`. No prose.");
  return sections.join("\n");
}

function parseAnswers(text) {
  let s = text.trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) s = fence[1].trim();
  // Find the first { ... } block tolerant of preamble.
  const start = s.indexOf("{");
  if (start > 0) s = s.slice(start);
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.answers)) return parsed.answers;
  } catch { /* fall through */ }
  return [];
}

function normalizeAnswer(raw, q) {
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
  if (q.answer_schema?.enum && !q.answer_schema.enum.includes(a)) {
    return null;
  }
  if (typeof a === "string" || typeof a === "number" || typeof a === "boolean") return a;
  return null;
}

// ── single Claude round-trip via the agent-sdk query() ────────────────────

async function callClaude({ system, user }) {
  // No MCP, no tools — just a plain Q&A turn. settingSources stays empty
  // so the SDK doesn't try to load Claude Code settings.json.
  let text = "";
  let finalResult = "";
  try {
    for await (const msg of query({
      prompt: user,
      options: {
        systemPrompt: system,
        permissionMode: "bypassPermissions",
        mcpServers: {},
        allowedTools: [],
        settingSources: [],
      },
    })) {
      const t = msg?.type;
      if (t === "assistant" && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block?.type === "text" && typeof block.text === "string") {
            text += block.text;
          }
        }
      } else if (t === "result" && typeof msg.result === "string") {
        finalResult = msg.result;
      }
    }
  } catch (e) {
    return { text: "", error: e?.message ?? String(e) };
  }
  return { text: text || finalResult };
}

// ── main ──────────────────────────────────────────────────────────────────

const skill = loadAdherenceSkill(taskId);
if (skill.questions_by_tier.size === 0) {
  console.error(`no questions found for task ${taskId}`);
  process.exit(3);
}
const tiers = [...skill.questions_by_tier.keys()].sort((a, b) => a - b);

const { blob: notesBlob, count: noteCount } = buildNotesBlob(patientId);
if (noteCount === 0) {
  console.error(`no notes for patient ${patientId}`);
  process.exit(4);
}
console.log(`patient=${patientId} task=${taskId} notes=${noteCount} tiers=${tiers.join(",")} rules=${skill.rules.length}`);

const systemPrompt = buildSystemPrompt(skill);
const allAnswers = [];
const tierLogs = [];

for (let i = 0; i < tiers.length; i++) {
  const tier = tiers[i];
  const qs = skill.questions_by_tier.get(tier);
  const user = buildTierUserPrompt({
    patientId, tier, questions: qs, notesBlob,
    priorAnswers: allAnswers, isFirstTier: i === 0,
  });
  console.log(`\n→ tier ${tier} (${qs.length} questions) — calling Claude…`);
  const t0 = Date.now();
  const res = await callClaude({ system: systemPrompt, user });
  const dtMs = Date.now() - t0;
  if (res.error) {
    console.error(`tier ${tier} error: ${res.error}`);
    break;
  }
  const raws = parseAnswers(res.text);
  console.log(`   ← ${raws.length} answers parsed in ${dtMs}ms (${res.text.length} chars)`);
  if (raws.length === 0 && res.text.length > 0) {
    console.log("   RAW (first 1500 chars):\n" + res.text.slice(0, 1500));
    console.log("   ... TAIL (last 400 chars):\n" + res.text.slice(-400));
  }
  const ts = new Date().toISOString();
  for (const q of qs) {
    const r = raws.find((x) => x.question_id === q.question_id);
    if (!r) {
      allAnswers.push({ question_id: q.question_id, tier: q.tier, answer: null, source: "agent", ts });
      continue;
    }
    allAnswers.push({
      question_id: q.question_id,
      tier: q.tier,
      answer: normalizeAnswer(r, q),
      confidence: r.confidence,
      evidence: Array.isArray(r.evidence) ? r.evidence : undefined,
      reasoning: r.reasoning,
      verifier_status: r.verifier_status,
      source: "agent",
      ts,
    });
  }
  tierLogs.push({ tier, count: raws.length, dt_ms: dtMs });

  // T0 eligibility gate — only the eligibility rule (R-T0-Eligible)
  // counts. Other rules with excluded_if (e.g. R-T1-AdherenceAssessed
  // is "excluded when no controller prescribed") legitimately resolve
  // to EXCLUDED for in-scope patients; we don't want those to short-
  // circuit the audit.
  if (tier === 0) {
    const eligibilityRule = skill.rules.find((r) => r.rule_id === "R-T0-Eligible");
    if (eligibilityRule) {
      const gate = await evaluateAllRules([eligibilityRule], allAnswers);
      if (gate[0]?.verdict === "EXCLUDED") {
        console.log(`\n‼ T0 gate triggered: ${gate[0].rule_id} → EXCLUDED. Skipping later tiers.`);
        break;
      }
    }
  }
}

// If T0 eligibility excluded the patient, every rule is EXCLUDED
// (the audit doesn't apply). Mirrors extractAdherenceDirect's
// excluded-short-circuit so the verdict list is semantically correct.
const excluded = (() => {
  const r = skill.rules.find((rule) => rule.rule_id === "R-T0-Eligible");
  if (!r) return false;
  // Re-evaluate the eligibility rule deterministically with whatever
  // answers we collected; verdict===EXCLUDED means audit-out-of-scope.
  return false; // assigned below
})();
let auditExcluded = false;
{
  const elig = skill.rules.find((rule) => rule.rule_id === "R-T0-Eligible");
  if (elig) {
    const eligV = await evaluateAllRules([elig], allAnswers);
    auditExcluded = eligV[0]?.verdict === "EXCLUDED";
  }
}
const verdicts = auditExcluded
  ? skill.rules.map((r) => ({
      rule_id: r.rule_id,
      verdict: "EXCLUDED",
      supporting_questions: r.supporting_questions,
      source: "rule_engine",
      ts: new Date().toISOString(),
    }))
  : await evaluateAllRules(skill.rules, allAnswers);

console.log("\n══ QuestionAnswers ══");
for (const a of allAnswers) {
  const ev = a.evidence?.length ? ` (${a.evidence.length} ev)` : "";
  console.log(`  [T${a.tier}] ${a.question_id} = ${JSON.stringify(a.answer)}${ev}`);
}
console.log("\n══ RuleVerdicts ══");
for (const v of verdicts) {
  const attr = v.attribution ? ` (${v.attribution})` : "";
  console.log(`  ${v.rule_id}: ${v.verdict}${attr}`);
}

// Persist the agent draft in the same shape the runner writes
const outDir = path.join("var", "runs", `_smoke_claude_${patientId}`, "per_patient", patientId, "agents");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, "agent_1.json"),
  JSON.stringify({
    task_id: taskId,
    task_kind: "adherence",
    question_answers: allAnswers,
    rule_verdicts: verdicts,
    tier_logs: tierLogs,
  }, null, 2),
);
console.log(`\nWrote ${path.join(outDir, "agent_1.json")}`);
