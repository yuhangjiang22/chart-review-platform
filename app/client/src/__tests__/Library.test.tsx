// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);

afterEach(() => {
  cleanup();
});

import { TasksIndex } from "../ui/TasksIndex";

describe("TasksIndex (Library) — U5", () => {
  it("renders exactly one 'Create new task' button (body action only, topbar button removed)", () => {
    render(
      <TasksIndex
        tasks={[]}
        onOpen={() => {}}
        onCreateTask={() => {}}
      />
    );
    const btns = screen.getAllByRole("button", { name: /create new task/i });
    expect(btns).toHaveLength(1);
  });
});
