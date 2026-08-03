// Re-export shim. Source moved to packages/agent-compose/ in O2.
// Call sites can keep importing from "./compose-agent.js"; new code
// should import from "@chart-review/agent-compose" directly.
export * from "@chart-review/agent-compose";
