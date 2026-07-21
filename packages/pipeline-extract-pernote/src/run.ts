// Deploy runner for the NATIVE per-note extractor against a local vLLM.
// Loops a cohort's notes, calls extractLabelsForNote once per note (bounded
// concurrency), aggregates across notes per patient, writes <out>/<pid>.json.
//
// The native package is untouched; vLLM specifics (Qwen3 enable_thinking=false)
// live here in an injected `call` passed via opts.call — the native design's
// test/override seam. Run on a compute node (tsx OOMs on login):
//   node node_modules/tsx/dist/cli.mjs \
//     packages/pipeline-extract-pernote/src/run.ts \
//     --task acts --skills-root .claude/skills --data-dir <cohort> \
//     --endpoint @../vllm_endpoint_v100h.txt --model qwen3-32b --out <dir> [--concurrency 8]
import fs from "node:fs";
import path from "node:path";
import { loadCompiledTask } from "@chart-review/tasks";
import { extractLabelsForNote, fieldsFromTask, parseVaccineTables, type VaccineCatalog } from "./index.js";
import { type LlmEndpoint, type LlmResult } from "./llm-call.js";

/** Fields whose evidence quote MUST contain a domain-anchor token, else the
 *  answer is dropped — blocks the model asserting a value from an unrelated or
 *  absent quote, which prompt instructions alone don't reliably stop:
 *   - cdr_global: infers a formal score from a general statement
 *     (cdr_global='0' from "no cognitive impairment") absent an actual CDR.
 *     The negative lookahead ALSO rejects a quote whose only CDR reference is
 *     the Sum-of-Boxes (CDR-SB / "sum of boxes"), which the rubric forbids
 *     converting to CDR-Global — a bare "CDR" elsewhere in the quote still
 *     passes (that IS a global reference).
 *   - smoking_status: defaults to "never" when the note has no tobacco line at
 *     all (real cohort: 2/10 false "never"; gold: spurious on fake_acts_01),
 *     often citing an unrelated (e.g. cognition) quote. Require a tobacco token.
 *     Includes the abbreviations "ppd" (packs/day) and "tob" (Tob:) so a
 *     shorthand-only social-history line isn't wrongly dropped.
 *   - quit_time: dates only — the evidence must contain a 4-digit calendar year
 *     so an age-at-quit ("age 55") or relative time ("10 years ago") is dropped. */
const ANCHOR_TOKENS: Record<string, RegExp> = {
  cdr_global: /\bcdr\b(?![\s-]*(sb\b|sob\b|sum))|clinical dementia rating(?![\s-]*(sum|sob|sb\b))/i,
  smoking_status: /tobacco|\btob\b|smok|cigar|nicotine|\bvap|\bpack|\bppd\b/i,
  quit_time: /\b(19|20)\d{2}\b/,
};

// ── irAE entity resolution (Safety) ──────────────────────────────────
// The model emits the same irAE with different wording across notes (nephritis
// ×3, "transaminitis"/"ALT elevation"/"hepatitis", "arthralgia"/"inflammatory
// arthritis"). Aggregation dedups on the exact AE_condition string, so those
// don't merge → over-count. Map each AE_condition to a canonical irAE family
// (also ENFORCES the ontology — a term matching no family is dropped, e.g.
// "grade 3 fatigue"), then merge records sharing a family into one.
const AE_FAMILIES: Array<[RegExp, string, string]> = [
  [/pneumonitis|interstitial lung|\bild\b/i, "pneumonitis", "pulmonary"],
  [/enterocolitis|colitis|immune[- ]mediated diarrhea/i, "colitis", "gastrointestinal"],
  [/hepatitis|transaminit|transaminase|hepatotoxic|\balt\b|\bast\b|liver (enzyme|injury)/i, "hepatitis", "hepatic"],
  [/nephritis|kidney injury|renal (injury|insufficiency)|\baki\b|tubulointerstitial/i, "nephritis", "renal"],
  [/hypophysitis|hypopituitar/i, "hypophysitis", "endocrine"],
  [/adrenal insufficiency|adrenalitis|hypoadrenal/i, "adrenal insufficiency", "endocrine"],
  [/thyroiditis|hypothyroid|hyperthyroid|thyroid storm|thyrotoxic/i, "thyroid dysfunction", "endocrine"],
  [/type 1 diabet|diabetic ketoacidosis|\bdka\b/i, "type 1 diabetes", "endocrine"],
  [/myocarditis|pericarditis|cardiomyopath/i, "myocarditis", "cardiac"],
  [/myositis|myopath/i, "myositis", "musculoskeletal"],
  [/arthritis|arthralgia|myalgia|arthritic|polymyalgia/i, "inflammatory arthritis", "musculoskeletal"],
  [/dermatitis|\brash\b|pruritus|bullous|stevens[- ]johnson|\bsjs\b|\bten\b|toxic epidermal|vitiligo/i, "dermatitis", "dermatologic"],
  [/uveitis|episcleritis|scleritis|conjunctivitis/i, "uveitis", "ocular"],
  [/myasthenia|guillain|encephalitis|neuropath|meningitis|myelitis/i, "neurologic irAE", "neurologic"],
  [/thrombocytopenia|hemolytic anemia|\bitp\b|aplastic anemia|immune neutropenia/i, "hematologic irAE", "hematologic"],
];
function canonAE(cond: unknown): { canon: string; organ: string } | null {
  const c = String(cond ?? "");
  for (const [re, canon, organ] of AE_FAMILIES) if (re.test(c)) return { canon, organ };
  return null; // not on the irAE ontology → drop
}
const _gradeRank = (g: unknown) => { const n = parseInt(String(g), 10); return Number.isFinite(n) ? n : -1; };
const _actionRank: Record<string, number> = {
  treatment_discontinued: 4, treatment_interrupted: 3, dose_reduced: 2, supportive_care: 1, none: 0,
};
const _pick = (x: any, y: any) => (x != null && x !== "" && x !== "no_info") ? x : y;
function _mergeAE(a: any, b: any): any {
  return {
    AE_condition: a.AE_condition,
    Organ_System: a.Organ_System || b.Organ_System,
    AE_Grade: _gradeRank(b.AE_Grade) > _gradeRank(a.AE_Grade) ? b.AE_Grade : a.AE_Grade,
    AE_attribution: [a.AE_attribution, b.AE_attribution].includes("treatment_related")
      ? "treatment_related" : _pick(a.AE_attribution, b.AE_attribution),
    Action_taken: (_actionRank[b.Action_taken] ?? -1) > (_actionRank[a.Action_taken] ?? -1)
      ? b.Action_taken : a.Action_taken,
    AE_StartDate: _pick(a.AE_StartDate, b.AE_StartDate),
    AE_EndDate: _pick(a.AE_EndDate, b.AE_EndDate),
    event_stop: _pick(a.event_stop, b.event_stop),
    event_death: _pick(a.event_death, b.event_death),
    Expected_AE: _pick(a.Expected_AE, b.Expected_AE),
    AE_Recurrence: _pick(a.AE_Recurrence, b.AE_Recurrence),
    Supporting_Evidence: a.Supporting_Evidence,
    merged_from: (a.merged_from ?? 1) + 1,
  };
}
const EXPECTED_RE = /\bexpected\b|anticipat|per[- ]protocol|known (side[- ])?effect|as expected/i;
function dedupAdverseEvents(records: any[]): any[] {
  const groups = new Map<string, any>();
  for (const r of records) {
    const c = canonAE(r?.AE_condition);
    if (!c) continue; // ontology enforcement
    if (!r.Organ_System) r.Organ_System = c.organ;
    groups.set(c.canon, groups.has(c.canon) ? _mergeAE(groups.get(c.canon), r) : r);
  }
  const out = [...groups.values()];
  // Expected_AE grounding guard: the model marks "yes" by default (9/10) despite
  // the prompt. Keep "yes" only when the evidence actually states the AE was
  // expected/anticipated/per-protocol; otherwise no_info (default). Same
  // deployment-layer pattern as ANCHOR_TOKENS for cdr_global.
  for (const r of out) {
    if (r.Expected_AE && r.Expected_AE !== "no_info" && !EXPECTED_RE.test(String(r.Supporting_Evidence ?? ""))) {
      r.Expected_AE = "no_info";
    }
  }
  return out;
}
function dedupByValueKey(records: any[]): any[] {
  const seen = new Set<string>(), out: any[] = [];
  for (const r of records) {
    const k = JSON.stringify(Object.values(r)[0]).toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(r); }
  }
  return out;
}

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]!); }
  }));
  return out;
}

/** vLLM-flavored transport: OpenAI /chat/completions + chat_template_kwargs
 *  {enable_thinking:false} (Qwen3 speed). Returns the native LlmResult shape so
 *  it drops in via extractLabelsForNote's `call` seam. */
async function vllmCall(ep: LlmEndpoint, system: string, user: string, maxTokens = 8192): Promise<LlmResult> {
  const r = await fetch(`${ep.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ep.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: ep.model,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      max_tokens: maxTokens,
      temperature: 0,
      chat_template_kwargs: { enable_thinking: false },
    }),
  });
  const j: any = await r.json();
  if (!r.ok) throw new Error(`LLM ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  const ch = j.choices?.[0];
  const truncated = ch?.finish_reason === "length" ||
    (typeof j.usage?.completion_tokens === "number" && j.usage.completion_tokens >= maxTokens);
  return {
    text: ch?.message?.content ?? "",
    usage: j.usage ? { input_tokens: j.usage.prompt_tokens, output_tokens: j.usage.completion_tokens } : undefined,
    truncated,
  };
}

async function main(): Promise<number> {
  const taskId = arg("task")!;
  const skillsRoot = path.resolve(arg("skills-root", ".claude/skills")!);
  const dataDir = path.resolve(arg("data-dir")!);
  const outDir = path.resolve(arg("out", `${dataDir}/pernote_out`)!);
  const model = arg("model", "qwen3-32b")!;
  const concurrency = parseInt(arg("concurrency", "8")!, 10);
  let epArg = arg("endpoint")!;
  if (epArg.startsWith("@")) epArg = fs.readFileSync(path.resolve(epArg.slice(1)), "utf8").trim();

  process.env.CHART_REVIEW_GUIDELINES_ROOT = skillsRoot; // loadCompiledTask
  process.env.CHART_REVIEW_PATIENTS_ROOT = dataDir;      // readNote

  const task = loadCompiledTask(taskId);
  if (!task) { console.error(`[pernote] cannot load task ${taskId} from ${skillsRoot}`); return 2; }

  const refs = path.join(skillsRoot, `chart-review-${taskId}`, "references");
  const preamblePath = path.join(refs, "pernote_prompt.md");
  const promptPreamble = fs.existsSync(preamblePath)
    ? fs.readFileSync(preamblePath, "utf8")
    : "You are a clinical chart abstraction assistant. Label only what THIS note documents; cite a verbatim quote for every value.";

  let vaccineCatalog: VaccineCatalog | undefined;
  const cdc = path.join(refs, "CDC_Vaccine_Reference_Table.md");
  const amy = path.join(refs, "Active_Amyloid_Tau_Immunization_Reference_Table.md");
  if (fs.existsSync(cdc)) {
    vaccineCatalog = parseVaccineTables(fs.readFileSync(cdc, "utf8"), fs.existsSync(amy) ? fs.readFileSync(amy, "utf8") : "");
  }

  const endpoint: LlmEndpoint = { baseUrl: epArg, apiKey: process.env.LLM_API_KEY || "EMPTY", model, mode: "openrouter" };

  const patients = fs.readdirSync(dataDir).filter((p) => {
    const nd = path.join(dataDir, p, "notes");
    return fs.existsSync(nd) && fs.statSync(nd).isDirectory() && fs.readdirSync(nd).some((f) => f.endsWith(".txt"));
  }).sort();

  fs.mkdirSync(outDir, { recursive: true });
  console.error(`[pernote] task=${taskId} patients=${patients.length} fields=${fieldsFromTask(task).length} `
    + `endpoint=${epArg} model=${model} concurrency=${concurrency}`);

  for (const pid of patients) {
    const notesDir = path.join(dataDir, pid, "notes");
    const notes = fs.readdirSync(notesDir).filter((f) => f.endsWith(".txt")).sort();
    const perNote = await pool(notes, concurrency, async (noteFile) => {
      const noteId = noteFile.replace(/\.txt$/, ""); // native reads `${noteId}.txt`
      const r = await extractLabelsForNote({
        patientId: pid, task, noteId, endpoint, promptPreamble, vaccineCatalog, call: vllmCall,
      });
      // keep only fields the note documented (answer present)
      // + anchor guard: some fields (cdr_global, smoking_status) the model asserts
      // from an unrelated/absent quote even when told not to; require the evidence
      // quote to contain a domain-anchor token (ANCHOR_TOKENS) else drop. Native
      // package untouched — this is a deployment-layer precision rule.
      const documented = r.fields.filter((f) => {
        if (f.answer === undefined) return false;
        if (Array.isArray(f.answer) && f.answer.length === 0) return false;
        const anchor = ANCHOR_TOKENS[f.field_id];
        if (anchor) {
          const q = (f.evidence?.[0]?.verbatim_quote ?? f.evidence_quote ?? "").toLowerCase();
          if (!anchor.test(q)) return false;
        }
        return true;
      });
      return { note: noteFile, error: r.error, fields: documented };
    });

    // aggregate: collect entity records raw across notes, dedup after; scalars
    // most-recent (files named YYYY-MM-DD…).
    const agg: Record<string, any> = {};
    for (const n of perNote.slice().sort((a, b) => a.note.localeCompare(b.note))) {
      for (const f of n.fields) {
        if (Array.isArray(f.answer)) {
          const cur = (agg[f.field_id]?.answer ?? []) as any[];
          cur.push(...f.answer);
          agg[f.field_id] = { answer: cur };
        } else {
          agg[f.field_id] = { answer: f.answer, confidence: f.confidence, evidence: f.evidence, note: n.note };
        }
      }
    }
    // entity dedup: adverse_event → irAE-ontology canonical merge (drops non-irAE
    // + collapses same event phrased differently); other lists → exact value_key.
    for (const fid of Object.keys(agg)) {
      const a = agg[fid].answer;
      if (!Array.isArray(a)) continue;
      agg[fid].answer = fid === "adverse_event" ? dedupAdverseEvents(a) : dedupByValueKey(a);
    }
    const nErr = perNote.filter((n) => n.error).length;
    fs.writeFileSync(path.join(outDir, `${pid}.json`),
      JSON.stringify({ patient: pid, n_notes: notes.length, n_note_errors: nErr, aggregated: agg, per_note: perNote }, null, 2));
    const vax = Array.isArray(agg.vaccine_name?.answer) ? `, vaccines=${agg.vaccine_name.answer.length}` : "";
    console.error(`[pernote]   ${pid}: ${notes.length} notes → ${Object.keys(agg).length} fields`
      + `${vax}${nErr ? `, ${nErr} note-errors` : ""}`);
  }
  console.error(`[pernote] done → ${outDir}`);
  return 0;
}

main().then((c) => process.exit(c)).catch((e) => { console.error(`[pernote] ${e?.stack ?? e}`); process.exit(1); });
