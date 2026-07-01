import { describe, it, expect } from "vitest";
import { conceptLabels, diffOntologies } from "./sync-bso-ad-ontology.mjs";

const ontA = {
  _meta: { version: "2026.05.28-0" },
  Demographic: { concepts: [{ label: "Demographic" }, { label: "Age" }] },
};
const ontB = {
  Demographic: { concepts: [{ label: "Demographic" }, { label: "Age" }] },
};

describe("conceptLabels", () => {
  it("collects every concept label across roots, ignoring _meta", () => {
    expect(conceptLabels(ontA)).toEqual(new Set(["Demographic", "Age"]));
  });
});

describe("diffOntologies", () => {
  it("reports no label diff and the version delta when only _meta differs", () => {
    const d = diffOntologies(ontA, ontB);
    expect(d.onlyInA).toEqual([]);
    expect(d.onlyInB).toEqual([]);
    expect(d.versionA).toBe("2026.05.28-0");
    expect(d.versionB).toBe(null);
    expect(d.inSync).toBe(false); // version differs
  });

  it("flags a label that exists only on one side", () => {
    const ontC = { Demographic: { concepts: [{ label: "Demographic" }] } };
    const d = diffOntologies(ontA, ontC);
    expect(d.onlyInA).toEqual(["Age"]);
    expect(d.inSync).toBe(false);
  });
});
