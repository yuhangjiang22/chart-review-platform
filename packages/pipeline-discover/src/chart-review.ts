// chart-review discover adapter — reads patient notes from disk.

import fs from "node:fs";
import path from "node:path";
import type { DiscoverModule, EvidenceUnit, SubjectRef, TaskSpec } from "@chart-review/v2-shared";

export interface ChartReviewDiscoverOpts {
  /** Root containing patient corpora. Each subdir is one patient_id and
   *  holds .txt note files. Defaults to the original platform's
   *  corpus/patients/ but any layout works as long as you point here. */
  corpusRoot: string;
}

export function makeChartReviewDiscover(opts: ChartReviewDiscoverOpts): DiscoverModule {
  return {
    async discover(_spec: TaskSpec, subject: SubjectRef): Promise<EvidenceUnit[]> {
      if (subject.type !== "patient") {
        throw new Error(`chart-review discover only handles patient subjects, got ${subject.type}`);
      }
      const patientDir = path.join(opts.corpusRoot, subject.id);
      if (!fs.existsSync(patientDir)) return [];

      const units: EvidenceUnit[] = [];
      for (const entry of fs.readdirSync(patientDir)) {
        if (!entry.endsWith(".txt")) continue;
        const fp = path.join(patientDir, entry);
        const text = await fs.promises.readFile(fp, "utf8");
        units.push({
          unit_id: entry.replace(/\.txt$/, ""),
          subject_id: subject.id,
          source_type: "note",
          text,
          meta: { filename: entry, byte_length: text.length },
        });
      }
      return units;
    },
  };
}
