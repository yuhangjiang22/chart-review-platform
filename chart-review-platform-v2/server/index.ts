// HTTP server skeleton — exposes the 6 modules as REST endpoints.
//
// Lets external clients drive v2 over HTTP instead of via TypeScript
// imports. Each endpoint is a thin shell around the corresponding
// pipeline call; no UI is included — that's v1's Studio for now.
//
// Endpoints:
//   POST /api/v2/clarify       { prompt, domain }                                    → TaskSpec
//   POST /api/v2/form          { task_spec }                                         → FormSpec
//   POST /api/v2/discover      { task_spec, subject }                                → EvidenceUnit[]
//   POST /api/v2/extract       { form, subject, corpus, extractor_id, provider? }    → ExtractorOutput
//   POST /api/v2/reconcile     { outputs, run_judge?, judge_provider? }              → ReconciledDraft
//   POST /api/v2/correct       { task_id, subject_id, field_id, decision, seed? }    → FinalizedAssessment
//   POST /api/v2/run           { prompt, subject, mode, run_judge? }                 → FinalizedAssessment
//
// Run:
//   PORT=3002 npx tsx server/index.ts
//
// All endpoints return JSON. Errors come back as { error: string } with
// the matching HTTP status code.

import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { makeChartReviewClarify, makeLitExtractClarify } from "../modules/1-clarify/index.js";
import { makeChartReviewFormGen, makeLitExtractFormGen } from "../modules/2-form-gen/index.js";
import { makeChartReviewDiscover, makeLitExtractDiscover } from "../modules/3-discover/index.js";
import {
  makeV1AgentExtract, verifyEvidenceFaithfulness,
} from "../modules/4-extract/index.js";
import { makeReconciler, makeV1Judge } from "../modules/5-validate/index.js";
import { makeCorrectLog } from "../modules/6-correct-log/index.js";
import { makeChartReviewPipeline } from "../workflows/chart-review.js";
import { makeLitExtractPipeline } from "../workflows/lit-extract.js";
import type {
  TaskSpec, FormSpec, SubjectRef, EvidenceUnit, ExtractorOutput,
  HumanDecision, Domain, ProviderName,
} from "../shared/types.js";

const PORT = Number(process.env.PORT ?? 3002);
const REVIEWS_ROOT = process.env.CHART_REVIEW_REVIEWS_ROOT
  ?? path.join(process.cwd(), "var", "reviews");
const PLATFORM_ROOT = path.resolve(__dirname, "..", "..", "chart-review-platform");
const CORPUS_ROOT = process.env.CHART_REVIEW_CORPUS_ROOT
  ?? path.join(PLATFORM_ROOT, "corpus", "patients");

// ── per-domain factories ────────────────────────────────────────────

function clarifyFor(domain: Domain) {
  return domain === "lit-extract" ? makeLitExtractClarify() : makeChartReviewClarify();
}
function formGenFor(domain: Domain) {
  return domain === "lit-extract" ? makeLitExtractFormGen() : makeChartReviewFormGen();
}
function discoverFor(domain: Domain) {
  return domain === "lit-extract"
    ? makeLitExtractDiscover()
    : makeChartReviewDiscover({ corpusRoot: CORPUS_ROOT });
}

// ── route table ─────────────────────────────────────────────────────

type Handler = (body: unknown) => Promise<unknown>;
const routes: Record<string, Handler> = {
  "POST /api/v2/clarify": async (body) => {
    const { prompt, domain } = body as { prompt: string; domain: Domain };
    return clarifyFor(domain).clarify(prompt);
  },

  "POST /api/v2/form": async (body) => {
    const { task_spec } = body as { task_spec: TaskSpec };
    return formGenFor(task_spec.domain).generate(task_spec);
  },

  "POST /api/v2/discover": async (body) => {
    const { task_spec, subject } = body as { task_spec: TaskSpec; subject: SubjectRef };
    return discoverFor(task_spec.domain).discover(task_spec, subject);
  },

  "POST /api/v2/extract": async (body) => {
    const { form, subject, corpus, extractor_id, provider } = body as {
      form: FormSpec; subject: SubjectRef; corpus: EvidenceUnit[];
      extractor_id: string; provider?: ProviderName;
    };
    const extractor = makeV1AgentExtract({
      reviewsRoot: REVIEWS_ROOT,
      provider,
    });
    const output = await extractor.extract(form, subject, corpus, extractor_id);
    const faithfulness = verifyEvidenceFaithfulness(output, corpus);
    if (!faithfulness.ok) {
      throw httpError(422, "faithfulness violations", { violations: faithfulness.violations });
    }
    return output;
  },

  "POST /api/v2/reconcile": async (body) => {
    const { outputs, run_judge, judge_provider } = body as {
      outputs: ExtractorOutput[]; run_judge?: boolean; judge_provider?: ProviderName;
    };
    if (!outputs.length) throw httpError(400, "outputs[] is empty");
    const judge = run_judge
      ? makeV1Judge({
          taskId: outputs[0].task_id,
          patientId: outputs[0].subject_id,
          provider: judge_provider,
        })
      : undefined;
    return makeReconciler(judge).reconcile(outputs, { runJudge: run_judge });
  },

  "POST /api/v2/correct": async (body) => {
    const { task_id, subject_id, field_id, decision, seed } = body as {
      task_id: string; subject_id: string; field_id?: string;
      decision?: HumanDecision; seed?: unknown;
    };
    // Pull domain from task_id prefix is brittle; in practice the
    // caller would carry domain explicitly. For the MVP we route both
    // domains through chart-review's correct-log since they share the
    // same audit format.
    const correctLog = makeCorrectLog({ reviewsRoot: REVIEWS_ROOT });
    if (seed) {
      return correctLog.seed(seed as Parameters<typeof correctLog.seed>[0]);
    }
    if (!field_id || !decision) {
      throw httpError(400, "either { seed } or { field_id + decision } required");
    }
    return correctLog.recordDecision(task_id, subject_id, field_id, decision);
  },

  "POST /api/v2/run": async (body) => {
    const { prompt, subject, run_judge, domain } = body as {
      prompt: string; subject: SubjectRef; run_judge?: boolean; domain: Domain;
    };
    if (domain === "lit-extract") {
      const p = makeLitExtractPipeline({ reviewsRoot: REVIEWS_ROOT, runJudge: run_judge });
      return p.runOne(prompt, subject);
    }
    const p = makeChartReviewPipeline({
      corpusRoot: CORPUS_ROOT,
      reviewsRoot: REVIEWS_ROOT,
      runJudge: run_judge,
    });
    return p.runOne(prompt, subject);
  },

  "GET /api/v2/healthz": async () => ({ ok: true, modules: 6, reviewsRoot: REVIEWS_ROOT, corpusRoot: CORPUS_ROOT }),
};

// ── http plumbing ───────────────────────────────────────────────────

interface HttpError extends Error { status: number; payload?: unknown; }
function httpError(status: number, msg: string, payload?: unknown): HttpError {
  const e = new Error(msg) as HttpError;
  e.status = status;
  e.payload = payload;
  return e;
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  if (req.method === "GET") return null;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch { throw httpError(400, "invalid JSON body"); }
}

const server = http.createServer(async (req, res) => {
  const key = `${req.method} ${req.url}`;
  const handler = routes[key];
  res.setHeader("Content-Type", "application/json");
  if (!handler) {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: `no route ${key}` }));
    return;
  }
  try {
    const body = await readBody(req);
    const out = await handler(body);
    res.statusCode = 200;
    res.end(JSON.stringify(out));
  } catch (err) {
    const e = err as HttpError;
    res.statusCode = e.status ?? 500;
    res.end(JSON.stringify({ error: e.message, ...(e.payload ? { payload: e.payload } : {}) }));
  }
});

server.listen(PORT, () => {
  console.log(`chart-review-platform-v2 listening on http://localhost:${PORT}`);
  console.log(`reviewsRoot: ${REVIEWS_ROOT}`);
  console.log("routes:");
  for (const k of Object.keys(routes)) console.log("  " + k);
});
