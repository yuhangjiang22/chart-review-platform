import dotenv from "dotenv"; import path from "node:path";
dotenv.config({ path: path.join(process.cwd(), ".env") });
process.env.CHART_REVIEW_PLATFORM_ROOT ??= process.cwd();
import { loadCompiledTask } from "@chart-review/tasks";
try {
  const task: any = loadCompiledTask("lung-cancer-adherence");
  if (!task) { console.error("LOAD returned null"); }
  else console.log("OK questions:", task.questions?.length, "rules:", task.rules?.length);
} catch (e) { console.error("LOAD ERROR:", (e as Error).message); }
