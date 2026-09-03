// The value-level rules a return package is built from, separated from the CLI
// so they can be tested against hostile input rather than trusted because one
// run of the script looked clean.
//
// The guarantee is a WHITELIST: a value leaves the site only by matching a shape
// declared here. Everything else becomes a marker and is counted. That is the
// opposite of a redaction pass, which has to anticipate what to remove and fails
// silently the day an upstream field it never heard of appears.

import {
  ENGINE_UNANSWERED_REASON, ENGINE_PERIOD_UNANSWERED_REASON, ENGINE_NOT_EVALUABLE_REASON,
} from "@chart-review/rule-engine";

export const DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/;

/** Longest cell the exit check tolerates. Every legitimate value is an id, an
 *  enum member, a number or a short code; prose is what a patient detail rides
 *  in on, and prose is longer than this. */
export const MAX_CELL_CHARS = 64;

/** Calendar dates become INTERVALS. Analysis wants the spacing between events,
 *  and an offset from an anchor that is never published is not an identifier —
 *  where the calendar date is one under HIPAA safe harbour. */
export function daysBefore(indexDate: string | undefined, date: string | undefined): string {
  if (!indexDate || !date) return "";
  const a = Date.parse(`${indexDate.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${date.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return "";
  return String(Math.round((a - b) / 86_400_000));
}

/** Stored not-evaluable reasons are prose, and a reviewer may author their own.
 *  Only the ENGINE's own strings map to a code; anything else becomes
 *  `reviewer_authored` and its text is dropped — a human sentence explaining why
 *  a patient could not be judged is exactly where a patient detail ends up. */
export function reasonCode(
  censoredReason: string | undefined, reason: string | undefined,
): string {
  if (!reason) return "";
  if (reason === ENGINE_NOT_EVALUABLE_REASON) return "not_applicable";
  if (reason === ENGINE_UNANSWERED_REASON) return "unanswered_event";
  if (reason.startsWith(ENGINE_PERIOD_UNANSWERED_REASON)) return "unanswered_question";
  if (censoredReason && reason === censoredReason) return "censored";
  return "reviewer_authored";
}

/** An answer may leave as: a boolean, a finite number, a value the question's own
 *  enum declares, or a date rewritten as an interval. Anything else — free text,
 *  an unrecognised string, a structure — becomes a marker and is reported. */
export function safeAnswer(
  value: unknown,
  enums: Set<string> | undefined,
  indexDate: string | undefined,
  onDrop: (why: string) => void,
): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value !== "string") { onDrop("non-scalar"); return "[dropped]"; }
  if (enums?.has(value)) return value;
  if (DATE_RE.test(value)) {
    const d = daysBefore(indexDate, value);
    return d === "" ? "[dropped:date]" : `days_before_index=${d}`;
  }
  if (/^-?\d+(\.\d+)?$/.test(value)) return value;
  onDrop(`unlisted value for a string answer (${value.length} chars)`);
  return "[dropped:unlisted]";
}

export interface LeakFinding { file: string; line: number; why: string }

/** The alarm on the whitelist, run over the BYTES about to be written rather
 *  than the objects they came from — so a bug in the whitelist itself, or a
 *  column added without thinking, is caught before the file exists. */
export function scanForLeaks(files: Record<string, string>): LeakFinding[] {
  const findings: LeakFinding[] = [];
  for (const [file, body] of Object.entries(files)) {
    if (!file.endsWith(".csv")) continue;
    body.split("\n").forEach((line, i) => {
      if (DATE_RE.test(line)) findings.push({ file, line: i + 1, why: "date-shaped value" });
      for (const cell of line.split(",")) {
        if (cell.length > MAX_CELL_CHARS) {
          findings.push({ file, line: i + 1, why: `cell of ${cell.length} chars` });
        }
      }
    });
  }
  return findings;
}
