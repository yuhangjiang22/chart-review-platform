// System / service-health routes — power the UI's service-health banner so a
// user sees at a glance whether the runtime services are up, instead of
// discovering a dead NER proxy via a failed run.
//
//   GET  /api/system/health       — liveness of proxy (:18080), workbench
//                                    (:18090), the Python sidecar venv, and
//                                    whether a model backend is configured.
//                                    Returns NO secret values and makes NO
//                                    model call (so it's cheap to poll).
//   POST /api/system/proxy/start  — adopt-or-spawn the vendored Claude→OpenAI
//                                    proxy the NER-SDK runs talk to, so nobody
//                                    has to run `uvicorn` by hand.
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import type { IncomingMessage } from "node:http";
import type { RouteEntry } from "./router.js";
import { PLATFORM_ROOT } from "@chart-review/patients";
import { isMethodologist, readReviewerFromRequest } from "./auth.js";

const PROXY_PORT = 18080;
const WORKBENCH_PORT = 18090;
const VENDOR = path.join(PLATFORM_ROOT, "vendor", "bso-ad-sdk");

function httpErr(status: number, message: string): Error & { status: number } {
  const e = new Error(message) as Error & { status: number };
  e.status = status;
  return e;
}

function checkTcp(host: string, port: number, ms = 800): Promise<boolean> {
  return new Promise((res) => {
    const s = net.connect({ host, port });
    const done = (ok: boolean) => { s.destroy(); res(ok); };
    s.setTimeout(ms);
    s.on("connect", () => done(true));
    s.on("timeout", () => done(false));
    s.on("error", () => done(false));
  });
}

/** Read .env KEY=value pairs. Used ONLY to report which keys are *present*
 *  (booleans) + non-secret values (backend name, deployment/model id). Secret
 *  values are never returned to the client. */
function readEnvFile(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const raw of fs.readFileSync(path.join(PLATFORM_ROOT, ".env"), "utf-8").split("\n")) {
      const l = raw.trim();
      if (!l || l.startsWith("#")) continue;
      const eq = l.indexOf("=");
      if (eq < 0) continue;
      out[l.slice(0, eq).trim()] = l.slice(eq + 1).trim();
    }
  } catch { /* .env is optional */ }
  return out;
}

// ── Config (Settings page) ──────────────────────────────────────────────────
// The ONLY .env keys the Settings UI may read/write. An allowlist so a config
// PUT can never write arbitrary env keys.
const MANAGED_KEYS = [
  "DEEPAGENTS_LLM_BACKEND",
  "AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_API_VERSION", "AZURE_OPENAI_DEPLOYMENT", "AZURE_OPENAI_API_KEY",
  "VLLM_BASE_URL", "VLLM_MODEL", "VLLM_API_KEY",
  "CHART_REVIEW_MODEL", "CHART_REVIEW_JUDGE_MODEL", "CHART_REVIEW_PHI_MODEL",
] as const;
const isSecretKey = (k: string) => /KEY|SECRET|TOKEN|PASSWORD/i.test(k);

/** Never return a secret's value — only whether it's set + a short tail hint. */
function maskSecret(v: string | undefined): { set: boolean; hint: string | null } {
  if (!v) return { set: false, hint: null };
  return { set: true, hint: v.length > 4 ? "…" + v.slice(-4) : "…" };
}

/** Update KEY=value pairs in .env atomically, preserving comments/order.
 *  Existing keys are replaced in place; new keys appended. */
function writeEnvKeys(updates: Record<string, string>): void {
  const envPath = path.join(PLATFORM_ROOT, ".env");
  let lines: string[] = [];
  try { lines = fs.readFileSync(envPath, "utf-8").split("\n"); } catch { /* new file */ }
  const remaining = new Set(Object.keys(updates));
  const out = lines.map((line) => {
    const m = line.match(/^([A-Z0-9_]+)=/);
    if (m && remaining.has(m[1])) {
      remaining.delete(m[1]);
      return `${m[1]}=${updates[m[1]]}`;
    }
    return line;
  });
  for (const k of remaining) out.push(`${k}=${updates[k]}`);
  const tmp = envPath + ".tmp";
  fs.writeFileSync(tmp, out.join("\n"));
  fs.renameSync(tmp, envPath); // atomic replace
}

async function testChatOnce(env: Record<string, string>): Promise<{ ok: boolean; status: number; detail: string }> {
  const backend = (env.DEEPAGENTS_LLM_BACKEND || "azure").toLowerCase();
  try {
    if (backend === "vllm") {
      // OpenAI-compatible: a models-list GET validates key + reachability, zero token cost.
      const base = (env.VLLM_BASE_URL || "").replace(/\/$/, "");
      if (!base) return { ok: false, status: 0, detail: "VLLM_BASE_URL not set" };
      const r = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${env.VLLM_API_KEY || ""}` } });
      return { ok: r.ok, status: r.status, detail: r.ok ? "reachable + key accepted" : (await r.text()).slice(0, 160) };
    }
    // azure: a max_tokens:1 chat completion against the deployment.
    const ep = (env.AZURE_OPENAI_ENDPOINT || "").replace(/\/$/, "");
    const dep = env.AZURE_OPENAI_DEPLOYMENT, ver = env.AZURE_OPENAI_API_VERSION || "2024-06-01";
    if (!ep || !dep) return { ok: false, status: 0, detail: "AZURE_OPENAI_ENDPOINT / _DEPLOYMENT not set" };
    const r = await fetch(`${ep}/openai/deployments/${dep}/chat/completions?api-version=${ver}`, {
      method: "POST",
      headers: { "api-key": env.AZURE_OPENAI_API_KEY || "", "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "ping" }], max_tokens: 1 }),
    });
    return { ok: r.ok, status: r.status, detail: r.ok ? "deployment responded" : (await r.text()).slice(0, 160) };
  } catch (e) {
    return { ok: false, status: 0, detail: String((e as Error).message).slice(0, 160) };
  }
}

function gateMethodologist(req: IncomingMessage, action: string): void {
  if (!isMethodologist(readReviewerFromRequest(req))) {
    throw httpErr(403, `not authorized to ${action}`);
  }
}

export const systemRoutes: RouteEntry[] = [
  {
    method: "GET",
    pattern: "/api/system/health",
    handler: async () => {
      const env = { ...readEnvFile(), ...process.env } as Record<string, string>;
      const [proxyUp, workbenchUp] = await Promise.all([
        checkTcp("127.0.0.1", PROXY_PORT),
        checkTcp("127.0.0.1", WORKBENCH_PORT),
      ]);
      const backend = (env.DEEPAGENTS_LLM_BACKEND || "azure").toLowerCase();
      // Model config PRESENCE only — no secret value, no network/model call, so
      // this endpoint stays cheap enough to poll every few seconds.
      const modelConfigured = backend === "vllm"
        ? Boolean(env.VLLM_BASE_URL && env.VLLM_MODEL)
        : Boolean(env.AZURE_OPENAI_ENDPOINT && env.AZURE_OPENAI_DEPLOYMENT);
      const sidecarPy = env.DEEPAGENTS_PYTHON;
      return {
        ok: true,
        api: true,
        proxy: { up: proxyUp, port: PROXY_PORT },
        workbench: { up: workbenchUp, port: WORKBENCH_PORT },
        sidecar: {
          configured: Boolean(sidecarPy),
          venv_present: sidecarPy ? fs.existsSync(sidecarPy) : false,
        },
        model: {
          backend,
          configured: modelConfigured,
          // deployment / model id is not a secret
          id: backend === "vllm" ? (env.VLLM_MODEL || null) : (env.AZURE_OPENAI_DEPLOYMENT || null),
        },
      };
    },
  },
  {
    method: "POST",
    pattern: "/api/system/proxy/start",
    handler: async () => {
      if (await checkTcp("127.0.0.1", PROXY_PORT)) {
        return { ok: true, already_running: true, up: true, port: PROXY_PORT };
      }
      const uvicorn = path.join(VENDOR, ".venv", "bin", "uvicorn");
      if (!fs.existsSync(uvicorn)) {
        throw httpErr(500, "vendored proxy venv not found at vendor/bso-ad-sdk/.venv — run the sidecar setup first");
      }
      const logDir = path.join(PLATFORM_ROOT, "var");
      fs.mkdirSync(logDir, { recursive: true });
      const logFd = fs.openSync(path.join(logDir, "proxy.log"), "a");
      // The proxy picks its upstream provider from the ANTHROPIC_API_KEY prefix.
      // The platform's own ANTHROPIC_API_KEY is a control-plane token (not a
      // provider key), so unset it in the child — the proxy reads the provider
      // key from vendor/bso-ad-sdk/.env instead.
      const env: Record<string, string | undefined> = { ...process.env };
      delete env.ANTHROPIC_API_KEY;
      const child = spawn(
        uvicorn,
        ["claude_proxy.proxy:app", "--host", "127.0.0.1", "--port", String(PROXY_PORT)],
        { cwd: VENDOR, env, detached: true, stdio: ["ignore", logFd, logFd] },
      );
      child.unref();
      // Wait up to ~4s for it to bind so the caller gets an accurate result.
      let up = false;
      for (let i = 0; i < 8; i++) {
        if (await checkTcp("127.0.0.1", PROXY_PORT)) { up = true; break; }
        await new Promise((r) => setTimeout(r, 500));
      }
      return { ok: up, started: true, up, port: PROXY_PORT };
    },
  },
  {
    method: "GET",
    pattern: "/api/system/config",
    handler: async () => {
      const env = { ...readEnvFile(), ...process.env } as Record<string, string>;
      const backend = (env.DEEPAGENTS_LLM_BACKEND || "azure").toLowerCase();
      return {
        backend,
        azure: {
          endpoint: env.AZURE_OPENAI_ENDPOINT || "",
          api_version: env.AZURE_OPENAI_API_VERSION || "",
          deployment: env.AZURE_OPENAI_DEPLOYMENT || "",
          key: maskSecret(env.AZURE_OPENAI_API_KEY),
        },
        vllm: {
          base_url: env.VLLM_BASE_URL || "",
          model: env.VLLM_MODEL || "",
          key: maskSecret(env.VLLM_API_KEY),
        },
        models: {
          default: env.CHART_REVIEW_MODEL || "",
          judge: env.CHART_REVIEW_JUDGE_MODEL || "",
          phi: env.CHART_REVIEW_PHI_MODEL || "",
        },
      };
    },
  },
  {
    method: "PUT",
    pattern: "/api/system/config",
    handler: async (body, req) => {
      gateMethodologist(req as IncomingMessage, "change platform configuration");
      const b = (body ?? {}) as Record<string, unknown>;
      const updates: Record<string, string> = {};
      for (const [k, v] of Object.entries(b)) {
        if (!MANAGED_KEYS.includes(k as (typeof MANAGED_KEYS)[number])) {
          throw httpErr(400, `key not allowed: ${k}`);
        }
        if (typeof v !== "string") continue;
        const val = v.trim();
        // Skip empties (so a blank field never clobbers an existing value —
        // in particular a masked secret the user didn't retype).
        if (!val) continue;
        if (k === "DEEPAGENTS_LLM_BACKEND" && val !== "azure" && val !== "vllm") {
          throw httpErr(400, "DEEPAGENTS_LLM_BACKEND must be 'azure' or 'vllm'");
        }
        updates[k] = val;
      }
      if (Object.keys(updates).length === 0) return { ok: true, changed: [] };
      writeEnvKeys(updates);
      // Apply live so the next run/model-config read picks it up without a
      // server restart (spawned children inherit process.env).
      for (const [k, v] of Object.entries(updates)) process.env[k] = v;
      // Return the changed KEY NAMES only — never the values (secrets).
      return { ok: true, changed: Object.keys(updates).sort() };
    },
  },
  {
    method: "POST",
    pattern: "/api/system/config/test",
    handler: async () => {
      const env = { ...readEnvFile(), ...process.env } as Record<string, string>;
      return await testChatOnce(env);
    },
  },
];
