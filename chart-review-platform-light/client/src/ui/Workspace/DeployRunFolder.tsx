// DeployRunFolder — the simple "run locked task on a folder" pane.
//
// Two-step flow:
//   1. SCAN    — type a server-side absolute path → POST /api/deploy/:taskId/scan
//                gets back a preview (N patients, M notes each, anything skipped)
//   2. RUN     — confirm the preview → POST /api/deploy/:taskId/run
//                symlinks the subdirs into the corpus, starts a batch run,
//                returns run_id. The AgentLogPanel can then show progress.
//
// Cleanup of the deploy-prefixed symlinks is a separate optional step
// (POST /api/deploy/:taskId/cleanup). For the MVP we leave the symlinks
// in place so the methodologist can browse the deployed patients in the
// patient list after the run completes.

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Sparkles, Folder, Play, AlertCircle, CheckCircle2 } from "lucide-react";
import { authFetch } from "../../auth";

interface ScanResult {
  ok: true;
  folder_path: string;
  patient_count: number;
  patients: Array<{
    original_name: string;
    notes_count: number;
    notes_dir_present: boolean;
  }>;
}
interface RunResult {
  ok: true;
  deploy_id: string;
  run_id: string;
  patient_ids: string[];
  symlinked: Array<{ patient_id: string; source: string }>;
  skipped: Array<{ original_name: string; reason: string }>;
}

export function DeployRunFolder({ taskId }: { taskId: string }) {
  const [folderPath, setFolderPath] = useState<string>("");
  const [scanning, setScanning] = useState(false);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [running, setRunning] = useState(false);
  const [run, setRun] = useState<RunResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function doScan() {
    if (!folderPath.trim()) return;
    setScanning(true);
    setError(null);
    setScan(null);
    setRun(null);
    try {
      const r = await authFetch(`/api/deploy/${encodeURIComponent(taskId)}/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folder_path: folderPath.trim() }),
      });
      const body = await r.json();
      if (!r.ok) {
        setError(body?.error ?? body?.message ?? `scan failed: ${r.status}`);
        return;
      }
      setScan(body as ScanResult);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setScanning(false);
    }
  }

  async function doRun() {
    if (!scan) return;
    setRunning(true);
    setError(null);
    try {
      const r = await authFetch(`/api/deploy/${encodeURIComponent(taskId)}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folder_path: scan.folder_path }),
      });
      const body = await r.json();
      if (!r.ok) {
        setError(body?.error ?? body?.message ?? `run failed: ${r.status}`);
        return;
      }
      setRun(body as RunResult);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  // Pre-flight: any patient with notes_count > 0 is runnable.
  const runnable = scan?.patients.filter((p) => p.notes_dir_present && p.notes_count > 0) ?? [];
  const unrunnable = scan?.patients.filter((p) => !p.notes_dir_present || p.notes_count === 0) ?? [];

  return (
    <div className="mx-auto max-w-[760px] space-y-6 py-4">
      <div>
        <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          Deploy locked task on a folder
        </div>
        <h2
          className="mt-2 font-display text-[24px] tracking-tight"
          style={{ fontVariationSettings: '"opsz" 28, "SOFT" 50' }}
        >
          Score new patients with <code className="font-mono text-[20px]">{taskId}</code>
        </h2>
        <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
          Point at a server-side folder where each subdirectory is one patient.
          Each patient must have a <code>notes/</code> subdir with <code>.txt</code>{" "}
          files inside. The same agents that ran during TRY will score every patient
          using the locked rubric.
        </p>
      </div>

      {/* Step 1 — folder path input */}
      <Card>
        <CardContent className="space-y-3 py-5">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
            Step 1 · Folder
          </div>
          <div className="flex items-center gap-2">
            <Folder size={14} className="shrink-0 text-muted-foreground" />
            <Input
              type="text"
              placeholder="/absolute/path/to/patients-folder"
              value={folderPath}
              onChange={(e) => {
                setFolderPath(e.target.value);
                setScan(null);
                setRun(null);
              }}
              className="font-mono text-[12.5px]"
              autoComplete="off"
              spellCheck={false}
            />
            <Button
              size="sm"
              variant="outline"
              onClick={doScan}
              disabled={scanning || !folderPath.trim()}
              className="shrink-0"
            >
              {scanning ? "Scanning…" : "Scan"}
            </Button>
          </div>
          <div className="text-[11px] text-muted-foreground">
            Expected layout: <code>&lt;folder&gt;/&lt;patient_name&gt;/notes/*.txt</code>.
            On Mac, right-click any folder in Finder → <em>Copy as Pathname</em> to grab the path.
          </div>
        </CardContent>
      </Card>

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-[hsl(var(--oxblood))]/30 bg-[hsl(var(--oxblood))]/5 px-3 py-2 text-[12.5px] text-[hsl(var(--oxblood))]">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Step 2 — preview */}
      {scan && (
        <Card>
          <CardContent className="space-y-3 py-5">
            <div className="flex items-baseline justify-between gap-3">
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                Step 2 · Preview
              </div>
              <div className="text-[11.5px] text-muted-foreground">
                {scan.patient_count} subdirectory{scan.patient_count === 1 ? "" : "ies"} found
              </div>
            </div>
            {runnable.length > 0 && (
              <div className="space-y-1">
                <div className="text-[12px] font-medium">
                  Will run on {runnable.length} patient{runnable.length === 1 ? "" : "s"}:
                </div>
                <ul className="text-[11.5px] text-muted-foreground font-mono space-y-0.5 max-h-40 overflow-y-auto">
                  {runnable.map((p) => (
                    <li key={p.original_name}>
                      {p.original_name} · {p.notes_count} note{p.notes_count === 1 ? "" : "s"}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {unrunnable.length > 0 && (
              <div className="space-y-1">
                <div className="text-[12px] font-medium text-[hsl(var(--ochre))]">
                  Will skip {unrunnable.length} subdirector{unrunnable.length === 1 ? "y" : "ies"}:
                </div>
                <ul className="text-[11.5px] text-muted-foreground font-mono space-y-0.5">
                  {unrunnable.map((p) => (
                    <li key={p.original_name}>
                      {p.original_name} — {!p.notes_dir_present ? "no notes/ subdir" : "notes/ is empty"}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="pt-2">
              <Button
                variant="default"
                size="lg"
                onClick={doRun}
                disabled={running || runnable.length === 0}
                className="gap-2"
              >
                {running ? (
                  <>
                    <Sparkles size={14} className="animate-pulse" />
                    Starting run…
                  </>
                ) : (
                  <>
                    <Play size={14} />
                    Run agents on {runnable.length} patient{runnable.length === 1 ? "" : "s"}
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step 3 — result */}
      {run && (
        <Card>
          <CardContent className="space-y-3 py-5">
            <div className="flex items-center gap-2">
              <CheckCircle2 size={16} className="text-[hsl(var(--sage))]" />
              <div className="text-[13px] font-medium">Run started</div>
            </div>
            <div className="text-[12px] text-muted-foreground space-y-1">
              <div>
                <strong className="text-foreground">run_id:</strong>{" "}
                <code className="font-mono">{run.run_id}</code>
              </div>
              <div>
                <strong className="text-foreground">deploy_id:</strong>{" "}
                <code className="font-mono">{run.deploy_id}</code>{" "}
                <span className="text-muted-foreground">
                  (patient IDs use this as a prefix)
                </span>
              </div>
              <div>
                Ingested {run.patient_ids.length} patient{run.patient_ids.length === 1 ? "" : "s"};
                agents are running in the background.
              </div>
            </div>
            <div className="text-[11.5px] text-muted-foreground border-t border-border/60 pt-3">
              Outputs land in <code>var/runs/{run.run_id}/per_patient/&lt;pid&gt;/agents/agent_*.json</code>.
              Open the TRY phase to watch the live agent log, or check the patient
              list to browse the ingested patients.
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
