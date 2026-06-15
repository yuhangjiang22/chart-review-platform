// packages/deploy-runner/src/select-agent.test.ts
import { describe, it, expect } from "vitest";
import { selectAgent } from "./select-agent.js";

const cfg = [
  { id: "agent_1", search_mode_preset: "smart-search", interpretation_preset: "default" },
  { id: "agent_2", search_mode_preset: "smart-search", interpretation_preset: "skeptical" },
];

describe("selectAgent", () => {
  it("picks the highest avg_accuracy", () => {
    const r = selectAgent(cfg, { agents: [
      { agent_id: "agent_1", avg_accuracy: 0.7 }, { agent_id: "agent_2", avg_accuracy: 0.9 }] });
    expect(r.spec.id).toBe("agent_2");
    expect(r.reason).toMatch(/avg_accuracy/);
  });

  it("honors an explicit override", () => {
    const r = selectAgent(cfg, { agents: [
      { agent_id: "agent_1", avg_accuracy: 0.9 }, { agent_id: "agent_2", avg_accuracy: 0.1 }] }, "agent_2");
    expect(r.spec.id).toBe("agent_2");
    expect(r.reason).toMatch(/override/);
  });

  it("falls back to agent_1 on a tie", () => {
    const r = selectAgent(cfg, { agents: [
      { agent_id: "agent_1", avg_accuracy: 0.8 }, { agent_id: "agent_2", avg_accuracy: 0.8 }] });
    expect(r.spec.id).toBe("agent_1");
    expect(r.reason).toMatch(/tie|default/i);
  });

  it("falls back to agent_1 when performance is missing/null", () => {
    const r = selectAgent(cfg, { agents: [] });
    expect(r.spec.id).toBe("agent_1");
  });

  it("ignores null accuracy and picks the agent with a numeric score", () => {
    const r = selectAgent(cfg, { agents: [
      { agent_id: "agent_1", avg_accuracy: null }, { agent_id: "agent_2", avg_accuracy: 0.6 }] });
    expect(r.spec.id).toBe("agent_2");
  });

  it("throws when the override id is not in the package", () => {
    expect(() => selectAgent(cfg, { agents: [] }, "agent_9")).toThrow(/agent_9/);
  });
});
