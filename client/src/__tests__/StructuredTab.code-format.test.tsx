// @vitest-environment jsdom
//
// Guard: some source cohorts (the RUCAM PHI conditions) store a row's codes as
// a stringified numpy array — "['K74.69' 'R18.8' 'B19.20' '213']" — which read
// as an unintelligible jumble in the Structured tab. The tab must normalize
// these to a clean comma-separated list.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);

afterEach(() => cleanup());
beforeEach(() => {
  // StructuredTab uses CSS.escape in its focus effect; jsdom provides it, but
  // guard in case the environment lacks it.
  if (!(globalThis as { CSS?: unknown }).CSS) {
    vi.stubGlobal("CSS", { escape: (s: string) => s });
  }
});

import { StructuredTab, type StructuredData } from "../StructuredTab";

describe("StructuredTab — code-list formatting", () => {
  it("renders a stringified numpy array of ICD codes as a clean comma list", () => {
    const data: StructuredData = {
      conditions: [
        {
          row_id: "c1",
          concept_name: "Ascites",
          icd10cm: "['K74.69' 'R18.8' 'B19.20' 'I85.01' '213']",
          date: "2018-08-06",
        },
      ],
    };
    render(<StructuredTab data={data} />);

    // The raw numpy-repr (with brackets + single quotes) must NOT appear.
    expect(screen.queryByText(/\['K74\.69'/)).toBeNull();
    // The cleaned, comma-separated form must appear.
    expect(screen.getByText("K74.69, R18.8, B19.20, I85.01, 213")).toBeInTheDocument();
  });

  it("passes a plain single code through unchanged", () => {
    const data: StructuredData = {
      conditions: [
        { row_id: "c2", concept_name: "Cirrhosis", icd10cm: "K74.60", date: "2019-05-22" },
      ],
    };
    render(<StructuredTab data={data} />);
    expect(screen.getByText("K74.60")).toBeInTheDocument();
  });
});
