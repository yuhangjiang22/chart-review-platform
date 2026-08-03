// Re-export shim. Source moved to packages/agent-provider/ in O3.
// Call sites can keep importing from "./agent-provider.js"; new code
// should import from "@chart-review/agent-provider" directly.
export * from "@chart-review/agent-provider";
