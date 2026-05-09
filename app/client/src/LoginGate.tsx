import { useEffect, useState } from "react";
import { login, type WhoamiResponse } from "./auth";

interface Props {
  whoami: WhoamiResponse;
  onAuthenticated: (reviewerId: string) => void;
  /** Called when the user dismisses the prompt without logging in (only available in optional mode). */
  onSkip?: () => void;
}

export function LoginGate({ whoami, onAuthenticated, onSkip }: Props) {
  const [reviewerId, setReviewerId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setReviewerId(localStorage.getItem("chart-review-reviewer-id") ?? "");
  }, []);

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!reviewerId.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await login(reviewerId.trim());
      if (r.ok && r.reviewer_id) {
        onAuthenticated(r.reviewer_id);
      } else {
        setError(r.error ?? "login failed");
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const allowlist = whoami.allowlist ?? [];
  const required = whoami.mode === "required";

  return (
    <div className="absolute inset-0 z-30 bg-ink/40 flex items-center justify-center">
      <div className="bg-card rounded shadow-lg p-5 w-[26rem]">
        <h2 className="text-base font-semibold text-foreground mb-1">
          Chart Review — methodology-first phenotype validation
        </h2>
        <p className="text-xs text-muted-foreground mb-3">
          This tool produces audit-grade chart reviews under locked guidelines.
          Sign in attaches your name to overrides and adjudications; the audit
          trail captures who reviewed what, when, and why.
        </p>
        <p className="text-xs text-muted-foreground mb-3">
          {required
            ? `Reviewer authentication is required. Pick a reviewer id from the allowlist (${allowlist.length} available).`
            : "Optional sign-in — your name will be attached to actions you take and to the audit trail. You can skip and use the platform anonymously."}
        </p>
        <form onSubmit={submit} className="space-y-2">
          <input
            type="text"
            value={reviewerId}
            onChange={(e) => setReviewerId(e.target.value)}
            placeholder="reviewer id (e.g. alice)"
            autoFocus
            className="w-full border border-border rounded px-2 py-1 text-sm font-mono"
          />
          {required && allowlist.length > 0 && (
            <div className="text-[10px] text-muted-foreground">
              allowlist:{" "}
              {allowlist.map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setReviewerId(id)}
                  className="font-mono px-1.5 py-0.5 rounded bg-muted hover:bg-secondary ml-1"
                >
                  {id}
                </button>
              ))}
            </div>
          )}
          {error && <div className="text-xs text-[hsl(var(--oxblood))]">{error}</div>}
          <div className="flex gap-2 pt-2">
            <button
              type="submit"
              disabled={busy || !reviewerId.trim()}
              className="px-3 py-1 rounded bg-primary text-white text-sm hover:bg-primary disabled:bg-secondary"
            >
              {busy ? "signing in…" : "sign in"}
            </button>
            {!required && onSkip && (
              <button
                type="button"
                onClick={onSkip}
                className="px-3 py-1 rounded bg-muted text-foreground text-sm hover:bg-secondary"
              >
                skip
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
