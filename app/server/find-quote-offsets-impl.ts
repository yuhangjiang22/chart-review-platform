import { readNote } from "./patients.js";

export type FindQuoteOffsetsOk = {
  ok: true;
  note_id: string;
  span_offsets: [number, number];
  verbatim_quote: string;
  match: "exact" | "whitespace_tolerant";
};

export type FindQuoteOffsetsError = {
  ok: false;
  error_code: "note_not_found" | "snippet_not_found" | "empty_snippet";
  message: string;
};

export type FindQuoteOffsetsResult = FindQuoteOffsetsOk | FindQuoteOffsetsError;

export function findQuoteOffsetsImpl(
  patientId: string,
  noteIdInput: string,
  snippet: string,
): FindQuoteOffsetsResult {
  const filename = noteIdInput.endsWith(".txt") ? noteIdInput : `${noteIdInput}.txt`;
  let text: string;
  try {
    text = readNote(patientId, filename);
  } catch (e) {
    return {
      ok: false,
      error_code: "note_not_found",
      message: (e as Error).message,
    };
  }

  // Path 1: exact substring.
  const exactStart = text.indexOf(snippet);
  if (exactStart >= 0) {
    return {
      ok: true,
      note_id: filename.replace(/\.txt$/, ""),
      span_offsets: [exactStart, exactStart + snippet.length],
      verbatim_quote: snippet,
      match: "exact",
    };
  }

  // Path 2: whitespace-tolerant.
  const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
  const target = normalize(snippet);
  if (target.length === 0) {
    return {
      ok: false,
      error_code: "empty_snippet",
      message: "snippet is empty after whitespace collapse",
    };
  }
  const seedNoWs = target.slice(0, Math.min(30, target.length)).replace(/ /g, "");
  const MAX_SCAN = Math.min(text.length, 200_000);
  for (let start = 0; start < MAX_SCAN; start++) {
    if (/\s/.test(text[start])) continue;
    if (text[start] !== seedNoWs[0]) continue;
    let i = start;
    let j = 0;
    let lastWasSpace = false;
    while (i < text.length && j < target.length) {
      const ti = text[i];
      const tj = target[j];
      if (/\s/.test(ti)) {
        if (!lastWasSpace) {
          if (tj === " ") {
            j++;
          } else {
            break;
          }
          lastWasSpace = true;
        }
        i++;
        continue;
      }
      lastWasSpace = false;
      if (ti !== tj) break;
      i++;
      j++;
    }
    if (j === target.length) {
      return {
        ok: true,
        note_id: filename.replace(/\.txt$/, ""),
        span_offsets: [start, i],
        verbatim_quote: text.slice(start, i),
        match: "whitespace_tolerant",
      };
    }
  }

  return {
    ok: false,
    error_code: "snippet_not_found",
    message:
      "no exact or whitespace-tolerant match. Re-Read the note and copy a contiguous passage verbatim; do not paraphrase.",
  };
}
