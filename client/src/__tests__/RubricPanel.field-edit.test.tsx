// @vitest-environment jsdom
//
// Regression: editing a criterion's allowed-answers and an incidental parent
// re-fetch (same field id, fresh object) must NOT wipe the in-progress edit
// before Save. The reset effect must key on field_id, not the field object.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);
afterEach(() => cleanup());

import { FieldEditor } from "../ui/Workspace/RubricPanel";

const field = (over: Record<string, unknown> = {}) => ({
  field_id: "item_1_time_to_onset",
  prompt: "RUCAM Item 1 — time to onset score",
  enum: ["2", "1", "0"],
  definition: "def", extraction_guidance: "guide", examples: "ex",
  ...over,
});
// textbox order in FieldEditor: [0]=prompt input, [1]=allowed-answers textarea, …
const enumBox = () => (screen.getAllByRole("textbox") as HTMLTextAreaElement[])[1];

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k), clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null, get length() { return store.size; },
  } as unknown as Storage);
});

describe("FieldEditor — edits survive incidental re-fetch", () => {
  it("keeps the typed -1 when the SAME field is re-passed as a fresh object", () => {
    const { rerender } = render(
      <FieldEditor taskId="rucam" field={field()} onSaved={vi.fn()} sessionId="session_009" />,
    );
    fireEvent.change(enumBox(), { target: { value: "2\n1\n0\n-1" } });
    expect(enumBox().value).toBe("2\n1\n0\n-1");
    // Incidental re-fetch: a NEW field object, same field_id, server's old enum.
    rerender(<FieldEditor taskId="rucam" field={field()} onSaved={vi.fn()} sessionId="session_009" />);
    expect(enumBox().value).toBe("2\n1\n0\n-1");   // pre-fix this reverted to "2\n1\n0"
  });

  it("Save posts the edited enum (incl. -1)", () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) } as Response));
    vi.stubGlobal("fetch", fetchMock);
    render(<FieldEditor taskId="rucam" field={field()} onSaved={vi.fn()} sessionId="session_009" />);
    fireEvent.change(enumBox(), { target: { value: "2\n1\n0\n-1" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.enum).toEqual(["2", "1", "0", "-1"]);
  });

  it("DOES reset when switching to a different field id", () => {
    const { rerender } = render(
      <FieldEditor taskId="rucam" field={field()} onSaved={vi.fn()} sessionId="session_009" />,
    );
    fireEvent.change(enumBox(), { target: { value: "2\n1\n0\n-1" } });
    rerender(
      <FieldEditor taskId="rucam"
        field={field({ field_id: "item_2_course", enum: ["3", "2", "1", "0", "-2"] })}
        onSaved={vi.fn()} sessionId="session_009" />,
    );
    expect(enumBox().value).toBe("3\n2\n1\n0\n-2");
  });
});
