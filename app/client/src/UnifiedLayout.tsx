// UnifiedLayout.tsx — #34 "left chat copilot + right task workspace" frame.
//
// The chat is a permanent companion on the left; the right side reuses the
// existing AdjudicationLayout so all the criterion-specific UX (LeftPane,
// CriterionPane, NoteViewer, WorkflowBar) keeps working without forking.
//
// Polish pass:
// - The rail width is user-resizable via a vertical drag handle and persists
//   in localStorage so reviewers don't have to redo it every session. We use
//   a mousemove listener (not the CSS `resize` property) because the latter
//   has flaky cross-browser behavior and no programmatic clamp/persist hook.
// - Adjudication mode's bottom ChatDrawer is suppressed inside the unified
//   frame; the rail IS the chat there, so the drawer would be duplicate noise.

import { useCallback, useEffect, useRef, useState } from "react";
import { AdjudicationLayout, type AdjudicationLayoutProps } from "./AdjudicationLayout";
import { ChatPanel } from "./ChatPanel";

const RAIL_WIDTH_KEY = "chartReview.unifiedRailWidth";
const RAIL_MIN_PX = 240;
const RAIL_MAX_PX = 720;
const RAIL_DEFAULT_PX = 384; // 24rem at the default 16px root

function clampRailWidth(px: number): number {
  if (Number.isNaN(px)) return RAIL_DEFAULT_PX;
  return Math.min(RAIL_MAX_PX, Math.max(RAIL_MIN_PX, px));
}

function loadInitialRailWidth(): number {
  if (typeof window === "undefined") return RAIL_DEFAULT_PX;
  try {
    const raw = window.localStorage.getItem(RAIL_WIDTH_KEY);
    if (!raw) return RAIL_DEFAULT_PX;
    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed)) return RAIL_DEFAULT_PX;
    return clampRailWidth(parsed);
  } catch {
    return RAIL_DEFAULT_PX;
  }
}

export function UnifiedLayout(p: AdjudicationLayoutProps) {
  const [railWidth, setRailWidth] = useState<number>(() => loadInitialRailWidth());
  const draggingRef = useRef(false);

  // Persist any final width to localStorage. We write only when dragging stops
  // so we don't hammer storage on every mousemove tick.
  const persistRailWidth = useCallback((px: number) => {
    try {
      window.localStorage.setItem(RAIL_WIDTH_KEY, String(Math.round(px)));
    } catch {
      // localStorage can be disabled (private mode etc.); ignore — the in-memory
      // width still works for the current session.
    }
  }, []);

  const onResizerMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      draggingRef.current = true;

      // Standard React-resizable pattern: arm window-level listeners on
      // mousedown, tear them down on mouseup. Window-level (not the resizer
      // div) so the cursor doesn't have to stay glued to the 4-px handle.
      const onMove = (ev: MouseEvent) => {
        if (!draggingRef.current) return;
        // The rail starts at viewport x=0, so clientX is effectively the
        // candidate width.
        setRailWidth(clampRailWidth(ev.clientX));
      };
      const onUp = (ev: MouseEvent) => {
        if (!draggingRef.current) return;
        draggingRef.current = false;
        const finalPx = clampRailWidth(ev.clientX);
        setRailWidth(finalPx);
        persistRailWidth(finalPx);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };

      // Lock the cursor + suppress text selection while dragging so the page
      // doesn't accidentally select chat messages mid-drag.
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [persistRailWidth],
  );

  // Keyboard nudge: arrow keys on the focused separator move the rail by 16 px.
  // Cheap accessibility pickup — `role="separator"` users expect this.
  const onResizerKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const STEP = 16;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setRailWidth((w) => {
          const next = clampRailWidth(w - STEP);
          persistRailWidth(next);
          return next;
        });
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setRailWidth((w) => {
          const next = clampRailWidth(w + STEP);
          persistRailWidth(next);
          return next;
        });
      }
    },
    [persistRailWidth],
  );

  // Defensive cleanup on unmount in case the user navigates away mid-drag.
  useEffect(() => {
    return () => {
      draggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, []);

  return (
    <div className="flex flex-1 overflow-hidden">
      <aside
        className="flex flex-col border-r border-border bg-card shrink-0"
        style={{ width: `${railWidth}px` }}
      >
        <ChatPanel
          patientId={p.patientId}
          connected={p.sock.connected}
          messages={p.sock.messages}
          busy={p.sock.busy}
          lastError={p.sock.lastError}
          send={p.sock.send}
          mode="full"
        />
      </aside>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize chat rail"
        aria-valuenow={Math.round(railWidth)}
        aria-valuemin={RAIL_MIN_PX}
        aria-valuemax={RAIL_MAX_PX}
        tabIndex={0}
        onMouseDown={onResizerMouseDown}
        onKeyDown={onResizerKeyDown}
        className="w-1 shrink-0 cursor-col-resize bg-secondary hover:bg-slate-400 transition-colors focus:outline-none focus:bg-slate-500"
        title="Drag to resize chat rail"
      />
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* AdjudicationLayout's bottom ChatDrawer is suppressed here — the
            rail to the left is the chat, so the drawer would be duplicate
            noise. The 'c' keyboard toggle still works in standalone
            adjudication mode where hideChatDrawer defaults to false. */}
        <AdjudicationLayout {...p} hideChatDrawer />
      </div>
    </div>
  );
}
