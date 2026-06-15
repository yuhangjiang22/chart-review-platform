// sse.ts — minimal Server-Sent-Events-over-fetch parser.
//
// EventSource only supports GET; we want POST with a JSON body, so we read
// the streaming response with fetch+ReadableStream and split on the SSE
// `\n\n` event boundary. Each event is `data: <json>\n\n` per the
// review-copilot endpoints.
//
// Used by OverrideForm (suggest-override-reason/stream) and WorkflowBar's
// pre-lock modal (prelock-summary/stream) so tool-use pills land live while
// the copilot is working.

import { authFetch } from "./auth";

export interface SseStreamOptions<T> {
  onEvent: (event: T) => void;
  signal?: AbortSignal;
}

/** POST to `url` with `body`, parse the SSE response, invoke `onEvent` for
 *  each `data:` frame. Resolves when the stream ends. */
export async function postSseJson<T>(
  url: string,
  body: unknown,
  opts: SseStreamOptions<T>,
): Promise<void> {
  const res = await authFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`SSE request failed: ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // SSE event boundary is a blank line. We may receive partial frames.
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      // Each frame is one or more `field: value` lines. We only care about
      // `data:` frames here.
      const dataLines: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).replace(/^ /, ""));
        }
      }
      if (dataLines.length === 0) continue;
      try {
        const parsed = JSON.parse(dataLines.join("\n")) as T;
        opts.onEvent(parsed);
      } catch {
        // Malformed frame — skip silently. The copilot endpoints only emit
        // valid JSON, so this is a transport-level corruption case.
      }
    }
  }
}
