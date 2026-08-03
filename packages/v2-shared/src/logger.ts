// Append-only audit logger.
//
// Both chart-review and lit-extract need RLHF-grade training data:
// every state change a labeled row in JSONL. This is that shared writer.
// Module 6 (correct-log) calls into this; module 4 (extract) calls into
// this; the LLM judge in module 5 calls into this.
//
// Design constraints:
//   - Append-only. Never rewrite history; corrections are new entries.
//   - One line per entry; each line is a valid JSON object.
//   - File-locking is process-local (single-writer). Multi-process
//     writers should funnel through one logger instance.

import fs from "node:fs";
import path from "node:path";
import type { AuditEntry } from "./types.js";

export interface Logger {
  append(entry: AuditEntry): Promise<void>;
  read(): Promise<AuditEntry[]>;
}

export function makeJsonlLogger(filePath: string): Logger {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  return {
    async append(entry: AuditEntry): Promise<void> {
      const line = JSON.stringify(entry) + "\n";
      await fs.promises.appendFile(filePath, line, "utf8");
    },
    async read(): Promise<AuditEntry[]> {
      if (!fs.existsSync(filePath)) return [];
      const text = await fs.promises.readFile(filePath, "utf8");
      return text
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as AuditEntry);
    },
  };
}
