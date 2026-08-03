// Direct-LLM NER extractor — public surface for the MVP.
//
// The MVP runs the *batch* path only: `extractSpansDirect` makes a
// direct LLM call per note (identify candidate spans → normalize each
// to an ontology concept) and writes the results to review_state.json
// via the mcp-core-ner disk-write helpers. No NER MCP server / agent
// loop is wired yet (deferred), so the agent-loop `ExtractorProfile`
// from v2 — which depended on `@chart-review/mcp-server-ner-anthropic`
// (not present in concur) — is intentionally omitted here.
//
// Transport is provider-pluggable via `llm-call.ts`: concur runs on
// OpenRouter (`/chat/completions`); Azure's Responses API is retained
// behind `mode: "azure-responses"`.

export { extractSpansDirect } from "./direct-llm-extract.js";
export type { DirectExtractOpts, DirectExtractResult } from "./direct-llm-extract.js";
export { normalizeSpanWithLLM, spanContext } from "./normalize-span.js";
export type { NormalizeSpanOpts, NormalizeSpanResult } from "./normalize-span.js";
export { callLlm } from "./llm-call.js";
export type { LlmEndpoint, LlmMode, LlmResult, LlmUsage } from "./llm-call.js";
