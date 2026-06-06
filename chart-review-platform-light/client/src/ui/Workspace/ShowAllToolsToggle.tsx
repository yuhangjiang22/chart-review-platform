import { useState, useEffect } from "react";
import { Wrench } from "lucide-react";
import { cn } from "@/lib/utils";

const STORAGE_KEY_PREFIX = "workspace-show-all-tools:";

interface ShowAllToolsToggleProps {
  taskId: string;
  onChange: (enabled: boolean) => void;
}

/**
 * Small icon-only toggle in the top-right of the Workspace. When on:
 * - The pill bar becomes freely clickable (freeNav = true).
 * - A secondary nav row appears listing legacy tabs.
 * State persists per-task in localStorage.
 */
export function ShowAllToolsToggle({ taskId, onChange }: ShowAllToolsToggleProps) {
  const [enabled, setEnabled] = useState<boolean>(() => {
    try {
      return localStorage.getItem(`${STORAGE_KEY_PREFIX}${taskId}`) === "1";
    } catch {
      return false;
    }
  });

  // Sync to parent and localStorage whenever the value changes.
  useEffect(() => {
    onChange(enabled);
    try {
      localStorage.setItem(`${STORAGE_KEY_PREFIX}${taskId}`, enabled ? "1" : "0");
    } catch {
      /* ignore — storage full */
    }
  }, [enabled, taskId, onChange]);

  return (
    <button
      type="button"
      onClick={() => setEnabled((v) => !v)}
      title={enabled ? "Hide legacy tabs" : "Show all tools"}
      aria-pressed={enabled}
      className={cn(
        "flex h-7 w-7 items-center justify-center rounded-md border transition-colors",
        enabled
          ? "border-foreground/40 bg-foreground/10 text-foreground"
          : "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground",
      )}
    >
      <Wrench size={13} strokeWidth={1.75} aria-hidden />
    </button>
  );
}
