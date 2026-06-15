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
    expect(models.find((m) => m.id === "llama")!.available).toBe(true);
  });

  it("synthesizes vllm default when no file and backend is vllm", () => {
    const env = { DEEPAGENTS_LLM_BACKEND: "vllm", VLLM_BASE_URL: "http://h:8000/v1", VLLM_MODEL: "meta/Llama" } as NodeJS.ProcessEnv;
    const { models, default: def } = listModels({ env, modelsPath: path.join(dir, "absent.json") });
    expect(def).toBe("meta/Llama");
    expect(models).toEqual([{ id: "meta/Llama", backend: "vllm", label: "vllm · meta/Llama", available: true }]);
  });

  it("falls through to synthesis on malformed json", () => {
    const p = path.join(dir, "models.json");
    fs.writeFileSync(p, "{ not valid json ");
    const { models, default: def } = listModels({ env: AZURE_ENV, modelsPath: p });
    expect(def).toBe("gpt-4o");
    expect(models[0].id).toBe("gpt-4o");
  });

  it("marks vllm unavailable when base_url is the example placeholder", () => {
    const p = path.join(dir, "models.json");
    fs.writeFileSync(p, JSON.stringify({
      "qwen3-32b": { backend: "vllm", base_url_env: "VLLM_BASE_URL", model: "qwen3-32b", default: true },
    }));
    const env = { DEEPAGENTS_LLM_BACKEND: "vllm", VLLM_BASE_URL: "http://your-vllm-host:8000/v1" } as NodeJS.ProcessEnv;
    const { models, default: def } = listModels({ env, modelsPath: p });
    expect(models[0].available).toBe(false);
    expect(def).toBeNull();
  });

  it("marks vllm available when base_url is a real host", () => {
    const p = path.join(dir, "models.json");
    fs.writeFileSync(p, JSON.stringify({
      "qwen3-32b": { backend: "vllm", base_url_env: "VLLM_BASE_URL", model: "qwen3-32b", default: true },
    }));
    const env = { DEEPAGENTS_LLM_BACKEND: "vllm", VLLM_BASE_URL: "http://gpu1.hpc:8000/v1" } as NodeJS.ProcessEnv;
    const { models, default: def } = listModels({ env, modelsPath: p });
    expect(models[0].available).toBe(true);
    expect(def).toBe("qwen3-32b");
  });

  it("marks azure unavailable when endpoint is the example placeholder", () => {
    const env = {
      DEEPAGENTS_LLM_BACKEND: "azure", AZURE_OPENAI_DEPLOYMENT: "gpt-4o",
      AZURE_OPENAI_ENDPOINT: "https://YOUR-RESOURCE.openai.azure.com", AZURE_OPENAI_API_KEY: "secret",
    } as NodeJS.ProcessEnv;
    const { models } = listModels({ env, modelsPath: path.join(dir, "absent.json") });
    expect(models[0].available).toBe(false);
  });

  it("marks azure unavailable for the bare-metal .env.example placeholder (<resource>)", () => {
    const env = {
      DEEPAGENTS_LLM_BACKEND: "azure", AZURE_OPENAI_DEPLOYMENT: "gpt-4o",
      AZURE_OPENAI_ENDPOINT: "https://<resource>.openai.azure.com/", AZURE_OPENAI_API_KEY: "secret",
    } as NodeJS.ProcessEnv;
    const { models } = listModels({ env, modelsPath: path.join(dir, "absent.json") });
    expect(models[0].available).toBe(false);
  });

  it("marks vllm unavailable when an inline base_url literal is a placeholder", () => {
    const p = path.join(dir, "models.json");
    fs.writeFileSync(p, JSON.stringify({
      "qwen3-32b": { backend: "vllm", base_url: "http://your-vllm-host:8000/v1", model: "qwen3-32b", default: true },
    }));
    const { models, default: def } = listModels({ env: {} as NodeJS.ProcessEnv, modelsPath: p });
    expect(models[0].available).toBe(false);
    expect(def).toBeNull();
  });

  it("synthesizes vllm as unavailable when VLLM_BASE_URL is the placeholder", () => {
    const env = { DEEPAGENTS_LLM_BACKEND: "vllm", VLLM_BASE_URL: "http://your-vllm-host:8000/v1" } as NodeJS.ProcessEnv;
    const { models, default: def } = listModels({ env, modelsPath: path.join(dir, "absent.json") });
    expect(models[0].available).toBe(false);
    expect(def).toBeNull();
  });
});
