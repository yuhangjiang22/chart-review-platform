import { describe, it, expect } from "vitest";
import { validateDSL } from "../dsl-validator";

describe("validateDSL", () => {
  it("accepts a simple equality expression", () => {
    expect(validateDSL("foo == 'yes'")).toEqual({ ok: true });
  });

  it("accepts a compound AND/OR expression", () => {
    expect(validateDSL("foo == 'yes' AND bar == 'no'")).toEqual({ ok: true });
    expect(validateDSL("foo == 'yes' OR bar == 'no'")).toEqual({ ok: true });
  });

  it("accepts an `in [list]` expression", () => {
    expect(validateDSL("foo in ['a', 'b']")).toEqual({ ok: true });
  });

  it("accepts a ternary", () => {
    expect(validateDSL("foo == 'yes' ? bar == 'maybe' : baz != 'no'")).toEqual({ ok: true });
  });

  it("rejects illegal characters", () => {
    const result = validateDSL("foo == 'yes' && system('rm -rf')");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/illegal characters|parse/i);
  });

  it("rejects malformed expressions", () => {
    const result = validateDSL("foo ==");
    expect(result.ok).toBe(false);
  });

  it("accepts empty string as no-op (treated as always-applicable)", () => {
    expect(validateDSL("")).toEqual({ ok: true });
  });
});
