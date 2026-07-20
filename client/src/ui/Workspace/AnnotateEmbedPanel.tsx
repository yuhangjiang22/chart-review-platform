// Embeds the vendored workbench reviewer view (restyled) in the VALIDATE tab.
// POSTs /api/ner-sdk/annotate to ensure batch + workbench, then iframes the URL.
import { useEffect, useState } from "react";
import { authFetch } from "../../auth";

export function AnnotateEmbedPanel({ sessionId, taskId }: { sessionId?: string | null; taskId?: string | null }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await authFetch(`/api/ner-sdk/annotate`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sessionId, ...(taskId ? { task_id: taskId } : {}) }),
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({} as { error?: string; message?: string }));
          const msg = body.error ?? body.message ?? `HTTP ${r.status}`;
          // 400 = an expected client-state condition (e.g. this session's cohort
          // has no notes to annotate) — show it as a neutral notice, not a red
          // failure. 5xx = a real failure.
          if (!cancelled) { if (r.status === 400) setNotice(msg); else setError(`Annotate UI failed: ${msg}`); }
          return;
        }
        const { url } = (await r.json()) as { url: string };
        // Match the iframe host to THIS page's host (localhost vs 127.0.0.1).
        // Same host = same-site, so the workbench's SameSite=Lax auth cookies
        // are sent on the iframe's subresource requests; a host mismatch makes
        // them cross-site and the cookies are withheld → "no role" errors.
        let framed = url;
        try { const u = new URL(url); u.hostname = window.location.hostname; framed = u.toString(); } catch { /* keep url */ }
        if (!cancelled) setUrl(framed);
      } catch (e) { if (!cancelled) setError(String(e)); }
    })();
    return () => { cancelled = true; };
  }, [sessionId, taskId]);

  if (!sessionId) return <div className="text-[13px] text-muted-foreground">No active session.</div>;
  if (error) return <div className="text-[13px] text-red-600">{error}</div>;
  if (notice) return <div className="text-[13px] text-muted-foreground">{notice}</div>;
  if (!url) return <div className="text-[13px] text-muted-foreground">Preparing annotate UI…</div>;
  return (
    <iframe
      src={url}
      title="reviewer"
      className="w-full rounded-md border border-border"
      style={{ height: "78vh" }}
    />
  );
}
