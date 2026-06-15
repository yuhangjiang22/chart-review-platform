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
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Default: the source client dir (used with the Vite dev server in front).
// Set CHART_REVIEW_CLIENT_DIR to a built bundle (e.g. dist/client) to serve
// the UI statically straight from this server — no Vite dev server, no HMR
// WebSocket, so no page-reload loop when reached through a relay/tunnel.
const CLIENT_DIR = process.env.CHART_REVIEW_CLIENT_DIR
  ? path.resolve(process.env.CHART_REVIEW_CLIENT_DIR)
  : path.resolve(__dirname, "..", "client");

// Load env from v2's own .env. v2 owns its secrets — keys that used to
// live in v1's chart-review-platform/app/.env were migrated into this
// file (see the "Migrated from v1's app/.env" section in .env). The
// previous v1-fallback load (with PORT excluded) was removed in the
// independence pass; v2 no longer reads from ../chart-review-platform/.
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

// As of M7.5 every UI-consumed surface lives in v2 natively (HTTP +
// WebSocket + builder). No proxy fallback to v1 remains; unmatched
// /api/* paths get a 404.
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
import {
  login, logout, readTokenFromRequest, requireMethodologist, whoami,
} from "./auth.js";
import { makeRouter } from "./router.js";
import { pilotReadRoutes, pilotWriteRoutes, versionsRoutes } from "./pilot-routes.js";
import { sessionRoutes } from "./session-routes.js";
import { packageRoutes } from "./package-routes.js";
import { performanceRoutes } from "./performance-routes.js";
import { nerCalibrationRoutes } from "./ner-calibration-routes.js";
import { adherenceIaaRoutes } from "./adherence-iaa-routes.js";
import { issueRoutes } from "./issue-routes.js";
import { cohortRoutes } from "./cohort-routes.js";
import { coreRoutes, type RawBody, type SSEStream } from "./core-routes.js";
import { reconcilePilotStatesOnStartup } from "./lib/domain/iter/index.js";
import { miscRoutes } from "./misc-routes.js";
import { jobsRoutes } from "./jobs-routes.js";
import { authoringRoutes } from "./authoring-routes.js";
import { feedbackRoutes } from "./feedback-routes.js";
import { runRoutes } from "./run-routes.js";
import { reviewRoutes } from "./review-routes.js";
import { adherenceRoutes } from "./adherence-routes.js";
import { phasesRoutes } from "./phases-routes.js";
import { scaffoldRoutes } from "./scaffold-routes.js";
import { rubricRoutes } from "./rubric-routes.js";
import { exportRoutes } from "./export-routes.js";
import { refineRoutes } from "./refine-routes.js";
import { adherenceRubricRoutes } from "./adherence-rubric-routes.js";
import { attachWebSocketServer, registerBroadcasters } from "./ws.js";
import {
  isBuilderPath, delegateBuilder,
  isBuilderUpgradePath, handleBuilderUpgrade,
} from "./builder-bridge.js";

const PORT = Number(process.env.PORT ?? 3002);
const REVIEWS_ROOT = process.env.CHART_REVIEW_REVIEWS_ROOT
  ?? path.join(process.cwd(), "var", "reviews");
const PLATFORM_ROOT = process.env.CHART_REVIEW_PLATFORM_ROOT
  ?? path.resolve(__dirname, "..");
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

type Handler = (body: unknown, req: http.IncomingMessage) => Promise<unknown>;
const routes: Record<string, Handler> = {
  // ── auth ────────────────────────────────────────────────────────
  "POST /api/auth/login": async (body) => {
    const reviewer_id = (body as { reviewer_id?: string })?.reviewer_id ?? "";
    return login(reviewer_id);
  },
  "POST /api/auth/logout": async (_body, req) => {
    const token = readTokenFromRequest(req) ?? "";
    logout(token);
    return { ok: true };
  },
  "GET /api/auth/whoami": async (_body, req) => whoami(req),

  // ── v2 modules (some methodologist-gated, like v1) ──────────────
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

  "POST /api/v2/correct": requireMethodologist(async (body) => {
    const { task_id, subject_id, field_id, decision, seed } = body as {
      task_id: string; subject_id: string; field_id?: string;
      decision?: HumanDecision; seed?: unknown;
    };
    const correctLog = makeCorrectLog({ reviewsRoot: REVIEWS_ROOT });
    if (seed) {
      return correctLog.seed(seed as Parameters<typeof correctLog.seed>[0]);
    }
    if (!field_id || !decision) {
      throw httpError(400, "either { seed } or { field_id + decision } required");
    }
    return correctLog.recordDecision(task_id, subject_id, field_id, decision);
  }),

  "POST /api/v2/run": requireMethodologist(async (body) => {
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
  }),

  "GET /api/v2/healthz": async () => ({ ok: true, modules: 6, reviewsRoot: REVIEWS_ROOT, corpusRoot: CORPUS_ROOT }),
};

// Parameterized routes (have :taskId / :iterId path params) — checked
// after the exact-match `routes` table, before the v1 proxy fallback.
const paramRouter = makeRouter([
  ...pilotReadRoutes,
  ...pilotWriteRoutes,
  ...versionsRoutes,
  ...sessionRoutes,
  ...packageRoutes,
  ...performanceRoutes,
  ...nerCalibrationRoutes,
  ...adherenceIaaRoutes,
  ...issueRoutes,
  ...cohortRoutes,
  ...coreRoutes,
  ...miscRoutes,
  ...jobsRoutes,
  ...authoringRoutes,
  ...feedbackRoutes,
  ...runRoutes,
  ...reviewRoutes,
  ...adherenceRoutes,
  ...phasesRoutes,
  ...scaffoldRoutes,
  ...rubricRoutes,
  ...exportRoutes,
  ...refineRoutes,
  ...adherenceRubricRoutes,
]);

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
  const url = req.url ?? "/";
  // 0. /api/builder/* — delegate to the Express bridge (vendored
  //    builder-routes.ts depends on Express + multer; cheaper than
  //    rewriting every endpoint into our parameterized router).
  if (isBuilderPath(url)) {
    delegateBuilder(req, res);
    return;
  }
  const key = `${req.method} ${url.split("?")[0]}`;
  const handler = routes[key];

  // 1a. v2 native exact-match routes win.
  // 1b. v2 parameterized routes (pilots, versions, …) — match on
  //     path, decode params, call with (body, req, params, query).
  // 2.  Anything else under /api/ or /ws/ → proxy to v1 (until ported).
  if (!handler) {
    const matched = paramRouter.match(req.method ?? "GET", url);
    if (matched) {
      try {
        const body = await readBody(req);
        const out = await matched.handler(body, req, matched.params, matched.query);
        // SSEStream escape hatch: handlers returning { __sse: true, generator }
        // pump the generator as text/event-stream and leave content-type
        // / end management to the writer here. Used by prelock-summary
        // and suggest-override-reason stream endpoints.
        const sse = out as Partial<SSEStream>;
        if (sse && sse.__sse === true && sse.generator) {
          res.setHeader("Content-Type", "text/event-stream");
          res.setHeader("Cache-Control", "no-cache, no-transform");
          res.setHeader("Connection", "keep-alive");
          res.setHeader("X-Accel-Buffering", "no");
          res.statusCode = 200;
          res.flushHeaders?.();
          try {
            for await (const ev of sse.generator) {
              res.write(`data: ${JSON.stringify(ev)}\n\n`);
            }
          } catch (streamErr) {
            res.write(`data: ${JSON.stringify({ type: "error", error: String(streamErr) })}\n\n`);
          } finally {
            res.end();
          }
          return;
        }
        // RawBody escape hatch: handlers returning { __raw: true, contentType, body }
        // skip JSON.stringify and use the requested content-type. Used by
        // text/plain note bodies AND binary downloads (tarballs, etc).
        // For Buffer bodies the write must NOT go through Node's default
        // string encoding — that re-encodes bytes >0x7F as UTF-8
        // sequences and corrupts gzip / tar headers.
        const raw = out as Partial<RawBody>;
        if (raw && raw.__raw === true) {
          if (Buffer.isBuffer(raw.body)) {
            res.setHeader("Content-Type", raw.contentType ?? "application/octet-stream");
            res.statusCode = 200;
            res.end(raw.body);
          } else if (typeof raw.body === "string") {
            res.setHeader("Content-Type", raw.contentType ?? "text/plain; charset=utf-8");
            res.statusCode = 200;
            res.end(raw.body);
          } else {
            res.setHeader("Content-Type", "application/json");
            res.statusCode = 500;
            res.end(JSON.stringify({ error: "raw body must be string or Buffer" }));
          }
        } else {
          res.setHeader("Content-Type", "application/json");
          res.statusCode = 200;
          res.end(JSON.stringify(out));
        }
      } catch (err) {
        res.setHeader("Content-Type", "application/json");
        const e = err as HttpError;
        res.statusCode = e.status ?? 500;
        res.end(JSON.stringify({ error: e.message, ...(e.payload ? { payload: e.payload } : {}) }));
      }
      return;
    }
    // Unmatched /api/* in v2 → 404. No more proxy fallback.
    if (url.startsWith("/api/")) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: `no route ${req.method} ${url}` }));
      return;
    }
  }

  // 3. Static UI: served from <CLIENT_DIR> (vendored from v1 in M5).
  if (req.method === "GET" && !url.startsWith("/api/")) {
    const reqPath = url === "/" ? "/index.html" : url;
    const filePath = path.join(CLIENT_DIR, reqPath);
    if (!filePath.startsWith(CLIENT_DIR)) {
      res.statusCode = 403;
      res.end("forbidden");
      return;
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath);
      const ct: Record<string, string> = {
        ".html": "text/html; charset=utf-8",
        ".js": "application/javascript",
        ".mjs": "application/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".svg": "image/svg+xml",
      };
      res.setHeader("Content-Type", ct[ext] ?? "application/octet-stream");
      res.statusCode = 200;
      fs.createReadStream(filePath).pipe(res);
      return;
    }
    // SPA fallback: unknown asset → serve index.html so client-side
    // routing can handle it.
    const fallback = path.join(CLIENT_DIR, "index.html");
    if (fs.existsSync(fallback)) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.statusCode = 200;
      fs.createReadStream(fallback).pipe(res);
      return;
    }
  }

  res.setHeader("Content-Type", "application/json");
  if (!handler) {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: `no route ${key}` }));
    return;
  }
  try {
    const body = await readBody(req);
    const out = await handler(body, req);
    res.statusCode = 200;
    res.end(JSON.stringify(out));
  } catch (err) {
    const e = err as HttpError;
    res.statusCode = e.status ?? 500;
    res.end(JSON.stringify({ error: e.message, ...(e.payload ? { payload: e.payload } : {}) }));
  }
});

// WebSocket /ws — v2-native (M7.3). v1's proxy fallback is gone.
// Routes still proxied to v1 (HTTP only): /api/builder/* until M7.4.
const wsServer = attachWebSocketServer(server);
registerBroadcasters(wsServer);
server.on("upgrade", (req, socket, head) => {
  if (req.url?.startsWith("/ws")) {
    wsServer.handleUpgrade(req, socket, head);
    return;
  }
  // /api/builder/sessions/:taskId/stream — v2-native via the bridge.
  if (isBuilderUpgradePath(req.url)) {
    handleBuilderUpgrade(req, socket, head);
    return;
  }
  socket.destroy();
});

server.listen(PORT, () => {
  console.log(`chart-review-platform-concur listening on http://localhost:${PORT}`);
  console.log(`reviewsRoot: ${REVIEWS_ROOT}`);
  // Catch any pilot iters that finished while the server was down and got
  // stuck in "running". v1 does this on boot; the screenshot of a 100%-
  // complete iter still marked RUNNING is the bug this prevents.
  try {
    reconcilePilotStatesOnStartup();
  } catch (err) {
    console.warn("[startup] reconcilePilotStatesOnStartup failed:", (err as Error).message);
  }
  console.log("routes:");
  for (const k of Object.keys(routes)) console.log("  " + k);
});
