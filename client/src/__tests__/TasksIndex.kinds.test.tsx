// @vitest-environment jsdom
//
// TasksIndex kind-tab tests (v2 design). The v2 TasksIndex ALWAYS renders all
// three kind tabs (Phenotype / NER / Adherence) with a count pill each — even
// a kind with zero tasks shows its tab with count 0. The active tab persists
// in localStorage; phenotype is the default. Phenotype rows carry a
// "{n} field(s)" subtitle (singular "1 field"); NER + adherence rows carry no
// subtitle. The version badge renders "v{manual_version}" whenever
// manual_version != null (string or numeric).

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within, fireEvent } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);

afterEach(() => {
  cleanup();
  localStorage.clear();
});

import { TasksIndex, type TaskListing } from "../ui/TasksIndex";

const PHENO: TaskListing = { id: "cancer-diagnosis", field_count: 4, task_type: "phenotype_validation" };
const NER: TaskListing = { id: "bso-ad-ner", field_count: 0, task_type: "ner" };
const ADH: TaskListing = { id: "asthma-adherence", field_count: 0, task_type: "adherence" };

// Tab buttons concatenate label + count into their accessible name; anchor on
// the label so each resolves uniquely.
const phenotypeTab = () => screen.getByRole("button", { name: /^phenotype/i });
const nerTab = () => screen.getByRole("button", { name: /^ner/i });
const adherenceTab = () => screen.getByRole("button", { name: /^adherence/i });

describe("TasksIndex — always renders all three kind tabs", () => {
  it("with only phenotype tasks present, still renders all three tabs (NER 0, Adherence 0)", () => {
    render(<TasksIndex tasks={[PHENO]} onOpen={() => {}} onCreateTask={() => {}} />);

    expect(phenotypeTab()).toBeInTheDocument();
    expect(nerTab()).toBeInTheDocument();
    expect(adherenceTab()).toBeInTheDocument();

    expect(within(phenotypeTab()).getByText("1")).toBeInTheDocument();
    expect(within(nerTab()).getByText("0")).toBeInTheDocument();
    expect(within(adherenceTab()).getByText("0")).toBeInTheDocument();
  });

  it("with zero tasks, still renders all three tabs, every count 0", () => {
    render(<TasksIndex tasks={[]} onOpen={() => {}} onCreateTask={() => {}} />);

    expect(within(phenotypeTab()).getByText("0")).toBeInTheDocument();
    expect(within(nerTab()).getByText("0")).toBeInTheDocument();
    expect(within(adherenceTab()).getByText("0")).toBeInTheDocument();
  });

  it("tab labels are exactly 'Phenotype', 'NER', 'Adherence' (not 'Entity extraction')", () => {
    render(<TasksIndex tasks={[PHENO]} onOpen={() => {}} onCreateTask={() => {}} />);

    expect(within(phenotypeTab()).getByText("Phenotype")).toBeInTheDocument();
    expect(within(nerTab()).getByText("NER")).toBeInTheDocument();
    expect(within(adherenceTab()).getByText("Adherence")).toBeInTheDocument();
    expect(screen.queryByText(/Entity extraction/i)).not.toBeInTheDocument();
  });
});

describe("TasksIndex — counts on a 3-kind mix", () => {
  // pheno 2 / ner 1 / adh 1
  const tasks = [
    PHENO,
    { id: "sepsis-3", field_count: 2, task_type: "phenotype_validation" },
    NER,
    ADH,
  ];

  it("each tab's count pill matches its kind's task count", () => {
    render(<TasksIndex tasks={tasks} onOpen={() => {}} onCreateTask={() => {}} />);
    expect(within(phenotypeTab()).getByText("2")).toBeInTheDocument();
    expect(within(nerTab()).getByText("1")).toBeInTheDocument();
    expect(within(adherenceTab()).getByText("1")).toBeInTheDocument();
  });

  it("the active (phenotype) tab's grid shows only that kind's rows", () => {
    render(<TasksIndex tasks={tasks} onOpen={() => {}} onCreateTask={() => {}} />);
    const ids = Array.from(document.querySelectorAll("ol code")).map((el) => el.textContent ?? "");
    expect(ids.sort()).toEqual(["cancer-diagnosis", "sepsis-3"]);
    expect(screen.queryByText("bso-ad-ner")).not.toBeInTheDocument();
    expect(screen.queryByText("asthma-adherence")).not.toBeInTheDocument();
  });
});

describe("TasksIndex — empty state per kind", () => {
  it("a kind with 0 tasks (others present) shows the 'No … tasks yet' + 'Switch tabs' card", () => {
    // Only phenotype present → NER tab is empty but still selectable.
    render(<TasksIndex tasks={[PHENO]} onOpen={() => {}} onCreateTask={() => {}} />);
    fireEvent.click(nerTab());

    expect(screen.getByText("No ner tasks yet.")).toBeInTheDocument();
    expect(
      screen.getByText(/Switch tabs to see tasks of other kinds, or create a new one\./i),
    ).toBeInTheDocument();
  });

  it("zero tasks total → 'No phenotype tasks yet' + the Create hint", () => {
    render(<TasksIndex tasks={[]} onOpen={() => {}} onCreateTask={() => {}} />);

    expect(screen.getByText("No phenotype tasks yet.")).toBeInTheDocument();
    // Hint text is split across nodes by the bolded "Create new task"; match
    // the surrounding fragments.
    expect(screen.getByText(/to draft your first one\./i)).toBeInTheDocument();
  });
});

describe("TaskRow — subtitle per kind", () => {
  it("phenotype field_count 4 → '4 fields' (plural)", () => {
    render(<TasksIndex tasks={[PHENO]} onOpen={() => {}} onCreateTask={() => {}} />);
    expect(screen.getByText("4 fields")).toBeInTheDocument();
  });

  it("phenotype field_count 1 → '1 field' (singular, not '1 fields')", () => {
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

  it("phenotype field_count UNDEFINED → '0 fields' (never 'undefined fields')", () => {
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

  it("NER row → no field/subtitle text", () => {
    render(<TasksIndex tasks={[NER]} onOpen={() => {}} onCreateTask={() => {}} />);
    fireEvent.click(nerTab());
    expect(screen.getByText("bso-ad-ner")).toBeInTheDocument();
    expect(screen.queryByText(/\bfields?\b/)).not.toBeInTheDocument();
    expect(screen.queryByText("0 fields")).not.toBeInTheDocument();
  });

  it("adherence row → no subtitle", () => {
    render(<TasksIndex tasks={[ADH]} onOpen={() => {}} onCreateTask={() => {}} />);
    fireEvent.click(adherenceTab());
    expect(screen.getByText("asthma-adherence")).toBeInTheDocument();
    expect(screen.queryByText(/\bfields?\b/)).not.toBeInTheDocument();
    expect(screen.queryByText("0 fields")).not.toBeInTheDocument();
  });
});

describe("TaskRow — version badge", () => {
  it("string manual_version '0.3' → 'v0.3'", () => {
    render(
      <TasksIndex
        tasks={[{ id: "x", field_count: 3, task_type: "phenotype_validation", manual_version: "0.3" }]}
        onOpen={() => {}}
        onCreateTask={() => {}}
      />,
    );
    expect(screen.getByText("v0.3")).toBeInTheDocument();
  });

  it("numeric manual_version 0.1 → 'v0.1'", () => {
    render(
      <TasksIndex
        tasks={[{ id: "x", field_count: 3, task_type: "phenotype_validation", manual_version: 0.1 }]}
        onOpen={() => {}}
        onCreateTask={() => {}}
      />,
    );
    expect(screen.getByText("v0.1")).toBeInTheDocument();
  });

  it("absent manual_version → no badge (no 'vundefined')", () => {
    render(<TasksIndex tasks={[PHENO]} onOpen={() => {}} onCreateTask={() => {}} />);
    expect(screen.queryByText(/^v/)).not.toBeInTheDocument();
    expect(screen.queryByText("vundefined")).not.toBeInTheDocument();
  });
});
