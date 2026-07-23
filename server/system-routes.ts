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
import type { RouteEntry } from "./router.js";
import { PLATFORM_ROOT } from "@chart-review/patients";

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
];
