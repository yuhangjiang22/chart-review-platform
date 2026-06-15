import { describe, it, expect } from "vitest";
import { resolveEnvModel } from "./env-model.js";

describe("resolveEnvModel", () => {
  it("azure → AZURE_OPENAI_DEPLOYMENT", () => {
    expect(resolveEnvModel({ DEEPAGENTS_LLM_BACKEND: "azure", AZURE_OPENAI_DEPLOYMENT: "gpt-4o" } as NodeJS.ProcessEnv))
      .toEqual({ backend: "azure", model: "gpt-4o" });
  });
  it("vllm → VLLM_MODEL", () => {
    expect(resolveEnvModel({ DEEPAGENTS_LLM_BACKEND: "vllm", VLLM_MODEL: "meta/Llama" } as NodeJS.ProcessEnv))
      .toEqual({ backend: "vllm", model: "meta/Llama" });
  });
  it("defaults to azure backend when unset", () => {
    expect(resolveEnvModel({ AZURE_OPENAI_DEPLOYMENT: "gpt-4o" } as NodeJS.ProcessEnv))
      .toEqual({ backend: "azure", model: "gpt-4o" });
  });
  it("unknown backend → null model", () => {
    expect(resolveEnvModel({ DEEPAGENTS_LLM_BACKEND: "nope" } as NodeJS.ProcessEnv))
      .toEqual({ backend: "nope", model: null });
  });
});
