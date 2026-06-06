import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../components/ui/dialog";

interface Props {
  open: boolean;
  taskId: string;
  token: string;
  /** Path relative to draft root, e.g. "criteria/received_30d_visit.yaml". */
  yamlPath: string;
  onClose: () => void;
  /** Called after a successful save. */
  onSaved: () => void;
}

export function YamlEditorDialog({ open, taskId, token, yamlPath, onClose, onSaved }: Props) {
  const [originalContent, setOriginalContent] = useState<string>("");
  const [draft, setDraft] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    fetch(
      `/api/builder/sessions/${taskId}/files?path=${encodeURIComponent(yamlPath)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((text) => {
        setOriginalContent(text);
        setDraft(text);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [open, taskId, yamlPath, token]);

  async function handleSave() {
    if (draft === originalContent) {
      // No-op save
      onClose();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/builder/sessions/${taskId}/edit`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ target: yamlPath, before: originalContent, after: draft }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) {
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      onSaved();
      onClose();
    } catch (e: any) {
      setError(e?.message ?? "save failed");
    } finally {
      setSaving(false);
    }
  }

  const lines = draft.split("\n").length;
  const dirty = draft !== originalContent;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            <span className="font-mono text-sm">{yamlPath}</span>
          </DialogTitle>
        </DialogHeader>
        {loading ? (
          <div className="py-4 text-sm italic text-muted-foreground">Loading…</div>
        ) : error ? (
          <div className="py-4 text-sm text-ochre">Error: {error}</div>
        ) : (
          <div className="mt-3 space-y-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="w-full h-[60vh] resize-none rounded border border-border bg-card px-3 py-2 font-mono text-xs leading-relaxed"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
            <div className="flex items-center justify-between text-[11px] text-muted-foreground italic">
              <span>{lines} lines · {dirty ? "modified" : "unchanged"}</span>
              <span>
                Saved edits are sent to the agent as a `user_edit` event.
              </span>
            </div>
            <div className="flex justify-end gap-2 mt-3">
              <button
                onClick={onClose}
                disabled={saving}
                className="rounded border border-border bg-card px-3 py-1 text-xs hover:bg-muted disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving || !dirty}
                className="rounded bg-oxblood px-3 py-1 text-xs text-paper disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
