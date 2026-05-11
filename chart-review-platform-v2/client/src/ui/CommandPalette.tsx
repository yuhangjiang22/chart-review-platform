// CommandPalette — ⌘K cross-cutting jump tool.
//
// One palette, three sections:
//   - Tasks         → jump to an existing guideline task
//   - Criteria      → jump to a specific criterion in context
//   - Actions       → run guideline workflow actions
//
// Activation: ⌘K (mac) / ctrl-K (other). Esc to close. Fuzzy search via
// cmdk; arrow keys nav; Enter executes.
//
// Aesthetic notes:
// - Group headers in tracked-out caps (Fraunces 10px) read like footnote
//   chapter labels, not SaaS sidebar headers.
// - Selected row gets a thin oxblood spine on the left edge — matches the
//   nav rail's "where am I" cue.
// - Patient ids + criterion ids are Plex Mono so the eye latches onto the
//   technical token, not the prose around it.
import { useEffect } from "react";
import {
  Archive,
  Compass,
  type LucideIcon,
  PenSquare,
  Play,
  Search as SearchIcon,
} from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import type { CompiledField } from "../types";

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tasks: Array<{ id: string; field_count: number }>;
  criteria: CompiledField[];
  activePatientId: string | null;
  onJumpTask: (taskId: string) => void;
  onJumpCriterion: (fieldId: string) => void;
  onAction: (action: PaletteAction) => void;
}

export type PaletteAction =
  | "export-bundle"
  | "start-pilot"
  | "run-calibration"
  | "draft-methods";

export function CommandPalette({
  open,
  onOpenChange,
  tasks,
  criteria,
  activePatientId,
  onJumpTask,
  onJumpCriterion,
  onAction,
}: CommandPaletteProps) {
  // Global ⌘K / ctrl-K listener. Single source of truth, lives next to
  // the palette so the wiring is local.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        onOpenChange(!open);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChange]);

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Search tasks, criteria, and actions…" />
      <CommandList>
        <CommandEmpty>
          <div className="flex flex-col items-center gap-1.5">
            <SearchIcon size={20} className="text-muted-foreground/60" />
            <span>Nothing matches that yet.</span>
            <span className="text-[11px] text-muted-foreground/70">
              Try a task id, a criterion name, or "export"
            </span>
          </div>
        </CommandEmpty>

        {/* ── Tasks ───────────────────────────── */}
        <CommandGroup heading={`Tasks · ${tasks.length}`}>
          {tasks.slice(0, 50).map((task) => (
            <CommandItem
              key={task.id}
              value={`task guideline ${task.id}`}
              onSelect={() => {
                onJumpTask(task.id);
                onOpenChange(false);
              }}
            >
              <Compass size={14} className="text-muted-foreground/70" strokeWidth={1.75} />
              <span className="font-mono text-[12px] text-muted-foreground">{task.id}</span>
              <CommandShortcut>{task.field_count} fields</CommandShortcut>
            </CommandItem>
          ))}
        </CommandGroup>

        {/* ── Criteria ────────────────────────── */}
        {criteria.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading={activePatientId ? `Criteria · ${activePatientId}` : "Criteria"}>
              {criteria.map((f) => (
                <CommandItem
                  key={f.id}
                  value={`criterion ${f.id} ${f.prompt ?? ""}`}
                  onSelect={() => {
                    onJumpCriterion(f.id);
                    onOpenChange(false);
                  }}
                >
                  <Compass size={13} className="text-muted-foreground/70" strokeWidth={1.75} />
                  <span className="font-mono text-[12px]">{f.id}</span>
                  {f.derivation && <CommandShortcut>derived</CommandShortcut>}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        <CommandSeparator />

        {/* ── Actions ─────────────────────────── */}
        <CommandGroup heading="Cohort actions">
          <PaletteRow
            icon={Play}
            label="Start a pilot iteration"
            value="start pilot iteration run"
            onSelect={() => {
              onAction("start-pilot");
              onOpenChange(false);
            }}
          />
          <PaletteRow
            icon={SearchIcon}
            label="Run calibration"
            value="run calibration kappa agreement"
            onSelect={() => {
              onAction("run-calibration");
              onOpenChange(false);
            }}
          />
          <PaletteRow
            icon={PenSquare}
            label="Draft methods section"
            value="draft methods results limitations"
            onSelect={() => {
              onAction("draft-methods");
              onOpenChange(false);
            }}
          />
          <PaletteRow
            icon={Archive}
            label="Export reproducibility bundle"
            value="export bundle tarball"
            onSelect={() => {
              onAction("export-bundle");
              onOpenChange(false);
            }}
          />
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

function PaletteRow({
  icon: Icon,
  label,
  value,
  kbd,
  onSelect,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  kbd?: string;
  onSelect: () => void;
}) {
  return (
    <CommandItem value={value} onSelect={onSelect}>
      <Icon size={14} className="text-muted-foreground/80" strokeWidth={1.75} />
      <span>{label}</span>
      {kbd && <CommandShortcut>{kbd}</CommandShortcut>}
    </CommandItem>
  );
}
