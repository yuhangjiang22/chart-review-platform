// TasksIndex — independent top-level page listing all chart-review tasks.
//
// This is the home of the app (`#/tasks`). It is also the *only* surface
// where "Create new task" lives — once the user enters a guideline (Studio,
// Queue, Patient, Builder), the create-task affordance disappears.
//
// Platform v2 light: only phenotype tasks are supported.
//
// Clicking a row navigates into Studio at `#/studio/<task-id>`.

import { useState } from "react";
import { ArrowRight, BookOpen, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

export interface TaskListing {
  id: string;
  field_count: number;
  task_type?: string;
  manual_version?: string;
}

export interface TasksIndexProps {
  tasks: TaskListing[];
  onOpen: (taskId: string) => void;
  onCreateTask: () => void;
}

// Task kinds split the index into tabs. A task's kind comes from its
// task_type (the server tags NER tasks "ner"; everything else is a
// phenotype rubric). KIND_ORDER fixes the tab order; KIND_META carries the
// human label + the one-line blurb shown under the active tab.
type TaskKind = "phenotype" | "ner";
const KIND_ORDER: TaskKind[] = ["phenotype", "ner"];
const KIND_META: Record<TaskKind, { label: string; blurb: string }> = {
  phenotype: {
    label: "Phenotype",
    blurb: "Per-criterion adjudication. Reviewer accepts/overrides agent answers; κ stabilizes; rubric locks.",
  },
  ner: {
    label: "Entity extraction",
    blurb: "Named-entity recognition. Reviewer accepts/rejects agent-proposed spans, each mapped to an ontology concept.",
  },
};
function kindOf(task: TaskListing): TaskKind {
  return task.task_type === "ner" ? "ner" : "phenotype";
}

export function TasksIndex({ tasks, onOpen, onCreateTask }: TasksIndexProps) {
  // Which kinds are actually present, in canonical order. Tabs only appear
  // when more than one kind exists — a single-kind library reads as a plain
  // list with no needless chrome.
  const presentKinds = KIND_ORDER.filter((k) => tasks.some((t) => kindOf(t) === k));
  const [activeKind, setActiveKind] = useState<TaskKind>(presentKinds[0] ?? "phenotype");
  // Guard against the active tab vanishing (e.g. tasks reloaded): fall back
  // to the first present kind.
  const shownKind = presentKinds.includes(activeKind) ? activeKind : (presentKinds[0] ?? "phenotype");
  const visibleTasks = tasks.filter((t) => kindOf(t) === shownKind);
  const showTabs = presentKinds.length > 1;

  return (
    <div className="animate-rise-in">
      <header className="mb-6 flex items-end justify-between gap-8">
        <div>
          <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
            Library
          </div>
          <h1
            className="mt-1.5 text-[38px] leading-[1.05] tracking-tight"
            style={{ fontVariationSettings: '"opsz" 60, "SOFT" 50, "WONK" 0' }}
          >
            Chart-review tasks
          </h1>
          <p className="mt-3 max-w-[64ch] text-[14.5px] leading-relaxed text-muted-foreground">
            Every guideline you can author, pilot, calibrate, or deploy. Pick
            one to enter its workspace, or start a fresh draft below.
          </p>
        </div>

        <button
          onClick={onCreateTask}
          className="flex shrink-0 items-center gap-2 rounded-md bg-oxblood px-4 py-2.5 text-[13px] font-medium text-paper transition-opacity hover:opacity-90 active:opacity-80"
        >
          <Plus size={14} strokeWidth={2.5} />
          Create new task
        </button>
      </header>

      {showTabs && (
        <div className="mb-4 flex items-center gap-1 border-b border-border">
          {presentKinds.map((k) => {
            const count = tasks.filter((t) => kindOf(t) === k).length;
            const active = k === shownKind;
            return (
              <button
                key={k}
                onClick={() => setActiveKind(k)}
                className={cn(
                  "relative px-3.5 py-2 text-[13px] font-medium transition-colors",
                  active ? "text-ink" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {KIND_META[k].label}
                <span className="ml-1.5 tabular-nums text-[11px] text-muted-foreground/80">{count}</span>
                {active && <span className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-oxblood" aria-hidden />}
              </button>
            );
          })}
        </div>
      )}

      <p className="mb-5 text-[12.5px] leading-relaxed text-muted-foreground">
        {KIND_META[shownKind].blurb}
      </p>

      {!showTabs && <Separator className="mb-5" />}

      {tasks.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">
            <BookOpen className="mx-auto mb-3" size={28} />
            <div className="text-[15px] text-foreground">
              No tasks yet.
            </div>
            <div className="mt-1 text-[13px]">
              Click <span className="font-medium">Create new task</span> to draft your first one.
            </div>
          </CardContent>
        </Card>
      ) : (
        <ol className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
          {visibleTasks.map((task) => (
            <TaskRow key={task.id} task={task} onOpen={onOpen} />
          ))}
        </ol>
      )}
    </div>
  );
}

function TaskRow({ task, onOpen }: { task: TaskListing; onOpen: (taskId: string) => void }) {
  // NER tasks have no criteria fields, so "0 fields" is misleading — describe
  // the task nature instead. Phenotype tasks show their criterion count.
  const unitLabel = kindOf(task) === "ner" ? "entity extraction" : `${task.field_count} fields`;
  return (
    <li className="list-none">
      <button
        onClick={() => onOpen(task.id)}
        className={cn(
          "group relative flex w-full items-stretch overflow-hidden rounded-lg border border-border bg-card text-left shadow-page transition-all",
          "hover:-translate-y-px hover:shadow-card hover:border-border/90",
        )}
      >
        <span className="w-1 shrink-0 bg-transparent transition-colors group-hover:bg-oxblood/60" aria-hidden />
        <div className="flex flex-1 items-center gap-4 px-4 py-3.5">
          <BookOpen size={16} className="shrink-0 text-muted-foreground/80" strokeWidth={1.5} />
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-baseline gap-2">
              <code className="truncate font-mono text-[13px] text-ink">{task.id}</code>
              {task.manual_version && (
                <Badge variant="outline" className="!text-[10px] tabular-nums">
                  v{task.manual_version}
                </Badge>
              )}
            </div>
            <div className="mt-1 flex items-center gap-2 text-[12px] text-muted-foreground">
              <span className="tabular-nums">{unitLabel}</span>
            </div>
          </div>
          <ArrowRight
            size={16}
            strokeWidth={1.75}
            className="shrink-0 text-muted-foreground transition-all group-hover:translate-x-0.5 group-hover:text-ink"
          />
        </div>
      </button>
    </li>
  );
}
