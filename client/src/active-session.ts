// Module-level holder of the workspace's active session id, so scattered
// fetch() callers can scope review-state requests without prop-threading.
let current: string | null = null;
export function setActiveSessionGlobal(sid: string | null): void { current = sid; }
export function getActiveSession(): string | null { return current; }
/** Append ?session_id= to a URL (respecting an existing query string).
 *  No-op when there is no active session (the server then 400s or, for
 *  endpoints that only need it conditionally, ignores it). */
export function withSession(url: string, sid: string | null = current): string {
  if (!sid) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}session_id=${encodeURIComponent(sid)}`;
}
