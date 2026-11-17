import { readNote } from "@chart-review/patients";

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

  // Both match paths are case-insensitive: the LLM often re-types a quote
  // with different capitalization (TitleCase section headers vs an all-caps
  // chart, "MoCA" vs "moca"), and a strict case-sensitive match stalls the
  // agent in a set→find→loop retry storm. The returned `verbatim_quote` is
  // always the ORIGINAL text at the matched offsets, so downstream faithfulness
  // checks still see what the chart actually said.
  const textLc = text.toLowerCase();
  const snippetLc = snippet.toLowerCase();

  // Path 1: exact substring (case-insensitive).
  const exactStart = textLc.indexOf(snippetLc);
  if (exactStart >= 0) {
    return {
      ok: true,
      note_id: filename.replace(/\.txt$/, ""),
      span_offsets: [exactStart, exactStart + snippet.length],
      verbatim_quote: text.slice(exactStart, exactStart + snippet.length),
      match: "exact",
    };
  }

  // Path 2: whitespace-tolerant (case-insensitive).
  const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
  const target = normalize(snippetLc);
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
    if (/\s/.test(textLc[start])) continue;
    if (textLc[start] !== seedNoWs[0]) continue;
    let i = start;
    let j = 0;
    let lastWasSpace = false;
    while (i < text.length && j < target.length) {
      const ti = textLc[i];
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
