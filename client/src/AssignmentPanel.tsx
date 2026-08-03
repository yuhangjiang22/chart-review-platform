// app/client/src/AssignmentPanel.tsx
import { useState } from "react";
import { authFetch } from "./auth";
import type { SamplingResult } from "./types";
import { Pill, Icon } from "./atoms";

export function AssignmentPanel({ taskIds, reviewerOptions }: { taskIds: string[]; reviewerOptions: string[] }) {
  const [taskId, setTaskId] = useState(taskIds[0] ?? "");
  const [sampleSize, setSampleSize] = useState(20);
  const [stratifyBy, setStratifyBy] = useState<string>("");  // comma-separated
  const [seed, setSeed] = useState(0);
  const [samplingResult, setSamplingResult] = useState<SamplingResult | null>(null);
  const [selectedReviewers, setSelectedReviewers] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  async function sample() {
    setBusy(true);
    const r = await authFetch(`/api/sampling/${taskId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sample_size: sampleSize,
        stratify_by: stratifyBy.split(",").map((s) => s.trim()).filter(Boolean),
        seed,
      }),
    });
    const body = await r.json();
    setBusy(false);
    if (body.ok) setSamplingResult(body);
    else alert("Sample failed: " + (body.error ?? "unknown"));
  }

  async function assign() {
    if (!samplingResult || selectedReviewers.length === 0) return;
    setBusy(true);
    const r = await authFetch(`/api/assignments/${taskId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        patient_ids: samplingResult.sampled,
        reviewer_ids: selectedReviewers,
      }),
    });
    const body = await r.json();
    setBusy(false);
    if (body.ok) alert(`Assigned ${samplingResult.sampled.length} records to ${selectedReviewers.join(", ")}`);
    else alert("Assign failed: " + (body.error ?? "unknown"));
  }

  return (
    <section className="p-4 space-y-3 text-[12.5px]">
      <h3 className="font-semibold text-[14px]">Sample + assign</h3>

      <div className="space-y-2">
        <label className="flex flex-col">
          <span className="text-[11px] text-muted-foreground">task</span>
          <select value={taskId} onChange={(e) => setTaskId(e.target.value)} className="border rounded px-2 py-1">
            {taskIds.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label className="flex flex-col">
          <span className="text-[11px] text-muted-foreground">sample size</span>
          <input type="number" min={1} value={sampleSize} onChange={(e) => setSampleSize(parseInt(e.target.value, 10) || 1)} className="border rounded px-2 py-1 w-24" />
        </label>
        <label className="flex flex-col">
          <span className="text-[11px] text-muted-foreground">stratify by (comma-separated)</span>
          <input type="text" value={stratifyBy} onChange={(e) => setStratifyBy(e.target.value)} placeholder="age_bucket, site" className="border rounded px-2 py-1" />
        </label>
        <label className="flex flex-col">
          <span className="text-[11px] text-muted-foreground">seed (reproducibility)</span>
          <input type="number" value={seed} onChange={(e) => setSeed(parseInt(e.target.value, 10) || 0)} className="border rounded px-2 py-1 w-24" />
        </label>
        <button onClick={sample} disabled={busy || !taskId} className="px-3 py-1 rounded bg-primary text-white disabled:opacity-50 hover:bg-secondary">
          {busy ? "Sampling…" : "Sample"}
        </button>
      </div>

      {samplingResult && (
        <div className="border border-border rounded p-3 space-y-2">
          <div className="font-semibold">Sampling result</div>
          <div className="text-[11.5px] text-muted-foreground">
            {samplingResult.total_eligible} eligible patients · {samplingResult.sampled.length} sampled · {samplingResult.strata.length} strata · {samplingResult.skipped.length} skipped
          </div>
          {samplingResult.strata.map((s, i) => (
            <div key={i} className="text-[11px]">
              <Pill tone="ghost">{JSON.stringify(s.key)}</Pill>
              <span className="ml-2 text-muted-foreground">{s.patient_ids.length} patients</span>
            </div>
          ))}

          <div className="border-t pt-2 mt-2 space-y-2">
            <div className="font-semibold">Assign sampled records to reviewers</div>
            <div className="flex flex-wrap gap-1">
              {reviewerOptions.map((r) => (
                <button key={r}
                  onClick={() => setSelectedReviewers((prev) => prev.includes(r) ? prev.filter((x) => x !== r) : [...prev, r])}
                  className={`px-2 py-0.5 rounded text-[11px] ${selectedReviewers.includes(r) ? "bg-secondary text-foreground" : "bg-muted text-foreground"}`}>
                  {r}
                </button>
              ))}
            </div>
            <button onClick={assign} disabled={busy || selectedReviewers.length === 0}
              className="px-3 py-1 rounded bg-[hsl(var(--sage))] text-white disabled:opacity-50 hover:bg-[hsl(var(--sage)/0.85)]">
              Assign {samplingResult.sampled.length} records to {selectedReviewers.length} reviewer(s)
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
