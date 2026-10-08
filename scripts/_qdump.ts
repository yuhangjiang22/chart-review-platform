import dotenv from "dotenv"; import path from "node:path";
dotenv.config({ path: path.join(process.cwd(), ".env") });
process.env.CHART_REVIEW_PLATFORM_ROOT ??= process.cwd();
import { loadAdherenceSkill } from "@chart-review/pipeline-extract-adherence";
const skill: any = loadAdherenceSkill("lung-cancer-adherence");
for (const [tier, list] of skill.questions_by_tier) {
  for (const q of list as any[]) {
    console.log(`tier${tier} ${q.question_id} | ${String(q.text).slice(0,52)} | enum=${JSON.stringify(q.answer_schema?.enum)?.slice(0,60)}`);
  }
}
