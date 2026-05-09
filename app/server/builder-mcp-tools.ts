// app/server/builder-mcp-tools.ts — In-process MCP server for the builder.
// Tools:
//   mark_drafted — signals transition from gathering to drafting phase.
//   validate_package — validates the draft guideline package before declaring Done.
//   set_phase_status — emits phase progress markers to the UI strip.
// The agent uses native Write to create the guideline files.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { setPhase, setPhaseMarker, appendTranscriptEvent } from "./builder-state.js";
import { PLATFORM_ROOT } from "./patients.js";
import type { BuilderEvent, PhaseName, PhaseStatus } from "./builder-types.js";

function runPythonValidator(
  packageDir: string,
  metaOverride: string | undefined,
): {
  ok: boolean;
  diagnostics: Array<{ code: string; path: string; message: string; level: "error" | "warning" }>;
} {
  const script = `
import json, sys
from chart_review.build_skill_validator import validate_package
from pathlib import Path
kwargs = {}
if len(sys.argv) > 2:
    kwargs["meta_override"] = Path(sys.argv[2])
print(json.dumps(validate_package(Path(sys.argv[1]), **kwargs)))
`;
  const argv = ["-c", script, packageDir, ...(metaOverride ? [metaOverride] : [])];
  const result = spawnSync("python3", argv, {
    cwd: path.join(PLATFORM_ROOT, "lib"),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `validate_package: python3 exited ${result.status}: ${result.stderr ?? ""}`,
    );
  }
  return JSON.parse(result.stdout);
}

export interface BuilderMcpDeps {
  draftPath: string;
  reviewerId: string;
  taskId: string;
  onEvent: (ev: BuilderEvent) => void;
}

export function createBuilderMcpServer(deps: BuilderMcpDeps): ReturnType<typeof createSdkMcpServer> {
  const markDrafted = tool(
    "mark_drafted",
    "Signal that the gathering phase is complete and you're about to write the guideline files. Call this BEFORE you start writing meta.yaml, criteria/*.yaml, etc. via Write. The platform flips state.phase to 'drafting' so the reviewer's UI shows the assembled guideline.",
    {},
    async () => {
      setPhase(deps.draftPath, "drafting");
      deps.onEvent({ type: "phase_change", phase: "drafting" });
      appendTranscriptEvent(deps.draftPath, {
        type: "tool_use",
        ts: new Date().toISOString(),
        tool: "mark_drafted",
        input: {},
      });
      return {
        content: [{ type: "text" as const, text: "Phase set to 'drafting'. Now Write the guideline files." }],
      };
    },
  );

  const validatePackage = tool(
    "validate_package",
    [
      "Validate the draft guideline package against task-meta and criterion-file schemas, plus a body-prose check that no '# TODO' markers ship.",
      "Call this AFTER you've written all files (meta.yaml + references/criteria/*.md) and BEFORE declaring 'Done'.",
      "Returns { ok: bool, diagnostics: [{code, path, message, level}, ...] } where level is 'error' or 'warning'. ok is false iff any error-level diagnostic exists. Warnings do not block — but address them before lock. Fix each error and call again until ok=true.",
    ].join(" "),
    {
      package_dir: z.string().optional().describe("Absolute package directory. Defaults to the current draft path."),
      meta_override: z.string().optional().describe("Optional alternate meta.yaml path."),
    },
    async (args) => {
      const packageDir = args.package_dir ?? deps.draftPath;
      const result = runPythonValidator(packageDir, args.meta_override);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result) },
        ],
      };
    },
  );

  const setPhaseStatus = tool(
    "set_phase_status",
    [
      "Update the progress strip shown in the Builder UI for one of the 7",
      "interview phases. Call this at every phase transition so the reviewer",
      "can see where they are in the interview.",
      "",
      "phase_name must be one of: intake, output_shape, population, criteria,",
      "evidence, edge_cases, codes.",
      "",
      "status must be one of: locked (decided), active (current), pending (not yet reached).",
      "",
      "Call set_phase_status(intake, locked) the moment the first research question is on the",
      "record. Call set_phase_status(output_shape, active) when you begin phase 2, then",
      "set_phase_status(output_shape, locked) once the output shape is settled, etc.",
    ].join(" "),
    {
      phase_name: z.enum(["intake", "output_shape", "population", "criteria", "evidence", "edge_cases", "codes"]),
      status: z.enum(["locked", "active", "pending"]),
    },
    async (args): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const phaseName = args.phase_name as PhaseName;
      const status = args.status as PhaseStatus;
      setPhaseMarker(deps.draftPath, phaseName, status);
      deps.onEvent({ type: "phase_status", phase_name: phaseName, status });
      appendTranscriptEvent(deps.draftPath, {
        type: "tool_use",
        ts: new Date().toISOString(),
        tool: "set_phase_status",
        input: { phase_name: phaseName, status },
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ok: true, phase_name: phaseName, status }),
          },
        ],
      };
    },
  );

  return createSdkMcpServer({
    name: "chart_review_guideline_builder",
    version: "0.4.0",
    tools: [markDrafted, validatePackage, setPhaseStatus],
  });
}
