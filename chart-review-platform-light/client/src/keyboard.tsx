// app/client/src/keyboard.tsx
import { useEffect, useRef } from "react";

export interface KeyboardOptions {
  enabled?: boolean;
  onTab?: (tab: "notes" | "task" | "review_form" | "audit") => void;
}

const isText = (el: EventTarget | null): boolean => {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || el.isContentEditable;
};

export function useKeyboardShortcuts(opts: KeyboardOptions = {}) {
  const { enabled = true, onTab } = opts;
  const seqRef = useRef<{ key: string | null; ts: number }>({ key: null, ts: 0 });

  useEffect(() => {
    if (!enabled) return;
    function handler(ev: KeyboardEvent) {
      if (isText(ev.target)) return;
      // sequence: g a → audit tab
      if (ev.key === "g") { seqRef.current = { key: "g", ts: Date.now() }; return; }
      if (ev.key === "a" && seqRef.current.key === "g" && Date.now() - seqRef.current.ts < 1200) {
        seqRef.current = { key: null, ts: 0 };
        onTab?.("audit");
        return;
      }
      seqRef.current = { key: null, ts: 0 };

      const dispatch = (name: string, detail: Record<string, unknown> = {}) =>
        window.dispatchEvent(new CustomEvent(name, { detail }));

      switch (ev.key) {
        case "j": ev.preventDefault(); dispatch("chartreview:nextField"); return;
        case "k": ev.preventDefault(); dispatch("chartreview:prevField"); return;
        case "Enter": ev.preventDefault(); dispatch("chartreview:submitCurrent"); return;
        case "a": ev.preventDefault(); dispatch("chartreview:acceptDraft"); return;
        case "o": ev.preventDefault(); dispatch("chartreview:focusOverride"); return;
        case "f": ev.preventDefault(); dispatch("chartreview:flag"); return;
        case "s": ev.preventDefault(); dispatch("chartreview:focusSearch"); return;
        case "c": ev.preventDefault(); dispatch("chartreview:toggleChat"); return;
        case "?": ev.preventDefault(); dispatch("chartreview:toggleHelp"); return;
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [enabled, onTab]);
}
