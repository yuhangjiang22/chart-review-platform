// Module 4: Extraction.
//
// Runs one extractor over the form against the corpus. The workflow
// drivers call this N times in parallel with different extractor_id
// (and typically different LLM models) — that's how the dual-extractor
// "agent_default vs agent_skeptical" / "extractor_a vs extractor_b"
// pattern works.
//
// Both adapters share the same faithfulness wrapper: every cited
// span MUST byte-match the EvidenceUnit it points into, else the
// FieldAssessment is rejected. That's the chart-review MCP gate
// generalized.

export type { ExtractModule, ExtractorOutput, FieldAssessment, EvidenceRef } from "../../shared/types.js";

export { verifyEvidenceFaithfulness } from "./faithfulness.js";
// makeV1AgentExtract wraps v1's runAgent (Claude/Codex swappable,
// MCP-backed, faithfulness gated at the MCP boundary). It is the
// only extractor — v2 always uses real LLM runs.
export { makeV1AgentExtract } from "./v1-agent-extract.js";
