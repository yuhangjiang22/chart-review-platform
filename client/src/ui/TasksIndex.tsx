// TasksIndex — independent top-level page listing all chart-review tasks.
//
// This is the home of the app (`#/tasks`). It is also the *only* surface
// where "Create new task" lives — once the user enters a guideline (Studio,
// Queue, Patient, Builder), the create-task affordance disappears.
//
// Tasks are grouped into three tabs by task_kind (phenotype / ner /
// adherence). The mapping mirrors the server's `taskKindFromTaskType`:
// "phenotype_validation" + "outcome_adjudication" + everything-else fall
// under phenotype; only "ner" and "adherence" peel off. Active tab
// persists in localStorage so a refresh keeps the user where they were.
//
// Clicking a row navigates into Studio at `#/studio/<task-id>`.

import { useEffect, useState } from "react";
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

type TaskKind = "phenotype" | "ner" | "adherence";

const KIND_TAB_KEY = "tasks-index-active-kind";

/** Mirror of server-side `taskKindFromTaskType`. Keep in sync. */
function kindOf(task: TaskListing): TaskKind {
  if (task.task_type === "ner") return "ner";
  if (task.task_type === "adherence") return "adherence";
  return "phenotype";
}

interface TabDef {
  id: TaskKind;
  label: string;
  blurb: string;
}

const TABS: TabDef[] = [
  {
    id: "phenotype",
    label: "Phenotype",
    blurb: "Per-criterion adjudication. Reviewer accepts/overrides agent answers; κ stabilizes; rubric locks.",
  },
  {
    id: "ner",
    label: "NER",
    blurb: "Span extraction against an ontology. Reviewer validates spans and concept mappings note-by-note.",
  },
  {
    id: "adherence",
    label: "Adherence",
    blurb: "Question-and-rule chart review. Per-agent leaderboards drive guidance edits between iters.",
  },
];

export function TasksIndex({ tasks, onOpen, onCreateTask }: TasksIndexProps) {
  const [activeKind, setActiveKind] = useState<TaskKind>(() => {
    try {
      const saved = localStorage.getItem(KIND_TAB_KEY);
      if (saved === "phenotype" || saved === "ner" || saved === "adherence") return saved;
    } catch { /* localStorage may be unavailable */ }
    return "phenotype";
  });

  // Persist tab selection across refreshes.
  useEffect(() => {
    try { localStorage.setItem(KIND_TAB_KEY, activeKind); }
    catch { /* ignore */ }
  }, [activeKind]);

  // Bucket tasks by kind so the tab bar can show counts AND we can
  // render the active list in one pass.
  const buckets: Record<TaskKind, TaskListing[]> = { phenotype: [], ner: [], adherence: [] };
  for (const t of tasks) buckets[kindOf(t)].push(t);
  const activeList = buckets[activeKind];
  const activeTab = TABS.find((t) => t.id === activeKind)!;

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

      {/* Kind tab bar. Counts come from the bucketed map so an empty
       *  kind still shows its tab — clicking gives a useful "0 tasks"
       *  empty state instead of hiding the kind entirely. */}
      <nav
        aria-label="Task kinds"
        className="mb-3 flex items-center gap-1 border-b border-border"
      >
        {TABS.map((t) => {
          const count = buckets[t.id].length;
          const isActive = activeKind === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setActiveKind(t.id)}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "relative -mb-px flex items-baseline gap-2 px-4 py-2.5 text-[13px] font-medium transition-colors",
                isActive
                  ? "text-foreground border-b-2 border-foreground"
                  : "text-muted-foreground hover:text-foreground border-b-2 border-transparent",
              )}
            >
              <span>{t.label}</span>
              <span
                className={cn(
                  "rounded-full px-1.5 py-0.5 text-[10px] tabular-nums",
                  isActive ? "bg-foreground/10 text-foreground" : "bg-muted text-muted-foreground",
                )}
              >
                {count}
              </span>
            </button>
          );
        })}
      </nav>

      <p className="mb-5 text-[12.5px] leading-relaxed text-muted-foreground">
        {activeTab.blurb}
      </p>

      <Separator className="mb-5" />

      {activeList.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">
            <BookOpen className="mx-auto mb-3" size={28} />
            <div className="text-[15px] text-foreground">
              No {activeTab.label.toLowerCase()} tasks yet.
            </div>
            <div className="mt-1 text-[13px]">
              {tasks.length === 0
                ? <>Click <span className="font-medium">Create new task</span> to draft your first one.</>
                : <>Switch tabs to see tasks of other kinds, or create a new one.</>}
            </div>
          </CardContent>
        </Card>
      ) : (
        <ol className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
          {activeList.map((task) => (
            <TaskRow key={task.id} task={task} onOpen={onOpen} />
          ))}
        </ol>
      )}
    </div>
  );
}

function TaskRow({ task, onOpen }: { task: TaskListing; onOpen: (taskId: string) => void }) {
  const kind = kindOf(task);
  // Unit label depends on task_kind. Adherence's "fields" are questions,
  // NER's "fields" are entity-types — the raw `field_count` from the
  // server is 0 for both today since they don't use field_assessments,
  // so we hide it for those kinds rather than print "0 fields".
  const unitLabel = kind === "phenotype" ? `${task.field_count} fields` : null;
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
            {unitLabel && (
              <div className="mt-1 flex items-center gap-2 text-[12px] text-muted-foreground">
                <span className="tabular-nums">{unitLabel}</span>
              </div>
            )}
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
