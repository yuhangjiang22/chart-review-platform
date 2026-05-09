import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Sparkles } from "lucide-react";

interface CodifyButtonProps {
  taskId: string;
  manualVersion?: string;
}

interface CodifyResult {
  written_files: string[];
  modified_criteria?: string[];
  cohort_size: number;
  guideline_manual_version: string;
}

export function CodifyButton({ taskId }: CodifyButtonProps) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<CodifyResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    setRunning(true);
    setResult(null);
    setError(null);
    try {
      const r = await fetch(`/api/guideline-codify/${encodeURIComponent(taskId)}`, {
        method: "POST",
      });
      const body = await r.json();
      if (!r.ok) {
        setError(body.error ?? "codify failed");
        return;
      }
      setResult(body as CodifyResult);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            Efficiency artifacts
          </div>
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            Codify keyword sets, code sets, and note-type filters from the validated cohort.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          disabled={running}
          onClick={onClick}
        >
          <Sparkles size={12} strokeWidth={1.75} />
          {running ? "Codifying…" : "Codify artifacts"}
        </Button>
      </div>

      {result && (
        <div
          role="status"
          className="rounded-md border border-[hsl(var(--sage))]/30 bg-[hsl(var(--sage))]/5 px-3 py-2 text-[12.5px] text-[hsl(var(--sage))]"
        >
          {result.written_files.length} file{result.written_files.length === 1 ? "" : "s"} written ·
          cohort {result.cohort_size} · version {result.guideline_manual_version}.
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="rounded-md border border-[hsl(var(--ochre))]/40 bg-[hsl(var(--ochre))]/5 px-3 py-2 text-[12.5px] text-[hsl(var(--ochre))]"
        >
          {error}
        </div>
      )}
    </div>
  );
}
