import { useEffect, useRef } from "react";

/**
 * Hook for accumulating telemetry data during a chart review session.
 *
 * Tracks:
 * - notes_opened: Count of notes opened
 * - total_dwell_ms: Total milliseconds spent interacting with content
 * - searches_run: Count of search operations
 * - ts_open / ts_close: Session start and end timestamps
 * - session_id: UUID for the session
 *
 * Listens for custom events:
 * - chartreview:noteOpen — increments notes_opened
 * - chartreview:search — increments searches_run
 * - chartreview:dwell — accumulates dwell time (expects detail.deltaMs)
 *
 * On page unload, POSTs session summary to /api/reviews/{patientId}/{taskId}/session-summary
 * using navigator.sendBeacon for reliability.
 *
 * @param patientId - Patient ID for the review session
 * @param taskId - Task ID for the review session
 *
 * @note Known limitation: navigator.sendBeacon does not include auth headers.
 * If the /session-summary endpoint requires authentication, the beacon POST
 * will be rejected. This is acceptable for development with optional auth;
 * in required-auth mode, telemetry may fail silently. Consider adding a
 * separate authenticated endpoint or pre-emptive POST before unload if
 * required-auth is enforced.
 */
export function useReviewerTelemetry(patientId: string | null, taskId: string | null) {
  const ref = useRef({
    session_id: crypto.randomUUID(),
    notes_opened: 0,
    total_dwell_ms: 0,
    searches_run: 0,
    ts_open: new Date().toISOString(),
  });

  // Register listeners for custom events
  useEffect(() => {
    function onNoteOpen() {
      ref.current.notes_opened += 1;
    }
    function onSearch() {
      ref.current.searches_run += 1;
    }
    function onDwell(e: Event) {
      const detail = (e as CustomEvent).detail as { deltaMs: number };
      ref.current.total_dwell_ms += detail.deltaMs;
    }

    window.addEventListener("chartreview:noteOpen", onNoteOpen);
    window.addEventListener("chartreview:search", onSearch);
    window.addEventListener("chartreview:dwell", onDwell);

    return () => {
      window.removeEventListener("chartreview:noteOpen", onNoteOpen);
      window.removeEventListener("chartreview:search", onSearch);
      window.removeEventListener("chartreview:dwell", onDwell);
    };
  }, []);

  // Set up beacon flush on page unload
  useEffect(() => {
    function flush() {
      if (!patientId || !taskId) return;

      const summary = {
        ...ref.current,
        ts_close: new Date().toISOString(),
      };

      navigator.sendBeacon(
        `/api/reviews/${patientId}/${taskId}/session-summary`,
        new Blob([JSON.stringify({ session_id: summary.session_id, summary })], {
          type: "application/json",
        })
      );
    }

    window.addEventListener("beforeunload", flush);
    // Only flush inside the beforeunload listener — not on cleanup.
    // Calling flush() during cleanup (e.g. when authReady flips) would cause
    // a double-fire: once on component unmount and again on actual page unload.
    return () => window.removeEventListener("beforeunload", flush);
  }, [patientId, taskId]);
}
