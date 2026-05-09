import { describe, it, expect } from "vitest";
import { computeTaskDiff } from "../task-diff";

describe("computeTaskDiff", () => {
  it("returns all unchanged for identical tasks", () => {
    const t = { task_id: "t1", source_document_sha: "sha1", fields: [{ id: "x", prompt: "P" }] };
    const diff = computeTaskDiff(t, t);
    expect(diff.fields).toHaveLength(1);
    expect(diff.fields[0].status).toBe("unchanged");
  });

  it("flags added fields", () => {
    const from = { fields: [{ id: "x", prompt: "P" }] };
    const to = { fields: [{ id: "x", prompt: "P" }, { id: "y", prompt: "Q" }] };
    const diff = computeTaskDiff(from, to);
    expect(diff.fields.find((f) => f.field_id === "y")?.status).toBe("added");
    expect(diff.fields.find((f) => f.field_id === "x")?.status).toBe("unchanged");
  });

  it("flags removed fields", () => {
    const from = { fields: [{ id: "x", prompt: "P" }, { id: "y", prompt: "Q" }] };
    const to = { fields: [{ id: "x", prompt: "P" }] };
    const diff = computeTaskDiff(from, to);
    expect(diff.fields.find((f) => f.field_id === "y")?.status).toBe("removed");
  });

  it("flags changed fields with specific changed keys", () => {
    const from = { fields: [{ id: "x", prompt: "old", is_applicable_when: "a == 'yes'" }] };
    const to = { fields: [{ id: "x", prompt: "old", is_applicable_when: "a == 'no'" }] };
    const diff = computeTaskDiff(from, to);
    const xDiff = diff.fields.find((f) => f.field_id === "x");
    expect(xDiff?.status).toBe("changed");
    expect(xDiff?.changes).toBeDefined();
    expect(xDiff?.changes!.find((c) => c.key === "is_applicable_when")).toBeDefined();
  });
});
