// Minimal parameterized-route matcher for v2's Node http server.
//
// v2's original routes table keyed on exact strings ("POST /api/v2/clarify").
// As we port v1's surface (where most routes have :taskId / :iterId
// params), we need pattern matching. This helper is the smallest thing
// that does the job — no regex tricks, no Express-style middleware
// chain. Patterns look like Express: "GET /api/pilots/:taskId/:iterId".

import type { IncomingMessage } from "node:http";

export type RouteHandler = (
  body: unknown,
  req: IncomingMessage,
  params: Record<string, string>,
  query: URLSearchParams,
) => Promise<unknown>;

export interface RouteEntry {
  method: string;
  pattern: string;
  handler: RouteHandler;
}

interface CompiledRoute {
  method: string;
  pattern: string;
  segments: Array<{ literal: string } | { param: string }>; // each segment is one or the other
  handler: RouteHandler;
}

// Compile "GET /api/pilots/:taskId/:iterId" → segment list.
function compile(pattern: string): Array<{ literal: string } | { param: string }> {
  return pattern
    .replace(/^\/+/, "")
    .split("/")
    .map((s) => (s.startsWith(":") ? { param: s.slice(1) } : { literal: s }));
}

export function makeRouter(entries: RouteEntry[]) {
  const compiled: CompiledRoute[] = entries.map((e) => ({
    method: e.method,
    pattern: e.pattern,
    segments: compile(e.pattern) as any,
    handler: e.handler,
  }));

  return {
    match(method: string, url: string): { handler: RouteHandler; params: Record<string, string>; query: URLSearchParams } | null {
      const parsed = new URL(url, "http://x");
      const pathSegs = parsed.pathname.replace(/^\/+/, "").split("/");
      for (const route of compiled) {
        if (route.method !== method) continue;
        const segs = route.segments as ({ literal: string } | { param: string })[];
        if (segs.length !== pathSegs.length) continue;
        const params: Record<string, string> = {};
        let ok = true;
        for (let i = 0; i < segs.length; i++) {
          const seg = segs[i];
          if ("literal" in seg) {
            if (seg.literal !== pathSegs[i]) { ok = false; break; }
          } else {
            params[seg.param] = decodeURIComponent(pathSegs[i]);
          }
        }
        if (ok) return { handler: route.handler, params, query: parsed.searchParams };
      }
      return null;
    },
    list(): { method: string; pattern: string }[] {
      return compiled.map((c) => ({ method: c.method, pattern: c.pattern }));
    },
  };
}
