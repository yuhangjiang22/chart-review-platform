// server/lib/model-registry.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listModels } from "./model-registry.js";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "reg-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const AZURE_ENV = {
  AZURE_OPENAI_ENDPOINT: "https://x", AZURE_OPENAI_API_KEY: "secret",
  AZURE_OPENAI_DEPLOYMENT: "gpt-4o", DEEPAGENTS_LLM_BACKEND: "azure",
} as NodeJS.ProcessEnv;

describe("listModels", () => {
  it("synthesizes azure default when no file", () => {
    const { models, default: def } = listModels({ env: AZURE_ENV, modelsPath: path.join(dir, "absent.json") });
    expect(def).toBe("gpt-4o");
    expect(models).toEqual([{ id: "gpt-4o", backend: "azure", label: "azure · gpt-4o", available: true }]);
  });

  it("marks azure unavailable when key missing", () => {
    const env = { AZURE_OPENAI_ENDPOINT: "https://x", AZURE_OPENAI_DEPLOYMENT: "gpt-4o", DEEPAGENTS_LLM_BACKEND: "azure" } as NodeJS.ProcessEnv;
    const { models, default: def } = listModels({ env, modelsPath: path.join(dir, "absent.json") });
    expect(def).toBeNull();
    expect(models[0].available).toBe(false);
  });

  it("reads file and picks marked default; never leaks secrets", () => {
    const p = path.join(dir, "models.json");
    fs.writeFileSync(p, JSON.stringify({
      "gpt-4o": { backend: "azure", deployment: "gpt-4o" },
      "llama": { backend: "vllm", base_url: "http://h:8000/v1", model: "meta/Llama", default: true },
    }));
    const { models, default: def } = listModels({ env: AZURE_ENV, modelsPath: p });
    expect(def).toBe("llama");
    expect(JSON.stringify(models)).not.toContain("secret");
    expect(models.find((m) => m.id === "llama")!.label).toBe("vllm · meta/Llama");
  });

  it("falls through to synthesis on malformed json", () => {
    const p = path.join(dir, "models.json");
    fs.writeFileSync(p, "{ not valid json ");
    const { models, default: def } = listModels({ env: AZURE_ENV, modelsPath: p });
    expect(def).toBe("gpt-4o");
    expect(models[0].id).toBe("gpt-4o");
  });
});
