// app/client/src/QAPanel.tsx
import { useEffect, useState } from "react";
import { authFetch } from "./auth";
import type { QAStats } from "./types";
import { QAPanelCards } from "./QAPanelCards";

export function QAPanel({ taskId }: { taskId: string }) {
  const [stats, setStats] = useState<QAStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    authFetch(`/api/qa/${taskId}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`)))
      .then(setStats)
      .catch((e) => setError(String(e)));
  }, [taskId]);

  if (error)
    return (
      <div className="p-4 text-[hsl(var(--oxblood))] text-[12px]">QA load error: {error}</div>
    );
  if (!stats)
    return (
      <div className="p-4 text-[12px] text-muted-foreground">Loading QA stats…</div>
    );
  return <QAPanelCards stats={stats} />;
}
