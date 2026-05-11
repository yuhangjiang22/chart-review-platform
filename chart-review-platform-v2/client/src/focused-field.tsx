// app/client/src/focused-field.tsx
//
// Tiny React context so the chat copilot knows which criterion the reviewer
// is currently looking at. CriterionPane sets the focused field when the
// reviewer expands or interacts with it; ChatPanel reads it on send and
// silently prepends a short context block to the user's message.
//
// Implements review-copilot Mode 7 (field-specific help) — answers like
// "what should I put here?" become well-defined because the copilot knows
// what "here" means.

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

export interface FocusedField {
  /** field_id from the guideline criterion */
  fieldId: string;
  /** Current answer in review_state, if known */
  currentValue?: unknown;
}

interface FocusedFieldContextValue {
  focused: FocusedField | null;
  setFocused: (f: FocusedField | null) => void;
}

const FocusedFieldContext = createContext<FocusedFieldContextValue>({
  focused: null,
  setFocused: () => {},
});

export function FocusedFieldProvider({ children }: { children: ReactNode }) {
  const [focused, setFocused] = useState<FocusedField | null>(null);
  // Stable context value — without useMemo, every render hands consumers a
  // fresh object with a fresh setFocused reference, which makes any effect
  // that depends on setFocused thrash (cleanup → setFocused(null) → effect
  // → setFocused(field) → re-render → repeat).
  const value = useMemo(() => ({ focused, setFocused }), [focused]);
  return (
    <FocusedFieldContext.Provider value={value}>
      {children}
    </FocusedFieldContext.Provider>
  );
}

export function useFocusedField(): FocusedFieldContextValue {
  return useContext(FocusedFieldContext);
}

/** Format the focused field as a short context prefix that gets prepended
 *  to the reviewer's chat message. The copilot's system prompt teaches it
 *  to interpret this — see review-copilot/SKILL.md (mode 7). */
export function focusedFieldPrefix(focused: FocusedField | null): string {
  if (!focused) return "";
  const valueStr =
    focused.currentValue === undefined
      ? "—"
      : typeof focused.currentValue === "string"
        ? focused.currentValue
        : JSON.stringify(focused.currentValue);
  return `[focused_field: ${focused.fieldId}, current_value: ${valueStr}]\n\n`;
}
