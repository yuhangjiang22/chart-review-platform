// app/client/src/ShortcutHelp.tsx
import { useEffect, useState } from "react";
import { Icon, KbdHint } from "./atoms";

const SHORTCUTS: Array<{ keys: string[]; label: string }> = [
  { keys: ["j"], label: "Next criterion" },
  { keys: ["k"], label: "Previous criterion" },
  { keys: ["Enter"], label: "Submit current" },
  { keys: ["a"], label: "Accept agent draft" },
  { keys: ["o"], label: "Focus override form" },
  { keys: ["f"], label: "Flag for second review" },
  { keys: ["s"], label: "Focus chart search" },
  { keys: ["c"], label: "Toggle chat drawer" },
  { keys: ["g", "a"], label: "Audit log" },
  { keys: ["?"], label: "This help" },
];

export function ShortcutHelp() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onToggle = () => setOpen((v) => !v);
    window.addEventListener("chartreview:toggleHelp", onToggle);
    return () => window.removeEventListener("chartreview:toggleHelp", onToggle);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setOpen(false)}>
      <div
        className="bg-card rounded-xl border border-border shadow-2xl w-[480px] p-6"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcut-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <div id="shortcut-title" className="flex items-center gap-2">
            <Icon name="keyboard" size={16} />
            <div className="text-[15px] font-semibold">Keyboard shortcuts</div>
          </div>
          <button onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground">
            <Icon name="x" size={14} />
          </button>
        </div>
        <ul className="space-y-2 text-[13px]">
          {SHORTCUTS.map((s) => (
            <li key={s.label} className="flex items-center justify-between">
              <span>{s.label}</span>
              <KbdHint keys={s.keys} />
            </li>
          ))}
        </ul>
        <div className="mt-4 text-[11px] text-muted-foreground">Inactive while typing in inputs.</div>
      </div>
    </div>
  );
}
