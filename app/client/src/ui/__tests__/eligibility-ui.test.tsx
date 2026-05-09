// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { EligibilityPip } from "../PilotsTab/EligibilityPip";

expect.extend(matchers);

describe("EligibilityPip", () => {
  it("renders 1 of 2 when one consecutive passing", () => {
    render(
      <EligibilityPip
        eligibility={{
          eligible: false,
          consecutive_passing: 1,
          required_consecutive: 2,
          failing_criteria: [],
          override_growth: 0,
        }}
      />
    );
    expect(screen.getByText(/1 of 2/)).toBeInTheDocument();
  });

  it("renders 2 of 2 when fully eligible", () => {
    render(
      <EligibilityPip
        eligibility={{
          eligible: true,
          consecutive_passing: 2,
          required_consecutive: 2,
          failing_criteria: [],
          override_growth: -1,
        }}
      />
    );
    expect(screen.getByText(/2 of 2/)).toBeInTheDocument();
  });
});
