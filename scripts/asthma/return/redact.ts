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
/** THE PER-COLUMN CHECK. What each column is allowed to contain, by name.
 *
 *  This file's header promises a whitelist — "a value leaves the site only by
 *  matching a shape declared here" — and for one version only two of the 40
 *  column slots kept that promise: `answer` (safeAnswer) and `reason_code`
 *  (reasonCode). The rest were `String(v)` pass-throughs, defended by an
 *  argument rather than a check: a rule_id comes from the rubric, a count is
 *  computed, a subject_id is generated, so none of them CAN carry chart text.
 *  The argument is even mostly right. It is still an argument, and the point of
 *  a whitelist is not needing one — the rubric is a file on disk, the anchor
 *  type is whatever a site's ETL emitted, and `source` is read back out of
 *  stored state.
 *
 *  A value failing its column's shape becomes a marker and is counted, exactly
 *  like a failing answer. Unknown column names are REJECTED rather than passed:
 *  a new column must declare what it may hold before it can ship. */
export type ColumnShape =
  | { kind: "enum"; values: readonly string[] }
  | { kind: "int"; min?: number; max?: number }
  | { kind: "number" }
  | { kind: "id" }          // rubric/ETL identifier: [A-Za-z0-9_.:#-], bounded
  | { kind: "subject" }     // S0001
  | { kind: "bool" }
  | { kind: "checked" };    // already passed safeAnswer / reasonCode upstream

const VERDICTS = ["CONCORDANT", "NON_CONCORDANT", "EXCLUDED", ""] as const;
const SOURCES = ["agent", "reviewer", "derived", ""] as const;
const ATTRIBUTIONS = [
  "DOCUMENTATION_GAP", "GUIDELINE_DEVIATION", "PATIENT_FACTOR", "SYSTEM_FACTOR", "",
] as const;

export const COLUMN_SHAPES: Record<string, ColumnShape> = {
  subject_id: { kind: "subject" },
  rule_id: { kind: "id" },
  question_id: { kind: "id" },
  anchor_type: { kind: "id" },
  event_seq: { kind: "id" },
  verdict: { kind: "enum", values: VERDICTS },
  period_verdict: { kind: "enum", values: VERDICTS },
  attribution: { kind: "enum", values: ATTRIBUTIONS },
  source: { kind: "enum", values: SOURCES },
  evaluable: { kind: "bool" },
  tier: { kind: "int", min: 0, max: 9 },
  days_before_index: { kind: "int" },
  n_events: { kind: "int", min: 0 },
  n_evaluable: { kind: "int", min: 0 },
  n_concordant: { kind: "int", min: 0 },
  n_non_concordant: { kind: "int", min: 0 },
  n_excluded: { kind: "int", min: 0 },
  n_subjects: { kind: "int", min: 0 },
  n_evaluable_subjects: { kind: "int", min: 0 },
  attr_DOCUMENTATION_GAP: { kind: "int", min: 0 },
  attr_GUIDELINE_DEVIATION: { kind: "int", min: 0 },
  attr_PATIENT_FACTOR: { kind: "int", min: 0 },
  attr_SYSTEM_FACTOR: { kind: "int", min: 0 },
  attr_unattributed: { kind: "int", min: 0 },
  rate: { kind: "number" },
  answer: { kind: "checked" },
  reason_code: { kind: "checked" },
};

const ID_RE = /^[A-Za-z0-9_.:#@-]{1,64}$/;
const SUBJECT_RE = /^S\d{4,6}$/;

/** The value to emit for `column`, or the marker when it does not match.
 *  Returns `[value, ok]` so the caller can count rejections. */
export function safeColumn(column: string, raw: unknown): [string, boolean] {
  const shape = COLUMN_SHAPES[column];
  const s = raw === undefined || raw === null ? "" : String(raw);
  if (!shape) return ["(UNDECLARED_COLUMN)", false];
  if (s === "") {
    // Empty is allowed wherever the shape's enum lists it, and for any numeric
    // or checked column (a null rate, an unanswered question).
    const enumAllows = shape.kind === "enum" && shape.values.includes("");
    return ["", enumAllows || shape.kind !== "enum"];
  }
  switch (shape.kind) {
    case "enum":
      return shape.values.includes(s) ? [s, true] : ["(OFF_ENUM)", false];
    case "int": {
      if (!/^-?\d+$/.test(s)) return ["(NOT_AN_INT)", false];
      const n = Number(s);
      if (shape.min !== undefined && n < shape.min) return ["(OUT_OF_RANGE)", false];
      if (shape.max !== undefined && n > shape.max) return ["(OUT_OF_RANGE)", false];
      return [s, true];
    }
    case "number":
      return /^-?\d+(\.\d+)?$/.test(s) ? [s, true] : ["(NOT_A_NUMBER)", false];
    case "bool":
      return s === "true" || s === "false" ? [s, true] : ["(NOT_A_BOOL)", false];
    case "subject":
      return SUBJECT_RE.test(s) ? [s, true] : ["(BAD_SUBJECT_ID)", false];
    case "id":
      return ID_RE.test(s) ? [s, true] : ["(BAD_ID)", false];
    case "checked":
      // safeAnswer / reasonCode already decided; only the length bound is left,
      // so a checked value cannot become the one long cell nobody measured.
      return s.length <= MAX_CELL_CHARS ? [s, true] : ["(TOO_LONG)", false];
  }
}

/** Split one CSV line into cells, honouring RFC4180 quoting.
 *
 *  `line.split(",")` was the bug: `csv()` quotes any value containing a comma or
 *  a newline, so a long quoted cell was split at its own commas and every piece
 *  measured under the limit. MAX_CELL_CHARS therefore only ever bounded prose
 *  with no commas in it — and prose with no commas is the unusual kind. */
export function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
      } else { cur += c; }
    } else if (c === '"') { inQuotes = true; }
    else if (c === ",") { cells.push(cur); cur = ""; }
    else { cur += c; }
  }
  cells.push(cur);
  return cells;
}

export function scanForLeaks(files: Record<string, string>): LeakFinding[] {
  const findings: LeakFinding[] = [];
  for (const [file, body] of Object.entries(files)) {
    if (!file.endsWith(".csv")) continue;
    // A quoted cell may span lines, so measure over the parsed record rather
    // than the raw line. Records are re-joined on the newline they were split at.
    let buf = "";
    let lineNo = 0;
    body.split("\n").forEach((raw, i) => {
      buf = buf ? `${buf}\n${raw}` : raw;
      if (!buf) return;
      // An odd number of quote characters means the record continues.
      if ((buf.match(/"/g)?.length ?? 0) % 2 === 1) { lineNo = lineNo || i + 1; return; }
      const at = lineNo || i + 1;
      if (DATE_RE.test(buf)) findings.push({ file, line: at, why: "date-shaped value" });
      for (const cell of splitCsvLine(buf)) {
        if (cell.length > MAX_CELL_CHARS) {
          findings.push({ file, line: at, why: `cell of ${cell.length} chars` });
        }
        if (cell.includes("\n")) {
          findings.push({ file, line: at, why: "cell contains a newline" });
        }
      }
      buf = "";
      lineNo = 0;
    });
    if (buf) findings.push({ file, line: lineNo || 0, why: "unterminated quoted cell" });
  }
  return findings;
}
