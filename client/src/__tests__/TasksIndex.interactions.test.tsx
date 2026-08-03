// @vitest-environment jsdom
//
// TasksIndex EXHAUSTIVE control-interaction tests (v2 design).
//
// Exercises every interactive control in TasksIndex.tsx:
//   - the "Create new task" button (empty + populated libraries)
//   - per-task-row buttons (each calls onOpen with the exact id; phenotype,
//     ner, adherence rows)
//   - the per-kind tab buttons (always-on 3 tabs, counts, active styling,
//     blurb switching, localStorage persistence + default)
//
// v2 design notes:
//   - All three tabs (Phenotype / NER / Adherence) always render with a count
//     pill, regardless of which kinds have tasks.
//   - The active tab persists in localStorage["tasks-index-active-kind"];
//     phenotype is the default. We clear localStorage after each test.
//   - Active tab styling is a foreground underline (border-foreground +
//     text-foreground), not oxblood.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within, fireEvent } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);

afterEach(() => {
  cleanup();
  localStorage.clear();
});

import { TasksIndex, type TaskListing } from "../ui/TasksIndex";

// Verbatim slices of TABS[*].blurb in TasksIndex.tsx.
const PHENOTYPE_BLURB = /Per-criterion adjudication/i;
const NER_BLURB = /Span extraction against an ontology/i;
const ADHERENCE_BLURB = /Question-and-rule chart review/i;

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

// Tab buttons concatenate label + count into their accessible name; anchor on
// the label so each resolves uniquely.
const phenotypeTab = () => screen.getByRole("button", { name: /^phenotype/i });
const nerTab = () => screen.getByRole("button", { name: /^ner/i });
const adherenceTab = () => screen.getByRole("button", { name: /^adherence/i });

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

  it("the empty state still exposes a working Create button (exactly one Create button)", () => {
    const onCreateTask = vi.fn();
    render(<TasksIndex tasks={[]} onOpen={() => {}} onCreateTask={onCreateTask} />);

    // Empty card present.
    expect(screen.getByText(/no phenotype tasks yet/i)).toBeInTheDocument();
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

  it("calls onOpen with the exact id for an NER row (clicked from the NER tab)", () => {
    const onOpen = vi.fn();
    render(<TasksIndex tasks={[PHENO_A, NER_A]} onOpen={onOpen} onCreateTask={() => {}} />);

    // NER tab not active by default (phenotype is the default) → switch to it.
    fireEvent.click(nerTab());
    const rows = taskRowButtons();
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByText("bso-ad-ner")).toBeInTheDocument();
    fireEvent.click(rows[0]);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith("bso-ad-ner");
  });

  it("calls onOpen with the exact id for an ADHERENCE row (clicked from the Adherence tab)", () => {
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
// 3. Always-on three tabs + counts
// ---------------------------------------------------------------------------
describe("TasksIndex — always-on three tabs (3-kind mix)", () => {
  const tasks = [PHENO_A, PHENO_B, NER_A, ADH_A]; // pheno 2 / ner 1 / adh 1

  it("renders all three tabs with correct counts (Phenotype 2 / NER 1 / Adherence 1)", () => {
    render(<TasksIndex tasks={tasks} onOpen={() => {}} onCreateTask={() => {}} />);
    expect(within(phenotypeTab()).getByText("2")).toBeInTheDocument();
    expect(within(nerTab()).getByText("1")).toBeInTheDocument();
    expect(within(adherenceTab()).getByText("1")).toBeInTheDocument();
  });

  it("defaults to the Phenotype tab: only phenotype rows, phenotype blurb, Phenotype active", () => {
    render(<TasksIndex tasks={tasks} onOpen={() => {}} onCreateTask={() => {}} />);
    expect(visibleTaskIds().sort()).toEqual(["cancer-diagnosis", "sepsis-3"]);
    expect(screen.queryByText("bso-ad-ner")).not.toBeInTheDocument();
    expect(screen.queryByText("asthma-adherence")).not.toBeInTheDocument();
    expect(screen.getByText(PHENOTYPE_BLURB)).toBeInTheDocument();
    // Active styling: foreground underline (border-foreground), not oxblood.
    expect(phenotypeTab().className).toContain("border-foreground");
    expect(phenotypeTab().className).not.toContain("oxblood");
    expect(nerTab().className).not.toContain("border-foreground");
  });

  it("clicking the NER tab filters to ONLY the ner row, swaps the blurb, moves active styling", () => {
    render(<TasksIndex tasks={tasks} onOpen={() => {}} onCreateTask={() => {}} />);
    fireEvent.click(nerTab());
    expect(visibleTaskIds()).toEqual(["bso-ad-ner"]);
    expect(screen.queryByText("cancer-diagnosis")).not.toBeInTheDocument();
    expect(screen.queryByText("asthma-adherence")).not.toBeInTheDocument();
    expect(screen.getByText(NER_BLURB)).toBeInTheDocument();
    expect(screen.queryByText(PHENOTYPE_BLURB)).not.toBeInTheDocument();
    expect(nerTab().className).toContain("border-foreground");
    expect(phenotypeTab().className).not.toContain("border-foreground");
  });

  it("clicking the Adherence tab filters to ONLY the adherence row and swaps the blurb", () => {
    render(<TasksIndex tasks={tasks} onOpen={() => {}} onCreateTask={() => {}} />);
    fireEvent.click(adherenceTab());
    expect(visibleTaskIds()).toEqual(["asthma-adherence"]);
    expect(screen.queryByText("cancer-diagnosis")).not.toBeInTheDocument();
    expect(screen.queryByText("bso-ad-ner")).not.toBeInTheDocument();
    expect(screen.getByText(ADHERENCE_BLURB)).toBeInTheDocument();
    expect(adherenceTab().className).toContain("border-foreground");
  });

  it("switching back and forth re-filters each time (pheno → ner → adherence → pheno)", () => {
    render(<TasksIndex tasks={tasks} onOpen={() => {}} onCreateTask={() => {}} />);
    fireEvent.click(nerTab());
    expect(visibleTaskIds()).toEqual(["bso-ad-ner"]);
    fireEvent.click(adherenceTab());
    expect(visibleTaskIds()).toEqual(["asthma-adherence"]);
    fireEvent.click(phenotypeTab());
    expect(visibleTaskIds().sort()).toEqual(["cancer-diagnosis", "sepsis-3"]);
    expect(phenotypeTab().className).toContain("border-foreground");
  });
});

// ---------------------------------------------------------------------------
// 4. Always-on tabs even when some kinds are empty
// ---------------------------------------------------------------------------
describe("TasksIndex — tabs always present regardless of kinds", () => {
  it("only phenotype tasks → all three tabs render (NER 0 / Adherence 0)", () => {
    render(<TasksIndex tasks={[PHENO_A, PHENO_B]} onOpen={() => {}} onCreateTask={() => {}} />);
    expect(phenotypeTab()).toBeInTheDocument();
    expect(nerTab()).toBeInTheDocument();
    expect(adherenceTab()).toBeInTheDocument();
    expect(within(phenotypeTab()).getByText("2")).toBeInTheDocument();
    expect(within(nerTab()).getByText("0")).toBeInTheDocument();
    expect(within(adherenceTab()).getByText("0")).toBeInTheDocument();
  });

  it("zero tasks → all three tabs render, every count 0, phenotype default + empty card", () => {
    render(<TasksIndex tasks={[]} onOpen={() => {}} onCreateTask={() => {}} />);
    expect(within(phenotypeTab()).getByText("0")).toBeInTheDocument();
    expect(within(nerTab()).getByText("0")).toBeInTheDocument();
    expect(within(adherenceTab()).getByText("0")).toBeInTheDocument();
    expect(phenotypeTab().className).toContain("border-foreground");
    expect(screen.getByText(/no phenotype tasks yet/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 5. localStorage persistence + default
// ---------------------------------------------------------------------------
describe("TasksIndex — active-tab persistence", () => {
  it("defaults to the Phenotype tab when no localStorage value is set", () => {
    render(<TasksIndex tasks={[PHENO_A, NER_A, ADH_A]} onOpen={() => {}} onCreateTask={() => {}} />);
    expect(phenotypeTab().className).toContain("border-foreground");
    expect(visibleTaskIds()).toEqual(["cancer-diagnosis"]);
  });

  it("a pre-set localStorage value selects that tab on mount (ner)", () => {
    localStorage.setItem("tasks-index-active-kind", "ner");
    render(<TasksIndex tasks={[PHENO_A, NER_A, ADH_A]} onOpen={() => {}} onCreateTask={() => {}} />);
    expect(nerTab().className).toContain("border-foreground");
    expect(phenotypeTab().className).not.toContain("border-foreground");
    expect(visibleTaskIds()).toEqual(["bso-ad-ner"]);
  });

  it("clicking a tab updates localStorage", () => {
    render(<TasksIndex tasks={[PHENO_A, NER_A, ADH_A]} onOpen={() => {}} onCreateTask={() => {}} />);
    expect(localStorage.getItem("tasks-index-active-kind")).toBe("phenotype");
    fireEvent.click(adherenceTab());
    expect(localStorage.getItem("tasks-index-active-kind")).toBe("adherence");
    fireEvent.click(nerTab());
    expect(localStorage.getItem("tasks-index-active-kind")).toBe("ner");
  });
});

// ---------------------------------------------------------------------------
// 6. Empty state per kind
// ---------------------------------------------------------------------------
describe("TasksIndex — empty state per kind", () => {
  it("an empty kind (others present) shows 'No … tasks yet' + the 'Switch tabs' hint", () => {
    render(<TasksIndex tasks={[PHENO_A]} onOpen={() => {}} onCreateTask={() => {}} />);
    fireEvent.click(nerTab());
    expect(taskRowButtons()).toHaveLength(0);
    expect(screen.getByText("No ner tasks yet.")).toBeInTheDocument();
    expect(
      screen.getByText(/Switch tabs to see tasks of other kinds, or create a new one\./i),
    ).toBeInTheDocument();
  });

  it("zero tasks total → 'No phenotype tasks yet' + the Create hint, no rows, Create works", () => {
    const onCreateTask = vi.fn();
    render(<TasksIndex tasks={[]} onOpen={() => {}} onCreateTask={onCreateTask} />);

    expect(screen.getByText("No phenotype tasks yet.")).toBeInTheDocument();
    expect(screen.getByText(/to draft your first one\./i)).toBeInTheDocument();
    expect(taskRowButtons()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: /create new task/i }));
    expect(onCreateTask).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 7. Counts equal the rows shown when that tab is active
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
// 8. Card subtitle per kind
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

  it("ner row → NO subtitle (no 'field(s)' text)", () => {
    render(<TasksIndex tasks={[NER_A]} onOpen={() => {}} onCreateTask={() => {}} />);
    fireEvent.click(nerTab());
    expect(screen.getByText("bso-ad-ner")).toBeInTheDocument();
    expect(screen.queryByText(/\bfields?\b/)).not.toBeInTheDocument();
  });

  it("adherence row → NO subtitle (no 'field(s)' text)", () => {
    render(<TasksIndex tasks={[ADH_A]} onOpen={() => {}} onCreateTask={() => {}} />);
    fireEvent.click(adherenceTab());
    expect(screen.getByText("asthma-adherence")).toBeInTheDocument();
    expect(screen.queryByText(/\bfields?\b/)).not.toBeInTheDocument();
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
// 9. manual_version badge
// ---------------------------------------------------------------------------
describe("TasksIndex — manual_version badge", () => {
  it("string version → renders 'v<value>'", () => {
    render(
      <TasksIndex
        tasks={[{ id: "x", field_count: 3, task_type: "phenotype_validation", manual_version: "0.3" }]}
        onOpen={() => {}}
        onCreateTask={() => {}}
      />,
    );
    expect(screen.getByText("v0.3")).toBeInTheDocument();
  });

  it("numeric version 0.1 → renders 'v0.1'", () => {
    render(
      <TasksIndex
        tasks={[{ id: "x", field_count: 3, task_type: "phenotype_validation", manual_version: 0.1 }]}
        onOpen={() => {}}
        onCreateTask={() => {}}
      />,
    );
    expect(screen.getByText("v0.1")).toBeInTheDocument();
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
