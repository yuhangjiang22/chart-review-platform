// useHashRoute — URL-as-source-of-truth for app navigation.
//
// Parses window.location.hash into a typed shape; subscribes to hashchange
// + popstate so back/forward and direct URL edits both propagate. The
// `navigate` callback uses history.pushState and updates state synchronously
// (pushState alone does not fire hashchange).
//
// Empty or unknown hashes are coerced to `#/tasks` via replaceState so the
// app always lands in a valid route.

import { useCallback, useEffect, useState } from "react";

export type RoutePage =
  | "tasks"
  | "studio"
  | "queue"
  | "patient"
  | "builder"
  | "audit"
  | "help";

export interface ParsedRoute {
  page: RoutePage;
  taskId?: string;
  subTab?: string;
  patientId?: string;
  /** Active criterion when route.page === "patient", encoded as the 4th
   *  hash segment so URLs are shareable per-criterion. */
  criterionId?: string;
}

const VALID_PAGES: ReadonlyArray<RoutePage> = [
  "tasks",
  "studio",
  "queue",
  "patient",
  "builder",
  "audit",
  "help",
];

function parseHash(hash: string): ParsedRoute | null {
  const trimmed = hash.replace(/^#\/?/, "");
  if (!trimmed) return null;
  const segs = trimmed.split("/").filter(Boolean).map(decodeURIComponent);
  const page = segs[0] as RoutePage;
  if (!VALID_PAGES.includes(page)) return null;
  switch (page) {
    case "studio":
      if (!segs[1]) return null;
      return { page, taskId: segs[1], subTab: segs[2] };
    case "patient":
      if (!segs[1] || !segs[2]) return null;
      return { page, taskId: segs[1], patientId: segs[2], criterionId: segs[3] };
    case "queue":
    case "builder":
      if (!segs[1]) return null;
      return { page, taskId: segs[1] };
    case "tasks":
    case "audit":
    case "help":
      return { page };
  }
}

function readRoute(): ParsedRoute {
  const parsed = parseHash(window.location.hash);
  if (!parsed) {
    window.history.replaceState(null, "", "#/tasks");
    return { page: "tasks" };
  }
  return parsed;
}

export interface UseHashRouteResult {
  route: ParsedRoute;
  navigate: (hash: string, opts?: { replace?: boolean }) => void;
}

export function useHashRoute(): UseHashRouteResult {
  const [route, setRoute] = useState<ParsedRoute>(() => readRoute());

  useEffect(() => {
    function onChange() {
      setRoute(readRoute());
    }
    window.addEventListener("hashchange", onChange);
    window.addEventListener("popstate", onChange);
    return () => {
      window.removeEventListener("hashchange", onChange);
      window.removeEventListener("popstate", onChange);
    };
  }, []);

  const navigate = useCallback((hash: string, opts?: { replace?: boolean }) => {
    const target = hash.startsWith("#") ? hash : `#${hash}`;
    if (window.location.hash === target) return;
    if (opts?.replace) {
      window.history.replaceState(null, "", target);
    } else {
      window.history.pushState(null, "", target);
    }
    setRoute(readRoute());
  }, []);

  return { route, navigate };
}

// Build a hash for a Studio sub-tab. Centralised so call sites stay readable.
export function studioHash(taskId: string, subTab?: string): string {
  return subTab && subTab !== "guideline"
    ? `#/studio/${encodeURIComponent(taskId)}/${encodeURIComponent(subTab)}`
    : `#/studio/${encodeURIComponent(taskId)}`;
}

export function patientHash(taskId: string, patientId: string, criterionId?: string): string {
  const base = `#/patient/${encodeURIComponent(taskId)}/${encodeURIComponent(patientId)}`;
  return criterionId ? `${base}/${encodeURIComponent(criterionId)}` : base;
}

export function queueHash(taskId: string): string {
  return `#/queue/${encodeURIComponent(taskId)}`;
}

export function builderHash(taskId: string): string {
  return `#/builder/${encodeURIComponent(taskId)}`;
}
