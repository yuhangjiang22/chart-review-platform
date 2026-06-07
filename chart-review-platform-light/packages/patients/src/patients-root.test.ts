import { describe, it, expect, afterEach, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("PATIENTS_ROOT override", () => {
  it("honors CHART_REVIEW_PATIENTS_ROOT when set", async () => {
    vi.resetModules();
    vi.stubEnv("CHART_REVIEW_PATIENTS_ROOT", "/tmp/my-cohort");
    const mod = await import("./index.js");
    expect(mod.PATIENTS_ROOT).toBe("/tmp/my-cohort");
  });

  it("defaults to corpus/patients when unset", async () => {
    delete process.env.CHART_REVIEW_PATIENTS_ROOT;
    vi.resetModules();
    const mod = await import("./index.js");
    expect(mod.PATIENTS_ROOT.endsWith("/corpus/patients")).toBe(true);
  });
});
