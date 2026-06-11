// @vitest-environment jsdom
//
// TasksIndex EXHAUSTIVE control-interaction tests.
//
// Exercises every interactive control in TasksIndex.tsx in multiple
// situations:
//   - the "Create new task" button (empty + populated libraries)
//   - per-task-row buttons (each calls onOpen with the exact id; phenotype,
//     ner, adherence rows)
//   - the per-kind tab buttons (filtering, counts, active styling, blurb
//     switching, presence/absence, stale-active-tab fallback)
//
// Conventions follow client/src/__tests__/TasksIndex.kinds.test.tsx and
// Library.test.tsx: jsdom env, fireEvent.click, vi.fn() callbacks,
// jest-dom matchers, cleanup() after each.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within, fireEvent } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);

afterEach(() => {
  cleanup();
});

import { TasksIndex, type TaskListing } from "../ui/TasksIndex";

// Blurb fragments (verbatim slices of KIND_META[*].blurb in TasksIndex.tsx).
const PHENOTYPE_BLURB = /Per-criterion adjudication/i;
const NER_BLURB = /Named-entity recognition/i;
const ADHERENCE_BLURB = /Guideline concordance\. Reviewer adjudicates tier-grouped/i;

// The grid <ol> holds the task rows; query rows from there so the tab
// buttons (which also have role=button) never get confused for task rows.
function taskRowButtons(): HTMLElement[] {
  const list = document.querySelector("ol");
  if (!list) return [];
  return Array.from(list.querySelectorAll("button"));
}

function visibleTaskIds(): string[] {
  // Each row's <code> holds the task id.
  return Array.from(document.querySelectorAll("ol code")).map((el) => el.textContent ?? "");
}

// Tab buttons live in the bordered tab strip directly above the grid; they
// are the buttons that carry a kind label. We resolve them by accessible
// name (label + count text concatenate into the name).
function phenotypeTab() {
  return screen.getByRole("button", { name: /^phenotype/i });
}
function nerTab() {
  return screen.getByRole("button", { name: /^entity extraction/i });
}
function adherenceTab() {
  return screen.getByRole("button", { name: /^adherence/i });
}

const PHENO_A: TaskListing = { id: "cancer-diagnosis", field_count: 4, task_type: "phenotype_validation" };
const PHENO_B: TaskListing = { id: "sepsis-3", field_count: 2, task_type: "phenotype_validation" };
const NER_A: TaskListing = { id: "bso-ad-ner", field_count: 0, task_type: "ner" };
const ADH_A: TaskListing = { id: "asthma-adherence", field_count: 0, task_type: "adherence" };

// ---------------------------------------------------------------------------
// 1. "Create new task" button
// ---------------------------------------------------------------------------
describe("TasksIndex — Create new task button", () => {
  it("fires onCreateTask exactly once when the library is EMPTY", () => {
    const onCreateTask = vi.fn();
    render(<TasksIndex tasks={[]} onOpen={() => {}} onCreateTask={onCreateTask} />);

    const btn = screen.getByRole("button", { name: /create new task/i });
    fireEvent.click(btn);
    expect(onCreateTask).toHaveBeenCalledTimes(1);
    // onCreateTask is wired directly as onClick, so React hands it the
    // synthetic click event; the contract that matters is "called once".
  });

  it("fires onCreateTask once per click, with TASKS PRESENT, and does not call onOpen", () => {
    const onCreateTask = vi.fn();
    const onOpen = vi.fn();
    render(<TasksIndex tasks={[PHENO_A, NER_A]} onOpen={onOpen} onCreateTask={onCreateTask} />);

    const btn = screen.getByRole("button", { name: /create new task/i });
    fireEvent.click(btn);
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(onCreateTask).toHaveBeenCalledTimes(3);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("the empty-state still exposes a working Create button (clickable from the 'No tasks yet' card view)", () => {
    const onCreateTask = vi.fn();
    render(<TasksIndex tasks={[]} onOpen={() => {}} onCreateTask={onCreateTask} />);

    // Empty card present.
    expect(screen.getByText(/no tasks yet/i)).toBeInTheDocument();
    // Exactly one Create button (topbar action only).
    const btns = screen.getAllByRole("button", { name: /create new task/i });
    expect(btns).toHaveLength(1);
    fireEvent.click(btns[0]);
    expect(onCreateTask).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Task-row click → onOpen(exact id), per kind
// ---------------------------------------------------------------------------
describe("TasksIndex — task row click → onOpen", () => {
  it("calls onOpen with the exact id for a PHENOTYPE row", () => {
    const onOpen = vi.fn();
    render(<TasksIndex tasks={[PHENO_A]} onOpen={onOpen} onCreateTask={() => {}} />);

    const rows = taskRowButtons();
    expect(rows).toHaveLength(1);
    fireEvent.click(rows[0]);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith("cancer-diagnosis");
  });

  it("calls onOpen with the exact id for an NER row (clicked from its own tab)", () => {
    const onOpen = vi.fn();
    render(<TasksIndex tasks={[PHENO_A, NER_A]} onOpen={onOpen} onCreateTask={() => {}} />);

    // NER tab not active by default (phenotype is first) → switch to it.
    fireEvent.click(nerTab());
    const rows = taskRowButtons();
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByText("bso-ad-ner")).toBeInTheDocument();
    fireEvent.click(rows[0]);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith("bso-ad-ner");
  });

  it("calls onOpen with the exact id for an ADHERENCE row (clicked from its own tab)", () => {
    const onOpen = vi.fn();
    render(<TasksIndex tasks={[PHENO_A, ADH_A]} onOpen={onOpen} onCreateTask={() => {}} />);

    fireEvent.click(adherenceTab());
    const rows = taskRowButtons();
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByText("asthma-adherence")).toBeInTheDocument();
    fireEvent.click(rows[0]);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith("asthma-adherence");
  });

  it("clicking different rows passes each row's own id (two phenotype rows)", () => {
    const onOpen = vi.fn();
    render(<TasksIndex tasks={[PHENO_A, PHENO_B]} onOpen={onOpen} onCreateTask={() => {}} />);

    const rows = taskRowButtons();
    expect(rows).toHaveLength(2);
    fireEvent.click(rows[0]);
    fireEvent.click(rows[1]);
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(onOpen).toHaveBeenNthCalledWith(1, "cancer-diagnosis");
    expect(onOpen).toHaveBeenNthCalledWith(2, "sepsis-3");
  });
});

// ---------------------------------------------------------------------------
// 3a. Tab switching — full 3-kind mix
// ---------------------------------------------------------------------------
describe("TasksIndex — tab switching (3 kinds present)", () => {
  const tasks = [PHENO_A, PHENO_B, NER_A, ADH_A]; // pheno 2 / ner 1 / adh 1

  it("renders all three tabs with correct counts (Phenotype 2 / Entity extraction 1 / Adherence 1)", () => {
    render(<TasksIndex tasks={tasks} onOpen={() => {}} onCreateTask={() => {}} />);
    expect(within(phenotypeTab()).getByText("2")).toBeInTheDocument();
    expect(within(nerTab()).getByText("1")).toBeInTheDocument();
    expect(within(adherenceTab()).getByText("1")).toBeInTheDocument();
  });

  it("defaults to the Phenotype tab: shows only phenotype rows, phenotype blurb, and Phenotype is active", () => {
    render(<TasksIndex tasks={tasks} onOpen={() => {}} onCreateTask={() => {}} />);
    expect(visibleTaskIds().sort()).toEqual(["cancer-diagnosis", "sepsis-3"]);
    expect(screen.queryByText("bso-ad-ner")).not.toBeInTheDocument();
    expect(screen.queryByText("asthma-adherence")).not.toBeInTheDocument();
    expect(screen.getByText(PHENOTYPE_BLURB)).toBeInTheDocument();
    // Active styling: active tab carries the text-ink class (others muted).
    expect(phenotypeTab().className).toContain("text-ink");
    expect(nerTab().className).not.toContain("text-ink");
  });

  it("clicking the Entity-extraction tab filters to ONLY the ner row, swaps the blurb, and moves active styling", () => {
    render(<TasksIndex tasks={tasks} onOpen={() => {}} onCreateTask={() => {}} />);
    fireEvent.click(nerTab());
    expect(visibleTaskIds()).toEqual(["bso-ad-ner"]);
    expect(screen.queryByText("cancer-diagnosis")).not.toBeInTheDocument();
    expect(screen.queryByText("asthma-adherence")).not.toBeInTheDocument();
    expect(screen.getByText(NER_BLURB)).toBeInTheDocument();
    expect(screen.queryByText(PHENOTYPE_BLURB)).not.toBeInTheDocument();
    expect(nerTab().className).toContain("text-ink");
    expect(phenotypeTab().className).not.toContain("text-ink");
  });

  it("clicking the Adherence tab filters to ONLY the adherence row and swaps the blurb", () => {
    render(<TasksIndex tasks={tasks} onOpen={() => {}} onCreateTask={() => {}} />);
    fireEvent.click(adherenceTab());
    expect(visibleTaskIds()).toEqual(["asthma-adherence"]);
    expect(screen.queryByText("cancer-diagnosis")).not.toBeInTheDocument();
    expect(screen.queryByText("bso-ad-ner")).not.toBeInTheDocument();
    expect(screen.getByText(ADHERENCE_BLURB)).toBeInTheDocument();
    expect(adherenceTab().className).toContain("text-ink");
  });

  it("switching back and forth re-filters each time (pheno → ner → adherence → pheno)", () => {
    render(<TasksIndex tasks={tasks} onOpen={() => {}} onCreateTask={() => {}} />);
    fireEvent.click(nerTab());
    expect(visibleTaskIds()).toEqual(["bso-ad-ner"]);
    fireEvent.click(adherenceTab());
    expect(visibleTaskIds()).toEqual(["asthma-adherence"]);
    fireEvent.click(phenotypeTab());
    expect(visibleTaskIds().sort()).toEqual(["cancer-diagnosis", "sepsis-3"]);
    expect(phenotypeTab().className).toContain("text-ink");
  });
});

// ---------------------------------------------------------------------------
// 3b. Tab switching — exactly 2 kinds
// ---------------------------------------------------------------------------
describe("TasksIndex — tab switching (2 kinds present)", () => {
  it("renders exactly two tabs (phenotype + ner), no adherence tab", () => {
    render(<TasksIndex tasks={[PHENO_A, NER_A]} onOpen={() => {}} onCreateTask={() => {}} />);
    expect(phenotypeTab()).toBeInTheDocument();
    expect(nerTab()).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^adherence/i })).not.toBeInTheDocument();
  });

  it("switching from phenotype to ner filters the grid and back-switching restores it", () => {
    render(<TasksIndex tasks={[PHENO_A, NER_A]} onOpen={() => {}} onCreateTask={() => {}} />);
    // Default phenotype.
    expect(visibleTaskIds()).toEqual(["cancer-diagnosis"]);
    fireEvent.click(nerTab());
    expect(visibleTaskIds()).toEqual(["bso-ad-ner"]);
    expect(screen.getByText(NER_BLURB)).toBeInTheDocument();
    fireEvent.click(phenotypeTab());
    expect(visibleTaskIds()).toEqual(["cancer-diagnosis"]);
    expect(screen.getByText(PHENOTYPE_BLURB)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 3c. Tab switching — single kind (no tabs)
// ---------------------------------------------------------------------------
describe("TasksIndex — single kind (no tab bar)", () => {
  it("renders NO tab bar, shows all rows, and shows that kind's blurb (phenotype)", () => {
    render(<TasksIndex tasks={[PHENO_A, PHENO_B]} onOpen={() => {}} onCreateTask={() => {}} />);
    // No kind tab buttons.
    expect(screen.queryByRole("button", { name: /^phenotype/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^entity extraction/i })).not.toBeInTheDocument();
    // All rows shown.
    expect(visibleTaskIds().sort()).toEqual(["cancer-diagnosis", "sepsis-3"]);
    // Phenotype blurb shown.
    expect(screen.getByText(PHENOTYPE_BLURB)).toBeInTheDocument();
  });

  it("single NER kind: no tabs, ner blurb shown", () => {
    render(<TasksIndex tasks={[NER_A]} onOpen={() => {}} onCreateTask={() => {}} />);
    expect(screen.queryByRole("button", { name: /^entity extraction/i })).not.toBeInTheDocument();
    expect(screen.getByText(NER_BLURB)).toBeInTheDocument();
    expect(visibleTaskIds()).toEqual(["bso-ad-ner"]);
  });

  it("single ADHERENCE kind: no tabs, adherence blurb shown", () => {
    render(<TasksIndex tasks={[ADH_A]} onOpen={() => {}} onCreateTask={() => {}} />);
    expect(screen.queryByRole("button", { name: /^adherence/i })).not.toBeInTheDocument();
    expect(screen.getByText(ADHERENCE_BLURB)).toBeInTheDocument();
    expect(visibleTaskIds()).toEqual(["asthma-adherence"]);
  });
});

// ---------------------------------------------------------------------------
// 3d. Zero tasks — empty card, no tabs, no blurb, Create still works
// ---------------------------------------------------------------------------
describe("TasksIndex — zero tasks (empty state)", () => {
  it("shows the empty card, no tabs, NO kind-blurb, and a working Create button", () => {
    const onCreateTask = vi.fn();
    render(<TasksIndex tasks={[]} onOpen={() => {}} onCreateTask={onCreateTask} />);

    // Empty card.
    expect(screen.getByText(/no tasks yet/i)).toBeInTheDocument();
    // No tab buttons of any kind.
    expect(screen.queryByRole("button", { name: /^phenotype/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^entity extraction/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^adherence/i })).not.toBeInTheDocument();
    // No kind blurb above the empty card (blurb is gated on tasks.length > 0).
    expect(screen.queryByText(PHENOTYPE_BLURB)).not.toBeInTheDocument();
    expect(screen.queryByText(NER_BLURB)).not.toBeInTheDocument();
    expect(screen.queryByText(ADHERENCE_BLURB)).not.toBeInTheDocument();
    // No task rows.
    expect(taskRowButtons()).toHaveLength(0);
    // Create works.
    fireEvent.click(screen.getByRole("button", { name: /create new task/i }));
    expect(onCreateTask).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Counts equal the rows shown when that tab is active
// ---------------------------------------------------------------------------
describe("TasksIndex — tab counts match visible row counts", () => {
  it("each tab's count equals the number of rows shown when that tab is active", () => {
    // pheno 2 / ner 1 / adh 3
    const tasks = [
      PHENO_A,
      PHENO_B,
      NER_A,
      ADH_A,
      { id: "statin-adherence", field_count: 0, task_type: "adherence" },
      { id: "copd-adherence", field_count: 0, task_type: "adherence" },
    ];
    render(<TasksIndex tasks={tasks} onOpen={() => {}} onCreateTask={() => {}} />);

    // Phenotype: count badge 2, rows 2.
    expect(within(phenotypeTab()).getByText("2")).toBeInTheDocument();
    fireEvent.click(phenotypeTab());
    expect(taskRowButtons()).toHaveLength(2);

    // NER: count badge 1, rows 1.
    expect(within(nerTab()).getByText("1")).toBeInTheDocument();
    fireEvent.click(nerTab());
    expect(taskRowButtons()).toHaveLength(1);

    // Adherence: count badge 3, rows 3.
    expect(within(adherenceTab()).getByText("3")).toBeInTheDocument();
    fireEvent.click(adherenceTab());
    expect(taskRowButtons()).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// 5. Card subtitle per kind
// ---------------------------------------------------------------------------
describe("TasksIndex — card subtitle per kind", () => {
  it("phenotype with count 4 → '4 fields' (plural)", () => {
    render(<TasksIndex tasks={[PHENO_A]} onOpen={() => {}} onCreateTask={() => {}} />);
    expect(screen.getByText("4 fields")).toBeInTheDocument();
  });

  it("phenotype with count 1 → '1 field' (singular)", () => {
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

  it("ner → 'entity extraction'", () => {
    render(<TasksIndex tasks={[NER_A]} onOpen={() => {}} onCreateTask={() => {}} />);
    expect(screen.getByText("entity extraction")).toBeInTheDocument();
  });

  it("adherence → 'guideline concordance'", () => {
    render(<TasksIndex tasks={[ADH_A]} onOpen={() => {}} onCreateTask={() => {}} />);
    expect(screen.getByText("guideline concordance")).toBeInTheDocument();
  });

  it("phenotype with field_count UNDEFINED → '0 fields' (never 'undefined fields')", () => {
    render(
      <TasksIndex
        // field_count omitted on purpose; cast through unknown to bypass the
        // required-prop type while exercising the runtime ?? 0 guard.
        tasks={[{ id: "no-count", task_type: "phenotype_validation" } as unknown as TaskListing]}
        onOpen={() => {}}
        onCreateTask={() => {}}
      />,
    );
    expect(screen.getByText("0 fields")).toBeInTheDocument();
    expect(screen.queryByText("undefined fields")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 6. manual_version badge
// ---------------------------------------------------------------------------
describe("TasksIndex — manual_version badge", () => {
  it("string version → renders 'v<value>'", () => {
    render(
      <TasksIndex
        tasks={[{ id: "x", field_count: 3, task_type: "phenotype_validation", manual_version: "2.1" }]}
        onOpen={() => {}}
        onCreateTask={() => {}}
      />,
    );
    expect(screen.getByText("v2.1")).toBeInTheDocument();
  });

  it("numeric version → renders 'v<value>'", () => {
    render(
      <TasksIndex
        tasks={[{ id: "x", field_count: 3, task_type: "phenotype_validation", manual_version: 5 }]}
        onOpen={() => {}}
        onCreateTask={() => {}}
      />,
    );
    expect(screen.getByText("v5")).toBeInTheDocument();
  });

  it("numeric version 0 (falsy) → still renders 'v0' (uses != null, not truthiness)", () => {
    render(
      <TasksIndex
        tasks={[{ id: "x", field_count: 3, task_type: "phenotype_validation", manual_version: 0 }]}
        onOpen={() => {}}
        onCreateTask={() => {}}
      />,
    );
    expect(screen.getByText("v0")).toBeInTheDocument();
  });

  it("absent version → NO badge (no 'vundefined')", () => {
    render(<TasksIndex tasks={[PHENO_A]} onOpen={() => {}} onCreateTask={() => {}} />);
    expect(screen.queryByText(/^v/)).not.toBeInTheDocument();
    expect(screen.queryByText("vundefined")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 7. Stale active tab — fallback when the active kind vanishes across rerender
// ---------------------------------------------------------------------------
describe("TasksIndex — stale active tab fallback", () => {
  it("active NER tab vanishing leaves the view on Phenotype, not an empty NER grid", () => {
    const { rerender } = render(
      <TasksIndex tasks={[PHENO_A, NER_A]} onOpen={() => {}} onCreateTask={() => {}} />,
    );
    // Activate NER.
    fireEvent.click(nerTab());
    expect(visibleTaskIds()).toEqual(["bso-ad-ner"]);

    // Re-render the SAME instance with ONLY phenotype tasks (ner kind gone).
    rerender(<TasksIndex tasks={[PHENO_A]} onOpen={() => {}} onCreateTask={() => {}} />);

    // Must NOT show an empty NER grid — falls back to phenotype.
    expect(visibleTaskIds()).toEqual(["cancer-diagnosis"]);
    // Single kind now → no tab bar.
    expect(screen.queryByRole("button", { name: /^entity extraction/i })).not.toBeInTheDocument();
    // Phenotype blurb shown (the fallback kind's blurb).
    expect(screen.getByText(PHENOTYPE_BLURB)).toBeInTheDocument();
  });

  it("re-adding tasks after a fallback does NOT auto-jump to a stale tab; phenotype stays active", () => {
    const { rerender } = render(
      <TasksIndex tasks={[PHENO_A, NER_A]} onOpen={() => {}} onCreateTask={() => {}} />,
    );
    fireEvent.click(nerTab());
    expect(visibleTaskIds()).toEqual(["bso-ad-ner"]);

    // Collapse to phenotype only → fallback to phenotype.
    rerender(<TasksIndex tasks={[PHENO_A]} onOpen={() => {}} onCreateTask={() => {}} />);
    expect(visibleTaskIds()).toEqual(["cancer-diagnosis"]);

    // Re-add an NER task. The view must stay on phenotype (the effect snapped
    // activeKind to phenotype), not auto-jump back to the previously-clicked
    // NER tab.
    rerender(<TasksIndex tasks={[PHENO_A, NER_A]} onOpen={() => {}} onCreateTask={() => {}} />);
    expect(visibleTaskIds()).toEqual(["cancer-diagnosis"]);
    expect(phenotypeTab().className).toContain("text-ink");
    expect(nerTab().className).not.toContain("text-ink");
  });

  it("active tab that REMAINS present is preserved across an unrelated rerender", () => {
    const { rerender } = render(
      <TasksIndex tasks={[PHENO_A, NER_A, ADH_A]} onOpen={() => {}} onCreateTask={() => {}} />,
    );
    fireEvent.click(adherenceTab());
    expect(visibleTaskIds()).toEqual(["asthma-adherence"]);

    // Add another phenotype task — adherence kind still present, so the
    // active adherence selection must survive.
    rerender(<TasksIndex tasks={[PHENO_A, PHENO_B, NER_A, ADH_A]} onOpen={() => {}} onCreateTask={() => {}} />);
    expect(visibleTaskIds()).toEqual(["asthma-adherence"]);
    expect(adherenceTab().className).toContain("text-ink");
  });
});
