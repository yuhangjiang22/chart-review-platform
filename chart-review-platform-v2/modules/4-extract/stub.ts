// Domain-agnostic stub extractor for offline smoke tests.
//
// Real extraction now lives in v1-agent-extract.ts (wraps v1's
// agent-provider runAgent). The stub stays for tests that don't want
// to spend tokens.

import type {
  ExtractModule, ExtractorOutput, FormSpec, SubjectRef,
  EvidenceUnit, FieldAssessment, EvidenceRef, CompiledField,
} from "../../shared/types.js";

export interface StubExtractOptions {
  answerBias?: "yes" | "no" | "varied";
  confidenceBias?: "low" | "medium" | "high";
}

export function makeStubExtract(defaults: StubExtractOptions = {}): ExtractModule {
  return {
    async extract(
      form: FormSpec,
      subject: SubjectRef,
      corpus: EvidenceUnit[],
      extractor_id: string,
    ): Promise<ExtractorOutput> {
      const cells: FieldAssessment[] = form.criteria
        .filter((c) => !c.derivation)
        .map((c) => buildCell(c, corpus, defaults));
      return { extractor_id, task_id: form.task_id, subject_id: subject.id, cells };
    },
  };
}

function buildCell(
  c: CompiledField,
  corpus: EvidenceUnit[],
  opts: StubExtractOptions,
): FieldAssessment {
  const unit = corpus.find((u) => u.text.length > 0);
  const evidence: EvidenceRef[] = unit
    ? [{
        // v1's EvidenceRef has source: "note" | "omop" + note_id / span_offsets fields.
        // For the stub we emit a note-source ref with a real span into the first unit.
        source: "note",
        note_id: unit.unit_id,
        span_offsets: [0, Math.min(40, unit.text.length)],
        verbatim_quote: unit.text.slice(0, Math.min(40, unit.text.length)),
      } as EvidenceRef]
    : [];

  return {
    field_id: c.id,
    answer: mockAnswer(c.answer_schema, opts.answerBias ?? "no"),
    confidence: opts.confidenceBias ?? "high",
    evidence,
    rationale: `(stub) answered ${c.id} with bias=${opts.answerBias ?? "no"}.`,
  };
}

function mockAnswer(schema: unknown, bias: "yes" | "no" | "varied"): unknown {
  // CompiledField.answer_schema is typed `unknown` in v1; we accept
  // any shape and use the `type` field if present.
  const s = (schema ?? {}) as { type?: string; values?: unknown[]; min?: number };
  switch (s.type) {
    case "boolean":
      return bias === "yes" ? true : bias === "no" ? false : Math.random() < 0.5;
    case "enum":
      return bias === "varied"
        ? (s.values?.[Math.floor(Math.random() * (s.values?.length ?? 1))] ?? null)
        : (s.values?.[0] ?? null);
    case "number":
      return s.min ?? 0;
    case "text":
      return `(stub ${bias})`;
    default:
      return null;
  }
}
