// app/server/__tests__/agent-specs.test.ts
import { describe, expect, it } from "vitest";
import {
  loadRolePreset,
  defaultAgentSpecs,
  searchRecallBenchmarkSpecs,
  validateAgentSpec,
  listAvailablePresets,
  resolveRolePrompt,
  AXIS_SEARCH_MODE,
  AXIS_INTERPRETATION,
} from "../agent-specs.js";

describe("agent-specs — preset loading", () => {
  it("loads the default preset and surfaces its axis", () => {
    const p = loadRolePreset("default");
    expect(p.preset_id).toBe("default");
    expect(p.preset_version).toBe("v1");
    expect(p.axis).toBe(AXIS_INTERPRETATION);
    expect(p.role_prompt).toContain("careful chart reviewer");
  });

  it("loads the skeptical preset (axis: interpretation)", () => {
    const p = loadRolePreset("skeptical");
    expect(p.preset_id).toBe("skeptical");
    expect(p.axis).toBe(AXIS_INTERPRETATION);
    expect(p.role_prompt).toContain("strict chart reviewer");
  });

  it("loads the smart-search preset (axis: search_mode)", () => {
    const p = loadRolePreset("smart-search");
    expect(p.axis).toBe(AXIS_SEARCH_MODE);
  });

  it("loads the comprehensive preset (axis: search_mode)", () => {
    const p = loadRolePreset("comprehensive");
    expect(p.axis).toBe(AXIS_SEARCH_MODE);
  });

  it("throws on unknown preset", () => {
    expect(() => loadRolePreset("nonexistent")).toThrow(/preset.*not found/i);
  });

  it("rejects path traversal in preset id", () => {
    expect(() => loadRolePreset("../etc/passwd")).toThrow(/invalid preset id/i);
  });

  it("listAvailablePresets returns all four canonical presets", () => {
    const ps = listAvailablePresets();
    expect(ps.map((p) => p.preset_id)).toEqual(
      expect.arrayContaining(["default", "skeptical", "smart-search", "comprehensive"]),
    );
  });
});

describe("agent-specs — defaults", () => {
  it("defaultAgentSpecs returns N=2 with smart-search × {default, skeptical}", () => {
    const specs = defaultAgentSpecs();
    expect(specs).toHaveLength(2);
    expect(specs[0].id).toBe("agent_1");
    expect(specs[0].search_mode_preset).toBe("smart-search");
    expect(specs[0].interpretation_preset).toBe("default");
    expect(specs[1].id).toBe("agent_2");
    expect(specs[1].search_mode_preset).toBe("smart-search");
    expect(specs[1].interpretation_preset).toBe("skeptical");
  });

  it("searchRecallBenchmarkSpecs returns smart-search vs comprehensive at fixed interpretation", () => {
    const specs = searchRecallBenchmarkSpecs();
    expect(specs).toHaveLength(2);
    expect(specs[0].search_mode_preset).toBe("smart-search");
    expect(specs[1].search_mode_preset).toBe("comprehensive");
    expect(specs[0].interpretation_preset).toBe(specs[1].interpretation_preset);
  });
});

describe("agent-specs — validation", () => {
  it("rejects duplicate ids", () => {
    const bad = [
      { id: "a", interpretation_preset: "default" },
      { id: "a", interpretation_preset: "skeptical" },
    ];
    expect(() => validateAgentSpec(bad)).toThrow(/duplicate.*id/i);
  });

  it("rejects empty array", () => {
    expect(() => validateAgentSpec([])).toThrow(/at least one/i);
  });

  it("accepts free-form role_prompt without preset", () => {
    const ok = [{ id: "agent_1", role_prompt: "custom prompt" }];
    expect(() => validateAgentSpec(ok)).not.toThrow();
  });

  it("accepts both named slots", () => {
    const ok = [
      {
        id: "a",
        search_mode_preset: "comprehensive",
        interpretation_preset: "skeptical",
      },
    ];
    expect(() => validateAgentSpec(ok)).not.toThrow();
  });

  it("rejects search_mode_preset pointing at an interpretation preset", () => {
    const bad = [{ id: "a", search_mode_preset: "skeptical" }];
    expect(() => validateAgentSpec(bad)).toThrow(/expected 'search_mode'/);
  });

  it("rejects interpretation_preset pointing at a search-mode preset", () => {
    const bad = [{ id: "a", interpretation_preset: "comprehensive" }];
    expect(() => validateAgentSpec(bad)).toThrow(/expected 'interpretation'/);
  });

  it("rejects axis collision between role_preset and named slot", () => {
    const bad = [
      {
        id: "a",
        role_preset: "skeptical", // axis: interpretation
        interpretation_preset: "default", // also interpretation
      },
    ];
    expect(() => validateAgentSpec(bad)).toThrow(/conflicts with interpretation_preset/);
  });

  it("rejects non-string model field", () => {
    const bad = [{ id: "a", role_prompt: "x", model: 123 as any }];
    expect(() => validateAgentSpec(bad)).toThrow(/model.*string/i);
  });
});

describe("agent-specs — resolveRolePrompt composes both axes", () => {
  it("composes search_mode + interpretation when both slots are filled", () => {
    const out = resolveRolePrompt({
      id: "a",
      search_mode_preset: "comprehensive",
      interpretation_preset: "skeptical",
    });
    expect(out).toContain("Search mode: comprehensive");
    expect(out).toContain("Interpretation: skeptical");
    expect(out).toContain("read the entire chart"); // from comprehensive
    expect(out).toContain("strict chart reviewer"); // from skeptical
  });

  it("fills smart-search default when only interpretation is named", () => {
    const out = resolveRolePrompt({
      id: "a",
      interpretation_preset: "skeptical",
    });
    expect(out).toContain("Search mode: smart-search");
    expect(out).toContain("Interpretation: skeptical");
  });

  it("fills default-interpretation when only search_mode is named", () => {
    const out = resolveRolePrompt({
      id: "a",
      search_mode_preset: "comprehensive",
    });
    expect(out).toContain("Search mode: comprehensive");
    expect(out).toContain("Interpretation: default");
  });

  it("back-compat: legacy role_preset='default' routes to interpretation slot", () => {
    const out = resolveRolePrompt({ id: "a", role_preset: "default" });
    expect(out).toContain("Search mode: smart-search");
    expect(out).toContain("Interpretation: default");
  });

  it("back-compat: legacy role_preset='comprehensive' routes to search_mode slot", () => {
    const out = resolveRolePrompt({ id: "a", role_preset: "comprehensive" });
    expect(out).toContain("Search mode: comprehensive");
    expect(out).toContain("Interpretation: default");
  });

  it("free-form role_prompt bypasses composition", () => {
    const out = resolveRolePrompt({ id: "a", role_prompt: "hand-rolled framing" });
    expect(out).toBe("hand-rolled framing");
    expect(out).not.toContain("Search mode:");
  });
});
