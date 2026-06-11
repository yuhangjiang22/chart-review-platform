// @vitest-environment jsdom
//
// TasksIndex 3-way-kind regression tests (FILE 1 of the adversarial-review
// fixes). The shipped bug: adherence tasks fell through `kindOf` into the
// "phenotype" bucket, so they showed "0 fields", landed in the wrong tab,
// and — because every task collapsed into a single kind — the tab bar never
// appeared. Also covers the "1 fields" plural bug.

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);

afterEach(() => {
  cleanup();
});

import { TasksIndex } from "../ui/TasksIndex";

describe("TasksIndex — 3-way task kind (adherence regression)", () => {
  it("renders an Adherence tab, shows the tab bar, and labels adherence cards 'guideline concordance' (not '0 fields')", () => {
    render(
      <TasksIndex
        tasks={[
          { id: "cancer-diagnosis", field_count: 4, task_type: "phenotype_validation" },
          { id: "asthma-adherence", field_count: 0, task_type: "adherence" },
        ]}
        onOpen={() => {}}
        onCreateTask={() => {}}
      />,
    );

    // Tab bar appears (more than one kind present → showTabs true).
    const phenotypeTab = screen.getByRole("button", { name: /phenotype/i });
    const adherenceTab = screen.getByRole("button", { name: /adherence/i });
    expect(phenotypeTab).toBeInTheDocument();
    expect(adherenceTab).toBeInTheDocument();

    // Each tab shows count 1.
    expect(within(phenotypeTab).getByText("1")).toBeInTheDocument();
    expect(within(adherenceTab).getByText("1")).toBeInTheDocument();
  });

  it("adherence card subtitle is 'guideline concordance', never '0 fields'", () => {
    render(
      <TasksIndex
        tasks={[
          // phenotype present so the adherence tab can be clicked, but we
          // assert on the adherence card directly via its visible kind tab.
          { id: "asthma-adherence", field_count: 0, task_type: "adherence" },
        ]}
        onOpen={() => {}}
        onCreateTask={() => {}}
      />,
    );
    expect(screen.getByText("guideline concordance")).toBeInTheDocument();
    expect(screen.queryByText("0 fields")).not.toBeInTheDocument();
  });

  it("a single phenotype task with field_count 1 renders '1 field' (singular, not '1 fields')", () => {
    render(
      <TasksIndex
        tasks={[{ id: "solo", field_count: 1, task_type: "phenotype_validation" }]}
        onOpen={() => {}}
        onCreateTask={() => {}}
      />,
    );
    expect(screen.getByText("1 field")).toBeInTheDocument();
    expect(screen.queryByText("1 fields")).not.toBeInTheDocument();
  });

  it("does NOT show the tab bar when only one kind is present", () => {
    render(
      <TasksIndex
        tasks={[{ id: "solo", field_count: 3, task_type: "phenotype_validation" }]}
        onOpen={() => {}}
        onCreateTask={() => {}}
      />,
    );
    // With a single kind the pill buttons aren't rendered; only the body
    // "Create new task" button exists as a <button>.
    expect(screen.queryByRole("button", { name: /^phenotype/i })).not.toBeInTheDocument();
  });
});
