import fs from "fs";
import path from "path";
import type { RuleProposal } from "@chart-review/domain-proposal";
import { guidelineDir } from "@chart-review/rubric";

export interface BenchmarkInput {
  taskId: string;
  fromSha: string;
  toSha: string;
  rule: RuleProposal;
}

export function generateBenchmark(input: BenchmarkInput): void {
  const { taskId, fromSha, toSha, rule } = input;
  const versionDir = path.join(guidelineDir(taskId), "versions", toSha);
  fs.mkdirSync(versionDir, { recursive: true });

  const edit = rule.proposed_edit;
  const replay = rule.replay;
  const applied = rule.applied;

  const editType =
    edit?.edit_type === "is_applicable_when_replace" ? "is_applicable_when" : "guidance_prose";
  const flipsTable = (replay?.flips ?? [])
    .map((f) => `| ${f.record_id} | ${f.change} |`)
    .join("\n");

  const diffLine =
    edit?.edit_type === "is_applicable_when_replace"
      ? `  - ${editType}: → \`${edit.payload}\``
      : `  - ${editType}: appended:\n\n    ${edit?.payload?.split("\n").join("\n    ") ?? ""}`;

  const md = `# Benchmark: ${taskId} @ ${toSha}

rule-id: ${rule.rule_id}
**Promoted from**: ${rule.created_by} on ${rule.created_at}
**Methodologist**: ${applied?.applied_by ?? "(unknown)"}, accepted ${applied?.applied_at ?? "(unknown)"}

## Diff from previous SHA (${fromSha})

- criterion \`${rule.field_id}\`:
${diffLine}

## Replay impact (locked records under previous SHA)

| Metric | Value |
|---|---|
| Total locked | ${replay?.total_locked ?? 0} |
| Records flipped | ${replay?.flip_count ?? 0} |
| Pattern strength | ${replay?.pattern_strength ?? "weak"} |

${flipsTable ? `### Flipped records\n\n| record_id | change |\n|---|---|\n${flipsTable}\n` : ""}

## Notes

- κ change prediction is not computed in v1 of the benchmark — it requires per-reviewer answer reconstruction across the cohort. Add in a follow-up batch by integrating with \`app/server/kappa.ts\`.
- Override-rate prediction also deferred for the same reason.
`;

  fs.writeFileSync(path.join(versionDir, "benchmark.md"), md);
}
