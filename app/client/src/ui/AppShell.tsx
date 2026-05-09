import { useEffect, useState, type ReactNode } from "react";
import {
  Layers,
  LogOut,
  Search,
  ShieldCheck,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { ParsedRoute } from "./useHashRoute";

export interface AppShellProps {
  route: ParsedRoute;
  /** Active patient breadcrumb (omit while on the queue). */
  activePatient?: { id: string; display: string; locked?: boolean } | null;
  activeTask: { id: string; field_count: number };
  reviewer?: { id: string; isMethodologist?: boolean } | null;
  onSignOut?: () => void;
  onOpenCommand?: () => void;
  /** Opens the authoring mode picker (Builder vs One-shot). Only visible on
   *  the Tasks index — once the user is inside a guideline, the create-task
   *  affordance disappears so the only way to start a new task is to go
   *  back to `#/tasks`. */
  onOpenModePicker?: () => void;
  /** When true, the page surface drops the centered max-width container
   *  so full-bleed views (Patient detail) can use the whole viewport. */
  fullBleed?: boolean;
  children: ReactNode;
}

export function AppShell({
  route,
  activePatient,
  activeTask,
  reviewer,
  onSignOut,
  onOpenCommand,
  onOpenModePicker,
  fullBleed = false,
  children,
}: AppShellProps) {
  const [cmdHint, setCmdHint] = useState(false);
  // Show the ⌘K hint after a short delay on first paint so it doesn't fight
  // for attention with the page heading.
  useEffect(() => {
    const t = setTimeout(() => setCmdHint(true), 600);
    return () => clearTimeout(t);
  }, []);

  const scopeLabel = route.page === "builder"
    ? "New task"
    : route.page === "tasks"
      ? "Library"
      : activePatient
        ? "Reviewing"
        : "Task page";
  const onTasksIndex = route.page === "tasks";

  return (
    <TooltipProvider delayDuration={250} skipDelayDuration={500}>
      <div className="flex h-screen w-screen flex-col overflow-hidden bg-background ledger-bg">
        <header className="flex h-14 shrink-0 items-center gap-4 border-b border-border bg-paper/85 px-5 backdrop-blur-sm">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <Tooltip>
              <TooltipTrigger asChild>
                <a
                  href="#/tasks"
                  className="flex shrink-0 items-center gap-3 rounded-md outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label="Home"
                >
                  <span className="seal" aria-hidden>R</span>
                  <div className="hidden leading-tight sm:block">
                    <div
                      className="text-[15px] font-display font-semibold tracking-tight"
                      style={{ fontVariationSettings: '"SOFT" 100, "WONK" 1' }}
                    >
                      Chart Review
                    </div>
                    <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                      scholarly · scalable
                    </div>
                  </div>
                </a>
              </TooltipTrigger>
              <TooltipContent>Home — task library</TooltipContent>
            </Tooltip>
            <div className="flex min-w-0 items-center gap-2 text-[13px]">
              <span className="text-muted-foreground">{scopeLabel}</span>
              {!onTasksIndex && (
                <>
                  <span className="text-muted-foreground/50">/</span>
                  <code className="min-w-0 truncate font-mono text-[12px] text-ink">
                    {activeTask.id}
                  </code>
                  {activeTask.field_count > 0 && (
                    <span className="hidden text-[11px] text-muted-foreground tabular-nums md:inline">
                      {activeTask.field_count} fields
                    </span>
                  )}
                </>
              )}
              {activePatient && (
                <>
                  <span className="text-muted-foreground/50">/</span>
                  <span className="font-mono text-ink">{activePatient.id}</span>
                  <span className="text-foreground">{activePatient.display}</span>
                  {activePatient.locked && <Badge variant="locked">locked</Badge>}
                </>
              )}
            </div>
          </div>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className={cn(
                  "h-8 gap-2 px-2.5 text-muted-foreground transition-opacity",
                  cmdHint ? "opacity-100" : "opacity-60",
                )}
                onClick={onOpenCommand}
              >
                <Search size={13} strokeWidth={1.75} />
                <span className="hidden text-[12px] sm:inline">Search</span>
                <kbd className="ml-1 hidden md:inline">⌘K</kbd>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Jump to a patient, criterion, or run</TooltipContent>
          </Tooltip>

          {reviewer ? (
            <div className="flex items-center gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-[12px]">
                    {reviewer.isMethodologist ? (
                      <ShieldCheck size={12} className="text-[hsl(var(--sage))]" />
                    ) : (
                      <Layers size={12} className="text-muted-foreground" />
                    )}
                    <span className="hidden font-mono text-ink sm:inline">{reviewer.id}</span>
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  {reviewer.isMethodologist ? "Methodologist · can lock + accept" : "Reviewer"}
                </TooltipContent>
              </Tooltip>
              {onSignOut && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" onClick={onSignOut} aria-label="Sign out">
                      <LogOut size={14} strokeWidth={1.5} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Sign out</TooltipContent>
                </Tooltip>
              )}
            </div>
          ) : (
            <Badge variant="outline">anonymous</Badge>
          )}
        </header>

        <main className="flex-1 overflow-hidden">
          {fullBleed ? (
            <div className="h-full">{children}</div>
          ) : (
            <div className="mx-auto h-full max-w-[1440px] overflow-auto px-6 py-6 lg:px-8">
              {children}
            </div>
            )}
        </main>
      </div>
    </TooltipProvider>
  );
}
