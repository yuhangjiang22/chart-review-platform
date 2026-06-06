// TasksIndex — independent top-level page listing all chart-review tasks.
//
// This is the home of the app (`#/tasks`). It is also the *only* surface
// where "Create new task" lives — once the user enters a guideline (Studio,
// Queue, Patient, Builder), the create-task affordance disappears.
//
// Platform v2 light: only phenotype tasks are supported.
//
// Clicking a row navigates into Studio at `#/studio/<task-id>`.

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

export function TasksIndex({ tasks, onOpen, onCreateTask }: TasksIndexProps) {
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

      <p className="mb-5 text-[12.5px] leading-relaxed text-muted-foreground">
        Per-criterion adjudication. Reviewer accepts/overrides agent answers; κ stabilizes; rubric locks.
      </p>

      <Separator className="mb-5" />

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
          {tasks.map((task) => (
            <TaskRow key={task.id} task={task} onOpen={onOpen} />
          ))}
        </ol>
      )}
    </div>
  );
}

function TaskRow({ task, onOpen }: { task: TaskListing; onOpen: (taskId: string) => void }) {
  const unitLabel = `${task.field_count} fields`;
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
