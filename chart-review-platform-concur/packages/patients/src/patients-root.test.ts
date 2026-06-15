import { describe, it, expect, afterEach, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("patientsRoot()", () => {
  it("honors CHART_REVIEW_PATIENTS_ROOT set AFTER import (call-time read)", async () => {
    delete process.env.CHART_REVIEW_PATIENTS_ROOT;
    vi.resetModules();
    const mod = await import("./index.js"); // imported with the override UNSET
    // The deploy runner sets the override at runtime, after import — patientsRoot()
    // must reflect it (a frozen const would not). This is the bug the fn fixes.
    process.env.CHART_REVIEW_PATIENTS_ROOT = "/tmp/my-cohort";
    expect(mod.patientsRoot()).toBe("/tmp/my-cohort");
    delete process.env.CHART_REVIEW_PATIENTS_ROOT;
  });

  it("defaults to corpus/patients when unset", async () => {
    delete process.env.CHART_REVIEW_PATIENTS_ROOT;
    vi.resetModules();
    const mod = await import("./index.js");
    expect(mod.patientsRoot().endsWith("/corpus/patients")).toBe(true);
  });
});
