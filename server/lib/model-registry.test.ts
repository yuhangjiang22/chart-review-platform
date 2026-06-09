// server/lib/model-registry.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadModelRegistry } from "./model-registry.js";

let dir: string;
let modelsPath: string;

const REGISTRY = {
  "gpt-5.2":   { backend: "codex",  model: "gpt-5.2",                    label: "GPT-5.2 (Azure)", api_key_env: "AZURE_OPENAI_API_KEY", default: true },
  "gpt-4o":    { backend: "codex",  model: "gpt-4o",                     label: "GPT-4o (Azure)",  api_key_env: "AZURE_OPENAI_API_KEY" },
  "haiku-4.5": { backend: "claude", model: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5", api_key_env: "ANTHROPIC_API_KEY" },
};

function writeRegistry(): string {
  const p = path.join(dir, "models.json");
  fs.writeFileSync(p, JSON.stringify(REGISTRY));
  return p;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "v2-reg-"));
  modelsPath = path.join(dir, "models.json");
  // Wipe the provider-relevant env so each test starts from a clean slate.
  vi.stubEnv("AGENT_PROVIDER", "");
  vi.stubEnv("AZURE_OPENAI_API_KEY", "");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("loadModelRegistry — file present", () => {
  it("codex active + AZURE key: codex entries available, claude unavailable, default is the marked codex entry", () => {
    writeRegistry();
    vi.stubEnv("AGENT_PROVIDER", "codex");
    vi.stubEnv("AZURE_OPENAI_API_KEY", "sekret-azure");

    const r = loadModelRegistry({ path: modelsPath });
    expect(r.active_provider).toBe("codex");
    const byId = Object.fromEntries(r.models.map((m) => [m.id, m]));
    expect(byId["gpt-5.2"].available).toBe(true);
    expect(byId["gpt-4o"].available).toBe(true);
    expect(byId["haiku-4.5"].available).toBe(false); // claude backend, codex active
    expect(r.default).toBe("gpt-5.2"); // marked default:true and available
  });

  it("claude active + ANTHROPIC_API_KEY: claude available, codex unavailable, default is the claude entry", () => {
    writeRegistry();
    vi.stubEnv("AGENT_PROVIDER", "claude");
    vi.stubEnv("ANTHROPIC_API_KEY", "sekret-anthropic");

    const r = loadModelRegistry({ path: modelsPath });
    expect(r.active_provider).toBe("claude");
    const byId = Object.fromEntries(r.models.map((m) => [m.id, m]));
    expect(byId["haiku-4.5"].available).toBe(true);
    expect(byId["gpt-5.2"].available).toBe(false);
    expect(byId["gpt-4o"].available).toBe(false);
    expect(r.default).toBe("haiku-4.5");
  });

  it("claude active with only ANTHROPIC_AUTH_TOKEN (no API_KEY): claude entry still available", () => {
    writeRegistry();
    vi.stubEnv("AGENT_PROVIDER", "claude");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "auth-token-only");

    const r = loadModelRegistry({ path: modelsPath });
    const byId = Object.fromEntries(r.models.map((m) => [m.id, m]));
    expect(byId["haiku-4.5"].available).toBe(true);
    expect(r.default).toBe("haiku-4.5");
  });

  it("no key for the active provider: all unavailable, default null", () => {
    writeRegistry();
    vi.stubEnv("AGENT_PROVIDER", "codex");
    // no AZURE_OPENAI_API_KEY

    const r = loadModelRegistry({ path: modelsPath });
    expect(r.models.every((m) => !m.available)).toBe(true);
    expect(r.default).toBeNull();
  });

  it("no-secrets: serialized result contains no api_key_env key nor any env-var-name string", () => {
    writeRegistry();
    vi.stubEnv("AGENT_PROVIDER", "codex");
    vi.stubEnv("AZURE_OPENAI_API_KEY", "sekret-azure");

    const r = loadModelRegistry({ path: modelsPath });
    const json = JSON.stringify(r);
    expect(json).not.toContain("api_key_env");
    expect(json).not.toContain("AZURE_OPENAI_API_KEY");
    expect(json).not.toContain("ANTHROPIC_API_KEY");
    expect(json).not.toContain("sekret-azure");
    // Per-entry keys are exactly the no-secret shape.
    for (const m of r.models) {
      expect(Object.keys(m).sort()).toEqual(["available", "backend", "id", "label", "model"]);
    }
  });
});

describe("loadModelRegistry — synthesis (file absent)", () => {
  it("claude active, file absent: synthesizes one claude entry from modelFor(default)", () => {
    vi.stubEnv("AGENT_PROVIDER", "claude");
    vi.stubEnv("ANTHROPIC_API_KEY", "sekret-anthropic");

    const r = loadModelRegistry({ path: path.join(dir, "absent.json") });
    expect(r.active_provider).toBe("claude");
    expect(r.models).toHaveLength(1);
    const entry = r.models[0];
    expect(entry.backend).toBe("claude");
    expect(entry.id).toBe("claude-default");
    expect(entry.available).toBe(true);
    expect(r.default).toBe("claude-default");
  });

  it("claude active, file absent, no key: synthesized entry unavailable, default null", () => {
    vi.stubEnv("AGENT_PROVIDER", "claude");

    const r = loadModelRegistry({ path: path.join(dir, "absent.json") });
    expect(r.models).toHaveLength(1);
    expect(r.models[0].available).toBe(false);
    expect(r.default).toBeNull();
  });

  it("codex active, file absent: synthesizes a single codex entry (shape)", () => {
    vi.stubEnv("AGENT_PROVIDER", "codex");
    vi.stubEnv("AZURE_OPENAI_API_KEY", "sekret-azure");

    const r = loadModelRegistry({ path: path.join(dir, "absent.json") });
    expect(r.active_provider).toBe("codex");
    expect(r.models).toHaveLength(1);
    expect(r.models[0].backend).toBe("codex");
    expect(r.models[0].available).toBe(true); // AZURE key present
  });
});

describe("loadModelRegistry — malformed file", () => {
  it("falls back to synthesis on malformed JSON (no throw)", () => {
    fs.writeFileSync(modelsPath, "{ not valid json ");
    vi.stubEnv("AGENT_PROVIDER", "claude");
    vi.stubEnv("ANTHROPIC_API_KEY", "sekret-anthropic");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = loadModelRegistry({ path: modelsPath });
    expect(r.models).toHaveLength(1);
    expect(r.models[0].backend).toBe("claude");
    expect(r.default).toBe("claude-default");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
