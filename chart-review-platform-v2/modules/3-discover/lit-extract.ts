// lit-extract discover adapter — fetches paper text from external DBs.
//
// MVP: a fixture-backed implementation. A real adapter would call out
// to PubMed/Europe PMC/arXiv via E-utilities. The contract is the
// same; the smoke test below uses the fixture path.

import fs from "node:fs";
import path from "node:path";
import type { DiscoverModule, EvidenceUnit, SubjectRef, TaskSpec } from "../../shared/types.js";

export interface LitExtractDiscoverOpts {
  /** Either a directory of cached paper fulltexts (one file per
   *  subject.id) for offline runs, or a stub returning fixture data. */
  fixtureRoot?: string;
}

export function makeLitExtractDiscover(opts: LitExtractDiscoverOpts = {}): DiscoverModule {
  return {
    async discover(_spec: TaskSpec, subject: SubjectRef): Promise<EvidenceUnit[]> {
      if (subject.type !== "paper") {
        throw new Error(`lit-extract discover only handles paper subjects, got ${subject.type}`);
      }

      // Fixture path (MVP): expect <fixtureRoot>/<subject.id>.txt
      if (opts.fixtureRoot) {
        const fp = path.join(opts.fixtureRoot, `${subject.id}.txt`);
        if (fs.existsSync(fp)) {
          const text = await fs.promises.readFile(fp, "utf8");
          return [{
            unit_id: subject.id,
            subject_id: subject.id,
            source_type: "fulltext",
            text,
            meta: { source: "fixture", byte_length: text.length },
          }];
        }
      }

      // Otherwise a single placeholder unit so downstream extractors
      // have something with a stable shape to operate on. Real impl:
      // call PubMed E-utilities, dedup, parse XML, etc.
      return [{
        unit_id: subject.id,
        subject_id: subject.id,
        source_type: "abstract",
        text: `(placeholder abstract for ${subject.id} — wire real PubMed adapter)`,
        meta: { source: "placeholder" },
      }];
    },
  };
}
