import { describe, it, expect } from "vitest";
import { parseEnvFile, buildBenchmarkArgs } from "./run-benchmark-cohort.js";
import path from "node:path";

describe("parseEnvFile", () => {
  it("parses KEY=value, skips comments/blanks, strips surrounding quotes", () => {
    const txt = [
      "# comment",
      "",
      "ANTHROPIC_BASE_URL=http://127.0.0.1:18080",
      'ANTHROPIC_API_KEY="azure:abc:key"',
      "EMPTY=",
      "  SPACED = trimmed ",
    ].join("\n");
    expect(parseEnvFile(txt)).toEqual({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:18080",
      ANTHROPIC_API_KEY: "azure:abc:key",
      EMPTY: "",
      SPACED: "trimmed",
    });
  });
});

describe("buildBenchmarkArgs", () => {
  it("assembles the `run_benchmark.py ner …` argv", () => {
    const argv = buildBenchmarkArgs({
      noteId: "68324", personId: "1168001484127288",
      noteFile: "/abs/corpus/patients/patient_real_x/notes/68324.txt",
      dataRoot: "/abs/bench/ontology", outRoot: "/abs/var/scratch", model: "gpt-5.2",
    });
    expect(argv).toEqual([
      "run_benchmark.py", "ner",
      "--note-id", "68324",
      "--person-id", "1168001484127288",
      "--text-file", "/abs/corpus/patients/patient_real_x/notes/68324.txt",
      "--data-root", "/abs/bench/ontology",
      "--output-root", "/abs/var/scratch",
      "--model", "gpt-5.2",
    ]);
  });
});

import { runOneNote } from "./run-benchmark-cohort.js";
import os from "node:os";
import fsp from "node:fs/promises";

describe("runOneNote", () => {
  it("returns ok:false with stderr when the process exits non-zero / writes no output", async () => {
    const outRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "b2-"));
    // pythonBin "false" exits 1 and writes nothing → no <outRoot>/<noteId>.json.
    const res = await runOneNote({
      pythonBin: "false", benchmarkRoot: outRoot, env: {},
      args: ["run_benchmark.py", "ner", "--note-id", "n1"], noteId: "n1", outRoot,
    });
    expect(res.ok).toBe(false);
    expect(res.noteId).toBe("n1");
    if (!res.ok) expect(typeof res.error).toBe("string");
  });
});

import { runBenchmarkCohort } from "./run-benchmark-cohort.js";

describe("runBenchmarkCohort", () => {
  it("runs each cohort note via the injected runner and writes one review_state per patient", async () => {
    const reviewsRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "b3-rev-"));
    const corpusRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "b3-corpus-"));
    const pid = "patient_real_p1";
    await fsp.mkdir(path.join(corpusRoot, pid, "notes"), { recursive: true });
    await fsp.writeFile(path.join(corpusRoot, pid, "notes", "n1.txt"), "Smoker now.");
    await fsp.writeFile(path.join(corpusRoot, pid, "meta.json"), JSON.stringify({ person_id: "999" }));

    const summary = await runBenchmarkCohort({
      sessionId: "session_test",
      model: "gpt-5.2",
      patientIds: [pid],
      patientsRootOverride: corpusRoot,
      reviewsRootOverride: reviewsRoot,
      benchmarkRoot: "/unused-in-fake",
      runNote: async ({ noteId }) => ({
        ok: true, noteId,
        entities: [{ text: "Smoker", start: 0, end: 6, entity_type: "X", concept_name: "Tobacco_Use", status: "mapped" }],
      }),
    });

    expect(summary.patients).toHaveLength(1);
    expect(summary.patients[0]).toMatchObject({ patientId: pid, n_notes: 1, n_spans: 1 });
    expect(summary.patients[0].failures).toEqual([]);

    // taskId defaults to "bso-ad-ner-sdk" (the vendored task) when not passed.
    const rsPath = path.join(reviewsRoot, "session_test", pid, "bso-ad-ner-sdk", "review_state.json");
    const rs = JSON.parse(await fsp.readFile(rsPath, "utf-8"));
    expect(rs.task_kind).toBe("ner");
    expect(rs.task_id).toBe("bso-ad-ner-sdk");
    expect(rs.span_labels).toHaveLength(1);
    expect(rs.span_labels[0].concept_name).toBe("Tobacco_Use");
  });
});
