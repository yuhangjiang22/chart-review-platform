// Session-create must validate agent_specs the SAME way run-start does, so the
// API can't create a session that can never run. Regression for the QA finding:
// a preset-less agent_spec was accepted at create and only rejected later at
// POST /api/pilots, detached from the create action.
import { describe, it, expect } from "vitest";
import { sessionRoutes } from "./session-routes.js";

function route(method: string, pattern: string) {
  const r = sessionRoutes.find((x) => x.method === method && x.pattern === pattern);
  if (!r) throw new Error(`no route ${method} ${pattern}`);
  return r;
}

// Minimal req: no auth token → "anonymous-reviewer" (MODE defaults to optional)
// → methodologist allowed (empty allowlist). The validation we're testing
// throws BEFORE createSession, so no filesystem/session state is needed.
const REQ = { headers: { host: "localhost" }, url: "/" } as never;
const P = { taskId: "cancer-diagnosis" };

async function callCreate(body: unknown) {
  const post = route("POST", "/api/sessions/:taskId");
  try {
    await post.handler(body as never, REQ, P as never, new URLSearchParams());
    return null;
  } catch (e) {
    return e as Error & { status?: number };
  }
}

describe("session create — agent_specs validation (fail fast)", () => {
  it("rejects a preset-less agent_spec with 400 + the run-start message", async () => {
    const err = await callCreate({
      name: "qa", patient_ids: ["p1"], agent_specs: [{ id: "agent_1" }],
    });
    expect(err).toBeTruthy();
    expect(err!.status).toBe(400);
    expect(err!.message).toMatch(/must have a preset/);
  });

  it("rejects empty agent_specs with 400", async () => {
    const err = await callCreate({ name: "qa", patient_ids: ["p1"], agent_specs: [] });
    expect(err?.status).toBe(400);
    expect(err!.message).toMatch(/agent_specs must be a non-empty array/);
  });

  it("accepts a well-formed spec past validation (fails later, not at the spec check)", async () => {
    // A valid preset passes validateAgentSpec; the handler then proceeds to
    // createSession. We only assert it did NOT fail with a spec-validation
    // message (it may fail later on filesystem/task state in this unit context).
    const err = await callCreate({
      name: "qa", patient_ids: ["p1"],
      agent_specs: [{ id: "agent_1", search_mode_preset: "smart-search", interpretation_preset: "default" }],
    });
    if (err) {
      expect(err.message).not.toMatch(/must have a preset/);
      expect(err.message).not.toMatch(/agent_specs must be a non-empty array/);
    }
  });
});
