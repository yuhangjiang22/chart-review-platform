import { useEffect, useState } from "react";

interface Props {
  taskId: string;
  token: string;
  /** Path relative to draft root, e.g. "builder/references/foo/raw.pdf" */
  citedPath: string | null;
  citedSource: "sample" | "reference" | null;
  /** Called when the drawer's X button is clicked. */
  onClose?: () => void;
}

export function SourceViewer({ taskId, token, citedPath, citedSource, onClose }: Props) {
  // Drawer is "open" when there's something to show OR when the user explicitly opened it.
  const [forcedOpen, setForcedOpen] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const auto = !!citedPath;
  const open = forcedOpen || auto;

  // Auto-open when a citation arrives.
  useEffect(() => {
    if (citedPath) setForcedOpen(true);
  }, [citedPath]);

  // Fetch text when a non-PDF citation is active.
  useEffect(() => {
    if (!citedPath) { setText(null); setError(null); return; }
    if (citedSource === "reference") { setText(null); setError(null); return; }
    setLoading(true);
    setError(null);
    fetch(
      `/api/builder/sessions/${taskId}/files?path=${encodeURIComponent(citedPath)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((t) => setText(t))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [taskId, citedPath, citedSource, token]);

  const refIdMatch = citedPath?.match(/^builder\/references\/([^/]+)\//);
  const refId = refIdMatch?.[1];

  if (!open) {
    // Collapsed handle, fixed bottom-right.
    return (
      <button
        onClick={() => setForcedOpen(true)}
        className="fixed bottom-3 right-3 z-40 rounded-md border border-border bg-paper/95 px-3 py-1.5 text-xs font-serif shadow-sm hover:bg-card"
      >
        View source files (meta + criteria) ▲
      </button>
    );
  }

  // Expanded drawer, fixed bottom-right.
  return (
    <aside className="fixed bottom-3 right-3 z-40 flex w-[480px] max-h-[60vh] flex-col rounded-md border border-border bg-paper shadow-md">
      <header className="flex h-9 shrink-0 items-center justify-between border-b border-border px-3">
        <span className="font-serif text-xs uppercase tracking-wide">Source</span>
        <button
          onClick={() => {
            setForcedOpen(false);
            onClose?.();
          }}
          className="text-xs text-muted-foreground hover:text-foreground"
          aria-label="close"
        >
          ✕
        </button>
      </header>
      <div className="flex-1 min-h-0 overflow-auto p-3">
        {!citedPath && (
          <div className="text-xs italic text-muted-foreground">
            Click a citation pill in chat to open the cited content.
          </div>
        )}
        {citedSource === "reference" && refId && (
          <embed
            src={`/api/builder/sessions/${taskId}/references/${refId}/raw`}
            className="h-[50vh] w-full"
            type="application/pdf"
          />
        )}
        {citedSource === "sample" && loading && (
          <div className="text-xs italic">loading…</div>
        )}
        {citedSource === "sample" && error && (
          <div className="text-xs text-ochre">error: {error}</div>
        )}
        {citedSource === "sample" && text && (
          <pre className="whitespace-pre-wrap text-xs font-mono">{text}</pre>
        )}
      </div>
    </aside>
  );
}
