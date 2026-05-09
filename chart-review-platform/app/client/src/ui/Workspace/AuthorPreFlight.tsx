/**
 * AuthorPreFlight — Cluster 6 (P2) / W1
 *
 * Renders at the top of the AUTHOR phase panel when maturity is "authoring"
 * or "draft". Fetches GET /api/tasks/:taskId/preflight on mount and re-fetches
 * when taskId changes.
 *
 * Diagnostics are partitioned into errors (block TRY) and warnings
 * (render but don't block). When zero diagnostics, shows a green check.
 */

import { useEffect, useState } from "react";
import { CheckCircle, AlertTriangle, AlertCircle, ExternalLink } from "lucide-react";
import { authFetch } from "../../auth";
import { cn } from "@/lib/utils";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface PreflightDiagnostic {
  code: string;
  path: string;
  field_id?: string;
  message: string;
  level: "error" | "warning";
}

export interface PreflightResult {
  ok: boolean;
  diagnostics: PreflightDiagnostic[];
}

type FetchState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "done"; result: PreflightResult };

// ── Component ─────────────────────────────────────────────────────────────────

interface AuthorPreFlightProps {
  taskId: string;
  /** Called with true when there are error-level diagnostics (TRY should be
   *  disabled), false when clear or only warnings. */
  onHasErrors?: (hasErrors: boolean) => void;
}

export function AuthorPreFlight({ taskId, onHasErrors }: AuthorPreFlightProps) {
  const [state, setState] = useState<FetchState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });

    authFetch(`/api/tasks/${encodeURIComponent(taskId)}/preflight`)
      .then(async (r) => {
        if (cancelled) return;
        if (!r.ok) {
          // 404 = no draft yet, treat as clear (no errors to surface)
          if (r.status === 404) {
            const result: PreflightResult = { ok: true, diagnostics: [] };
            setState({ status: "done", result });
            onHasErrors?.(false);
            return;
          }
          throw new Error(`HTTP ${r.status}`);
        }
        const result: PreflightResult = await r.json();
        setState({ status: "done", result });
        onHasErrors?.(result.diagnostics.some((d) => d.level === "error"));
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setState({ status: "error", message: e.message });
        // Network errors: don't block TRY
        onHasErrors?.(false);
      });

    return () => {
      cancelled = true;
    };
  }, [taskId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Loading ─────────────────────────────────────────────────────────────────
  if (state.status === "loading") {
    return (
      <div className="rounded-md border border-border bg-muted/30 px-4 py-3">
        <span className="text-[12px] text-muted-foreground animate-pulse">
          Running pre-flight check…
        </span>
      </div>
    );
  }

  // ── Fetch error ─────────────────────────────────────────────────────────────
  if (state.status === "error") {
    return (
      <div className="rounded-md border border-border bg-muted/30 px-4 py-3">
        <span className="text-[12px] text-muted-foreground">
          Pre-flight check unavailable ({state.message}) — TRY is not blocked.
        </span>
      </div>
    );
  }

  const { result } = state;
  const errors = result.diagnostics.filter((d) => d.level === "error");
  const warnings = result.diagnostics.filter((d) => d.level === "warning");
  const allClear = result.diagnostics.length === 0;

  // ── Clear state ─────────────────────────────────────────────────────────────
  if (allClear) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-[hsl(var(--sage))]/40 bg-[hsl(var(--sage))]/5 px-4 py-2.5">
        <CheckCircle
          size={14}
          className="shrink-0 text-[hsl(var(--sage))]"
          strokeWidth={2}
        />
        <span className="text-[12px] font-medium text-[hsl(var(--sage))]">
          Pre-flight clear — ready to TRY
        </span>
      </div>
    );
  }

  // ── Diagnostics ─────────────────────────────────────────────────────────────
  return (
    <div className="rounded-md border border-border bg-card p-4 space-y-3">
      <div className="flex items-baseline gap-2">
        <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          Pre-flight
        </span>
        {errors.length > 0 && (
          <span className="text-[11px] font-medium text-[hsl(var(--oxblood))]">
            {errors.length} error{errors.length !== 1 ? "s" : ""} blocking TRY
          </span>
        )}
        {warnings.length > 0 && (
          <span className="text-[11px] text-amber-600">
            {warnings.length} warning{warnings.length !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      <ul className="space-y-1.5">
        {errors.map((d, i) => (
          <DiagnosticRow key={i} diagnostic={d} />
        ))}
        {warnings.map((d, i) => (
          <DiagnosticRow key={`w${i}`} diagnostic={d} />
        ))}
      </ul>
    </div>
  );
}

// ── DiagnosticRow ─────────────────────────────────────────────────────────────

function DiagnosticRow({ diagnostic }: { diagnostic: PreflightDiagnostic }) {
  const isError = diagnostic.level === "error";
  const label = diagnostic.field_id
    ? `${diagnostic.field_id}: ${diagnostic.message}`
    : diagnostic.message;

  // "Open file" link: use the builder files endpoint if there's a path,
  // otherwise fall back to a file:// URL so the user can click it in a desktop
  // browser. Future work: wire to an in-app YAML editor dialog.
  const openHref = buildOpenHref(diagnostic.path);

  return (
    <li
      className={cn(
        "flex items-start gap-2 text-[12px]",
        isError ? "text-[hsl(var(--oxblood))]" : "text-amber-700",
      )}
    >
      {isError ? (
        <AlertCircle size={13} className="mt-0.5 shrink-0" strokeWidth={2} />
      ) : (
        <AlertTriangle size={13} className="mt-0.5 shrink-0" strokeWidth={2} />
      )}
      <span className="flex-1 leading-snug">{label}</span>
      {openHref && (
        <a
          href={openHref}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-0.5 shrink-0 underline underline-offset-2 opacity-70 hover:opacity-100"
          aria-label={`Open file: ${diagnostic.path}`}
        >
          <ExternalLink size={10} strokeWidth={2} />
          Open file
        </a>
      )}
    </li>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Determine the best "open file" URL for a diagnostic path.
 *
 * Priority:
 * 1. If the path includes a task draft dir, build a builder-files API URL
 *    that the in-app source viewer can use.
 * 2. Fall back to a file:// URL (works in desktop browsers / Electron).
 * 3. If path is empty, return null (no link rendered).
 */
function buildOpenHref(filePath: string): string | null {
  if (!filePath) return null;

  // Match .claude/skills/drafts/chart-review-<id>/ prefix
  const draftMatch = filePath.match(
    /\.claude\/skills\/(?:drafts\/)?chart-review-([^/]+)\//,
  );
  if (draftMatch) {
    const taskId = draftMatch[1];
    // Extract the relative path inside the draft dir
    const idx = filePath.indexOf(`chart-review-${taskId}/`);
    if (idx !== -1) {
      const rel = filePath.slice(idx + `chart-review-${taskId}/`.length);
      return `/api/builder/sessions/${encodeURIComponent(taskId)}/files?path=${encodeURIComponent(rel)}`;
    }
  }

  // Fallback: file:// URL
  return `file://${filePath}`;
}
