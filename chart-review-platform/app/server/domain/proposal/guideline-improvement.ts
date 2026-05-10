/**
 * Guideline-improvement driver.
 *
 * Drives the `chart-review-improve` verb skill
 * (.claude/skills/chart-review-improve/SKILL.md) via composeAgentOptions.
 *
 *   guideline + patient_ids (with reviewer overrides) → proposals/<guideline-id>/*.yaml
 *
 * Same agent primitive as authoring.ts and ai-client.ts. Three knobs differ:
 *   - cwd:         PLATFORM_ROOT (so the agent can read both reviews/ and write proposals/)
 *   - extraTools:  ["Write"] (for proposal files)
 *   - guidelinePath: set to guidelines/<id>/ (skill reads the guideline structure)
 */

import fs from "fs";
import path from "path";
import { runAgent } from "../../agent-provider.js";
import { PLATFORM_ROOT } from "../../patients.js";
import { loadSkillBundle, guidelineDir } from "../rubric/index.js";

function proposalsRoot(): string {
  return process.env.CHART_REVIEW_PROPOSALS_ROOT ?? path.join(PLATFORM_ROOT, "proposals");
}

function reviewsRoot(): string {
  return process.env.CHART_REVIEW_REVIEWS_ROOT ?? path.join(PLATFORM_ROOT, "reviews");
}

export interface ImproveGuidelineOptions {
  guideline_id: string;
  /** Patient ids to analyze. Each must have a review_state.json under reviews/<pid>/<guideline_id>/. */
  patient_ids: string[];
  /** Optional: focus the analysis on a single criterion (e.g., 'pathology_lung_primary'). */
  focus_criterion?: string;
  /** Optional: path to proposals_seed.json. When set, the seed is included
   *  in the prompt context so the agent can act on guideline-gap
   *  adjudications in addition to reviewer-override patterns.
   *  Full integration is deferred to a follow-up task — the file is
   *  written on pilot completion by emitDerivedArtifactsOnCompletion
   *  and will be consumed here once the prompt builder is extended. */
  proposals_seed_file?: string;
}

export interface ImproveGuidelineResult {
  ok: boolean;
  guideline_id: string;
  patients_analyzed: string[];
  proposals_dir: string;
  proposals: Array<{ proposal_id: string; path: string; size_bytes: number }>;
  proposal_count: number;
  error?: string;
  duration_ms: number;
  cost_usd?: number;
}

export async function improveGuideline(
  opts: ImproveGuidelineOptions,
): Promise<ImproveGuidelineResult> {
  const startedAt = Date.now();

  if (!/^[a-z][a-z0-9-]+$/.test(opts.guideline_id)) {
    return {
      ok: false,
      guideline_id: opts.guideline_id,
      patients_analyzed: [],
      proposals_dir: "",
      proposals: [],
      proposal_count: 0,
      error: "guideline_id must be kebab-case",
      duration_ms: 0,
    };
  }

  // Verify the guideline exists
  const guidelinePath = guidelineDir(opts.guideline_id);
  if (!fs.existsSync(path.join(guidelinePath, "meta.yaml"))) {
    return {
      ok: false,
      guideline_id: opts.guideline_id,
      patients_analyzed: [],
      proposals_dir: "",
      proposals: [],
      proposal_count: 0,
      error: `guideline not found at ${guidelinePath}`,
      duration_ms: 0,
    };
  }

  // Verify each patient has a review_state.json
  const missing: string[] = [];
  const reviewStatePaths: string[] = [];
  for (const pid of opts.patient_ids) {
    if (!/^[a-zA-Z0-9_-]+$/.test(pid)) {
      return {
        ok: false,
        guideline_id: opts.guideline_id,
        patients_analyzed: [],
        proposals_dir: "",
        proposals: [],
        proposal_count: 0,
        error: `invalid patient_id: ${pid}`,
        duration_ms: 0,
      };
    }
    const rsPath = path.join(reviewsRoot(), pid, opts.guideline_id, "review_state.json");
    if (!fs.existsSync(rsPath)) missing.push(pid);
    else reviewStatePaths.push(path.relative(PLATFORM_ROOT, rsPath));
  }
  if (missing.length > 0) {
    return {
      ok: false,
      guideline_id: opts.guideline_id,
      patients_analyzed: [],
      proposals_dir: "",
      proposals: [],
      proposal_count: 0,
      error: `no review_state.json for: ${missing.join(", ")}`,
      duration_ms: 0,
    };
  }

  const proposalsDir = path.join(proposalsRoot(), opts.guideline_id);
  fs.mkdirSync(proposalsDir, { recursive: true });

  // Snapshot the proposals dir before we run, so we can list what the agent
  // produced afterward (rather than trusting any specific filename pattern).
  const before = new Set(
    fs.existsSync(proposalsDir)
      ? fs.readdirSync(proposalsDir).filter((n) => n.endsWith(".yaml"))
      : [],
  );

  // Sanity-check the guideline loads (and surface field count for the agent's context)
  let guidelineFieldCount = 0;
  try {
    guidelineFieldCount = (loadSkillBundle(opts.guideline_id).fields ?? []).length;
  } catch {
    /* loadSkillBundle isn't strictly required; agent reads files directly */
  }

  // Optional: load proposals_seed.json to include guideline-gap adjudications
  // in the prompt context. Full threading is deferred to a follow-up task;
  // for MVP we append the raw seed content as an additional context block.
  let proposalsSeedBlock = "";
  if (opts.proposals_seed_file && fs.existsSync(opts.proposals_seed_file)) {
    try {
      const seedContent = fs.readFileSync(opts.proposals_seed_file, "utf-8");
      proposalsSeedBlock =
        "\n## Guideline-gap adjudications (from dual-agent pilot)\n" +
        "The following adjudications were classified as guideline gaps by a human " +
        "reviewer during a dual-agent pilot. Use them as additional signal when " +
        "clustering disagreements into proposals.\n\n" +
        "```json\n" + seedContent + "\n```\n";
    } catch {
      /* best-effort — if the file is unreadable, skip silently */
    }
  }

  const userPrompt = [
    `Use the \`chart-review-improve\` skill to analyze this cohort and propose concrete guideline edits.`,
    "",
    `Guideline: ${opts.guideline_id}`,
    `Guideline path: ${path.relative(PLATFORM_ROOT, guidelinePath)} (${guidelineFieldCount} criteria)`,
    `Proposals output dir: ${path.relative(PLATFORM_ROOT, proposalsDir)}`,
    "",
    "## Cohort to analyze",
    ...opts.patient_ids.map(
      (pid, i) => `${i + 1}. ${pid} → ${reviewStatePaths[i]}`,
    ),
    "",
    opts.focus_criterion
      ? `## Focus criterion\n${opts.focus_criterion}\n`
      : "## Focus\nAll criteria.\n",
    "",
    "## Signal sources — use ALL of these, not just override snapshots",
    "",
    "For each patient, read review_state.json and gather signals from any of:",
    "",
    "1. **Reviewer overrides with snapshot.** Field assessments where",
    "   `source=reviewer` AND `original_agent_snapshot` is present — the",
    "   classic case. (Often empty in manual-annotation flows; do NOT rely",
    "   on this alone.)",
    "",
    "2. **Reviewer comments.** Any non-empty `comment` field on a reviewer",
    "   field_assessment is direct guideline-improvement feedback the",
    "   reviewer wrote intentionally. Cluster these by criterion.",
    "",
    "3. **Reviewer-vs-agent answer divergence.** For each committed",
    "   reviewer assessment, look up the corresponding agent draft under",
    "   `runs/<latest_run_for_this_task>/per_patient/<pid>/agents/<agent_id>.json`",
    "   and compare the answers. When the committed answer differs from",
    "   ALL agent drafts on a criterion, that's a disagreement signal even",
    "   without an `original_agent_snapshot` field (this is the typical",
    "   shape in a manual-annotation flow that didn't go through the dual-",
    "   agent override path).",
    "",
    "4. **Reviewer rationale departures.** When the reviewer's `rationale`",
    "   text differs substantially from the agent's rationale on the same",
    "   criterion, that's a softer signal — surface only if there are",
    "   multiple instances on the same criterion or a clear theme.",
    "",
    "Cluster the signals by criterion and theme. Each cluster with ≥2",
    "patients (or 1 patient + a strong reviewer comment) becomes a YAML",
    "proposal in the proposals output dir. Use the chart-review-improve",
    "skill's proposal schema verbatim.",
    "",
    "**If after surveying all four signal types you find nothing worth",
    "proposing**, that's a valid outcome — write zero proposals and",
    "summarize WHY (e.g., \"all reviewer answers matched at least one",
    "agent's draft, no overrides or comments worth clustering\"). Don't",
    "fabricate proposals just to have non-empty output.",
    proposalsSeedBlock,
  ].join("\n");

  let cost: number | undefined;
  let success = false;
  let errorMessage: string | undefined;

  try {
    for await (const event of runAgent({
      prompt: userPrompt,
      cwd: PLATFORM_ROOT,
      taskId: opts.guideline_id,
      guidelinePath,
      extraTools: ["Write"],
      maxTurns: 50,
      permissionMode: "acceptEdits",
      extraSystemPrompt:
        "Activate the `chart-review-improve` skill via the Skill tool. Follow " +
        "its procedure to cluster reviewer overrides into concrete proposed edits. " +
        "Each proposal goes to a separate YAML file at the proposals output " +
        "directory provided in the user message; never modify files under " +
        "`guidelines/`.",
    })) {
      if (event.type === "result") {
        success = event.subtype === "success";
        cost = event.cost_usd;
      } else if (event.type === "error") {
        errorMessage = event.error;
      }
    }
  } catch (e) {
    errorMessage = (e as Error).message;
  }

  // Diff the proposals dir to surface what was actually written.
  const after = fs.existsSync(proposalsDir)
    ? fs.readdirSync(proposalsDir).filter((n) => n.endsWith(".yaml"))
    : [];
  const newFiles = after.filter((n) => !before.has(n));

  const proposals = newFiles.map((name) => {
    const full = path.join(proposalsDir, name);
    const stat = fs.statSync(full);
    return {
      proposal_id: name.replace(/\.yaml$/, ""),
      path: full,
      size_bytes: stat.size,
    };
  });

  return {
    ok: success && !errorMessage,
    guideline_id: opts.guideline_id,
    patients_analyzed: opts.patient_ids,
    proposals_dir: proposalsDir,
    proposals,
    proposal_count: proposals.length,
    error: errorMessage,
    duration_ms: Date.now() - startedAt,
    cost_usd: cost,
  };
}

/** List existing proposals for a guideline. */
export interface ProposalListing {
  proposal_id: string;
  path: string;
  size_bytes: number;
  modified_at: string;
}

export function listProposals(guidelineId: string): ProposalListing[] {
  if (!/^[a-z][a-z0-9-]+$/.test(guidelineId)) return [];
  const dir = path.join(proposalsRoot(), guidelineId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith(".yaml"))
    .map((name): ProposalListing => {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      return {
        proposal_id: name.replace(/\.yaml$/, ""),
        path: full,
        size_bytes: stat.size,
        modified_at: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => b.modified_at.localeCompare(a.modified_at));
}

/** Read one proposal's raw YAML content for display. */
export function readProposal(guidelineId: string, proposalId: string): string | null {
  if (!/^[a-z][a-z0-9-]+$/.test(guidelineId)) return null;
  if (!/^[a-zA-Z0-9_-]+$/.test(proposalId)) return null;
  const p = path.join(proposalsRoot(), guidelineId, `${proposalId}.yaml`);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, "utf-8");
}
