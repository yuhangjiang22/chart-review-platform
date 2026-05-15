// NER extractor profile for the pipeline-extract hook.
//
// Plugs into `@chart-review/pipeline-extract`'s Phase-0.4
// `ExtractorProfile` slot. When `task_kind === "ner"` the run-routes
// dispatcher passes this profile to `makeV1AgentExtract` instead of
// the default phenotype profile, so the extractor:
//
//   - builds the NER MCP server (chart_review_ner) via the anthropic
//     adapter's transport selector (in-process for Claude, stdio for
//     Codex) — same agent loop, different tool surface
//   - issues the bso-ad-shaped batch prompt
//   - reads `span_labels[]` from scratch state instead of `field_assessments[]`

import fs from "node:fs";
import path from "node:path";
import { listNotes } from "@chart-review/patients";
import { buildNerMcpServersConfig } from "@chart-review/mcp-server-ner-anthropic";
import type {
  ExtractorProfile, ExtractorProfileContext,
} from "@chart-review/pipeline-extract";
import type { SpanLabel } from "@chart-review/platform-types";

/**
 * The NER profile. Stateless — same instance handles every run.
 * Replace `pipeline-extract`'s `defaultPhenotypeProfile` with this one
 * when invoking `makeV1AgentExtract` for an NER task.
 */
export const nerExtractorProfile: ExtractorProfile = {
  id: "v1-agent-ner",
  buildMcpServers(ctx: ExtractorProfileContext) {
    return buildNerMcpServersConfig(
      ctx.subject.id,
      ctx.task,
      ctx.sessionId,
      { onStateUpdate: () => {} },
      {
        reviewsRoot: ctx.scratchRoot,
        provider: ctx.provider,
      },
    );
  },
  buildPrompt(ctx: ExtractorProfileContext) {
    const { task, subject } = ctx;
    // Enumerate the patient's notes so the agent can plan per-note
    // extraction. listNotes returns NoteListing[] with filename/date/doctype.
    let noteSummary = "";
    try {
      const notes = listNotes(subject.id);
      noteSummary = notes
        .map((n) => `  - ${n.filename.replace(/\.txt$/, "")}` +
          (n.date ? ` (${n.date})` : "") +
          (n.doctype ? ` [${n.doctype}]` : ""))
        .join("\n");
    } catch {
      noteSummary = "  (note listing unavailable; explore the cwd directly)";
    }
    return [
      "You are running an NER (named-entity recognition) task in batch mode.",
      "Activate the `chart-review-ner` universal skill.",
      `If a skill named \`chart-review-${task.task_id}\` exists (e.g. the bso-ad scope skill), activate it as well — it carries the ontology + annotation guidance for THIS task.`,
      "",
      `Active subject: ${subject.type} ${subject.id}`,
      `Active task: ${task.task_id} (task_kind=ner)`,
      "",
      "Notes for this patient (each is a .txt file in your cwd):",
      noteSummary,
      "",
      "Workflow:",
      "1. Call `list_entity_types` once to discover the supported BSO-AD-style root labels.",
      "2. For each note, identify candidate entity spans. For each candidate:",
      "   a. Call `normalize_to_ontology(entity_type, label)` to get the canonical concept_name.",
      "      - If found=true, use the returned concept_name and status='mapped'.",
      "      - If found=false with alternatives, optionally re-normalize with a chosen alternative;",
      "        else use concept_name='' and status='novel_candidate'.",
      "   b. Choose an `anchor` (a verbatim substring of the note that contains the entity",
      "      AND uniquely locates it). For unambiguous long entities, anchor == text.",
      "      For ambiguous short values (e.g. '58'), extend the anchor with context ('age 58').",
      "   c. Call `locate_in_source(note_id, anchor, text)` to get authoritative (start, end).",
      "      DO NOT compute offsets yourself.",
      "   d. Call `set_span_label(note_id, text, anchor, start, end, entity_type, concept_name, status)`",
      "      — the platform faithfulness-checks source[start:end] === text and refuses bad writes.",
      "3. When all candidate spans across all notes are committed, emit a brief summary line and stop.",
      "",
      "Be exhaustive: a missed span is a recall miss. A wrong span is rejected by the faithfulness gate.",
      "Prefer the MOST SPECIFIC concept_name available in the ontology subtree (don't default to the root).",
    ].join("\n");
  },
  buildExtraSystemPrompt() {
    return (
      "You are running unattended in batch mode (chart-review-platform-v2). " +
      "There is no human in the loop for this subject — produce all entity spans and stop. " +
      "Use the chart_review_ner MCP server's tools to commit results; do not write files directly. " +
      "Do not ask clarifying questions; pick the most defensible answer with the evidence available."
    );
  },
  async readScratchOutput(ctx: ExtractorProfileContext) {
    const fp = path.join(
      ctx.scratchRoot,
      ctx.subject.id,
      ctx.form.task_id,
      "review_state.json",
    );
    if (!fs.existsSync(fp)) return { cells: [], spans: [] };
    try {
      const state = JSON.parse(await fs.promises.readFile(fp, "utf8")) as {
        span_labels?: SpanLabel[];
      };
      return { cells: [], spans: state.span_labels ?? [] };
    } catch {
      return { cells: [], spans: [] };
    }
  },
};
