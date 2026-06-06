// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);
afterEach(() => cleanup());

import { StructuredTab } from "../StructuredTab";
import type { Citer } from "../citers";

const data = {
  conditions: [
    { row_id: 510001, concept_name: "HTN", value: "I10", date: "2025-07-15" },
  ],
  procedures: [], measurements: [], drugs: [], observations: [], encounters: [],
};

describe("StructuredTab — citer chips", () => {
  it("renders one chip per citer for a row in citersByRowKey", () => {
    const citersByRowKey = new Map<string, Citer[]>([
      ["conditions:510001", [
        { kind: "agent", agent_id: "agent_1", slot: 1, label: "Agent 1" },
        { kind: "you" },
      ]],
    ]);
    render(
      <StructuredTab
        data={data}
        activeFieldId="f"
        citersByRowKey={citersByRowKey}
      />,
    );
    // 2 chips visible — one for Agent 1, one for You.
    expect(screen.getByTitle(/Cited by: Agent 1/i)).toBeInTheDocument();
    expect(screen.getByTitle(/Cited by:.*You/i)).toBeInTheDocument();
  });

  it("renders no chips for an uncited row", () => {
    render(
      <StructuredTab
        data={data}
        activeFieldId="f"
        citersByRowKey={new Map()}
      />,
    );
    expect(screen.queryByTitle(/Cited by/i)).not.toBeInTheDocument();
  });
});
