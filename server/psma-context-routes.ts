// Route: derive the PSMA context summary from a patient's saved answers.
// The summary is a pure, deterministic render of the answered questions
// (see server/lib/context-summary.ts) — no model call, grounded by construction.

import fs from "node:fs";
import { pathFor } from "@chart-review/storage";
import type { QuestionAnswer } from "@chart-review/platform-types";
import type { RouteEntry } from "./router.js";
import { renderPsmaContextSummary } from "./lib/context-summary.js";

const TASK_ID = "psma-context";

function readAnswers(sessionId: string, pid: string): QuestionAnswer[] {
  const fp = pathFor.reviewState(sessionId, pid, TASK_ID);
  if (!fs.existsSync(fp)) return [];
  try {
    const d = JSON.parse(fs.readFileSync(fp, "utf8")) as { question_answers?: QuestionAnswer[] };
    const all = d.question_answers ?? [];
    // Reviewer-validated answers override agent answers: rendered last so they
    // win the render's last-write-wins dedup by question_id.
    return [
      ...all.filter((q) => (q as { source?: string }).source !== "reviewer"),
      ...all.filter((q) => (q as { source?: string }).source === "reviewer"),
    ];
  } catch {
    return [];
  }
}

export const psmaContextRoutes: RouteEntry[] = [
  {
    // GET /api/psma-context/:patientId/summary?session=<sessionId>
    method: "GET",
    pattern: "/api/psma-context/:patientId/summary",
    handler: async (_body, _req, params, query) => {
      const sessionId = query.get("session") ?? "";
      const answers = readAnswers(sessionId, params.patientId);
      const rendered = renderPsmaContextSummary(answers);
      return { ...rendered, answered_count: answers.length };
    },
  },
];
