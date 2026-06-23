import { describe, it, expect } from "vitest";
import { computePerNoteMetrics, type CellPair } from "./pernote-performance.js";

describe("computePerNoteMetrics", () => {
  it("computes per-field accuracy and overall agreement vs reference", () => {
    const pairs: CellPair[] = [
      { note_id: "n1", field_id: "apoe4", a: "1", b: "1" },
      { note_id: "n2", field_id: "apoe4", a: "1", b: "0" },
      { note_id: "n1", field_id: "imp", a: "1", b: "1" },
      { note_id: "n2", field_id: "imp", a: "0", b: "0" },
    ];
    const r = computePerNoteMetrics(pairs, ["apoe4", "imp"]);
    const apoe = r.per_field.find((f) => f.field_id === "apoe4")!;
    expect(apoe.n).toBe(2);
    expect(apoe.accuracy).toBe(0.5);
    const imp = r.per_field.find((f) => f.field_id === "imp")!;
    expect(imp.accuracy).toBe(1);
    expect(r.overall_agreement).toBeCloseTo(0.75, 5);
  });

  it("kappa is null when fewer than 2 pairs or one category", () => {
    const r = computePerNoteMetrics([{ note_id: "n1", field_id: "x", a: "1", b: "1" }], ["x"]);
    expect(r.per_field[0]!.kappa).toBeNull();
  });

  it("emits disagreement rows", () => {
    const pairs: CellPair[] = [
      { note_id: "n2", field_id: "apoe4", a: "1", b: "0" },
      { note_id: "n1", field_id: "apoe4", a: "1", b: "1" },
    ];
    const r = computePerNoteMetrics(pairs, ["apoe4"]);
    expect(r.disagreements).toEqual([{ note_id: "n2", field_id: "apoe4", a: "1", b: "0" }]);
  });
});
