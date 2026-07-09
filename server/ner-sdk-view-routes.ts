// Read-only views for the bso-ad-ner-sdk TRY page: the vendored SKILL.md
// (agent instructions) and the per-note agent-trace event logs.
import fs from "node:fs";
import path from "node:path";
import type { RouteEntry } from "./router.js";
import { PLATFORM_ROOT } from "@chart-review/patients";

const VENDOR = path.join(PLATFORM_ROOT, "vendor", "bso-ad-sdk");
const SKILL_MD = path.join(VENDOR, ".claude", "skills", "bso-ad", "SKILL.md");

function httpErr(s: number, m: string): Error & { status: number } { const e = new Error(m) as Error & { status: number }; e.status = s; return e; }
function safeId(v: unknown): string { if (typeof v !== "string" || !/^[A-Za-z0-9_-]+$/.test(v)) throw httpErr(400, "invalid id"); return v; }

/** Drop a leading YAML frontmatter block (--- … ---) if present. */
function stripFrontmatter(md: string): string {
  if (md.startsWith("---")) {
    const end = md.indexOf("\n---", 3);
    if (end !== -1) {
      const after = md.indexOf("\n", end + 1);
      return after !== -1 ? md.slice(after + 1) : "";
    }
  }
  return md;
}

export const nerSdkViewRoutes: RouteEntry[] = [
  {
    method: "GET",
    pattern: "/api/ner-sdk/skill",
    handler: async () => {
      if (!fs.existsSync(SKILL_MD)) throw httpErr(404, `SKILL.md not found at ${SKILL_MD}`);
      return { markdown: stripFrontmatter(fs.readFileSync(SKILL_MD, "utf-8")) };
    },
  },
  {
    method: "GET",
    pattern: "/api/ner-sdk/events",
    handler: async (_b, _r, _p, query) => {
      const sessionId = safeId(query.get("session_id"));
      const dir = path.join(PLATFORM_ROOT, "var", "benchmark-sdk", sessionId);
      const noteParam = query.get("note_id");
      if (!noteParam) {
        if (!fs.existsSync(dir)) return { notes: [] };
        const notes = fs.readdirSync(dir)
          .filter((f) => f.endsWith("_events.jsonl"))
          .map((f) => f.replace(/_events\.jsonl$/, ""))
          .sort();
        return { notes };
      }
      const noteId = safeId(noteParam);
      const fp = path.join(dir, `${noteId}_events.jsonl`);
      if (!fs.existsSync(fp)) return { events: [] };
      const events: unknown[] = [];
      for (const line of fs.readFileSync(fp, "utf-8").split("\n")) {
        const t = line.trim(); if (!t) continue;
        try { events.push(JSON.parse(t)); } catch { /* skip malformed */ }
      }
      return { events };
    },
  },
];
