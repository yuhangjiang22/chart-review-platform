import { describe, it, expect } from "vitest";
import { evalDerivation, type MinimalTask } from "./index.js";

// Regression: evalDerivation must stay LINEAR in the number of derived fields.
// It builds each field's env by recursing into every other derived field, and
// once a field left the `visited` cycle-guard it could be re-evaluated in every
// sibling branch — O(k!) for k chained derived fields. RUCAM's 11 derived fields
// with a sparse env (only leaves committed) hung the write path at 100% CPU.
// A memo makes it linear. These would TIME OUT (or hang) on the pre-memo code.

/** A wide+chained derived graph: k derived fields each referencing both leaves
 *  and the previous derived, plus a `top` that fans in over all of them. */
function wideTask(k: number): MinimalTask {
  const fields: MinimalTask["fields"] = [{ id: "a" }, { id: "b" }];
  for (let i = 0; i < k; i++) {
    const prev = i === 0 ? "b" : `d${i - 1}`;
    fields.push({ id: `d${i}`, derivation: `(a + b) + ${prev}` });
  }
  fields.push({ id: "top", derivation: Array.from({ length: k }, (_, i) => `d${i}`).join(" + ") });
  return { fields };
}

describe("evalDerivation memoization — no factorial blowup", () => {
  it("completes on a 12-wide derived graph with a sparse env (was an O(k!) hang)", () => {
    const task = wideTask(12);
    const t0 = Date.now();
    const v = evalDerivation(task, { a: 1 }, "top"); // b missing -> everything Pending
    expect(v).toBeNull(); // missing input -> null (Pending), never fabricated
    expect(Date.now() - t0).toBeLessThan(1000); // linear, not factorial
  });

  it("still computes correct chained values (memo returns the value, not null)", () => {
    const task = wideTask(6);
    // d0=(1+2)+2=5, d1=3+5=8, d2=11, d3=14, d4=17, d5=20 -> top=5+8+11+14+17+20=75
    expect(evalDerivation(task, { a: 1, b: 2 }, "top")).toBe(75);
  });

  it("cycle guard still holds (A<->B returns null, does not recurse forever)", () => {
    const task: MinimalTask = {
      fields: [
        { id: "x" },
        { id: "A", derivation: "x + B" },
        { id: "B", derivation: "x + A" },
      ],
    };
    expect(evalDerivation(task, { x: 1 }, "A")).toBeNull();
  });
});
