import dotenv from "dotenv"; import path from "node:path"; import fs from "node:fs";
dotenv.config({ path: path.join(process.cwd(), ".env") });
process.env.CHART_REVIEW_PLATFORM_ROOT ??= process.cwd();
import { compileRule, evaluateRule } from "@chart-review/rule-engine";
import { loadAdherenceSkill } from "@chart-review/pipeline-extract-adherence";

const skill: any = loadAdherenceSkill("lung-cancer-adherence");
const compiled = skill.rules.map((r: any) => compileRule(r));

const runs = fs.readdirSync("var/runs").filter((r) => r.startsWith("2026-10-0"));
const seen = new Set<string>();
const tally: Record<string, Record<string, number>> = {};
let npat = 0;
for (const R of runs.sort()) {
  const mp = `var/runs/${R}/manifest.json`;
  if (!fs.existsSync(mp)) continue;
  const m = JSON.parse(fs.readFileSync(mp, "utf8"));
  if (m.task_id !== "lung-cancer-adherence" || (m.patient_ids ?? []).length < 14) continue;
  for (const p of m.patient_ids as string[]) {
    const f = `var/runs/${R}/_scratch_state_agent_1/${p}/lung-cancer-adherence/review_state.json`;
    if (!fs.existsSync(f) || seen.has(p)) continue;
    const st = JSON.parse(fs.readFileSync(f, "utf8"));
    const answers = st.question_answers ?? [];
    if (!answers.length) continue;
    seen.add(p); npat++;
    for (const c of compiled) {
      const v = evaluateRule(c, answers);
      const id = (c as any).rule.rule_id;
      tally[id] ??= {};
      tally[id][v.verdict] = (tally[id][v.verdict] ?? 0) + 1;
    }
  }
}
console.log(`患者 ${npat}\n`);
let C=0,N=0,E=0;
console.log("规则".padEnd(32) + "CONCORDANT  NON_CONC  EXCLUDED");
for (const [id, t] of Object.entries(tally)) {
  const c=t.CONCORDANT??0, n=t.NON_CONCORDANT??0, e=t.EXCLUDED??0;
  C+=c; N+=n; E+=e;
  console.log(id.padEnd(32) + String(c).padStart(8) + String(n).padStart(10) + String(e).padStart(10));
}
const tot=C+N+E;
console.log(`\n合计  CONCORDANT ${C} (${(C/tot*100).toFixed(1)}%)  NON_CONCORDANT ${N} (${(N/tot*100).toFixed(1)}%)  EXCLUDED ${E} (${(E/tot*100).toFixed(1)}%)`);
console.log(`在可判定(非 EXCLUDED)中,非一致率 ${N}/${C+N} = ${(N/(C+N)*100).toFixed(1)}%`);
