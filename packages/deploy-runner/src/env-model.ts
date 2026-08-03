// packages/deploy-runner/src/env-model.ts
/** Resolve the model the deepagents sidecar will actually use, from env. */
export function resolveEnvModel(env: NodeJS.ProcessEnv = process.env): { backend: string; model: string | null } {
  const backend = (env.DEEPAGENTS_LLM_BACKEND ?? "azure").toLowerCase();
  if (backend === "azure") return { backend, model: env.AZURE_OPENAI_DEPLOYMENT ?? null };
  if (backend === "vllm") return { backend, model: env.VLLM_MODEL ?? null };
  return { backend, model: null };
}
