// packages/deploy-runner/src/enumerate-patients.ts
import fs from "node:fs";
import path from "node:path";

/** Patient ids in a cohort dir: subfolders whose notes/ holds ≥1 .txt file.
 *  Sorted for stable output. Throws if the dir doesn't exist. */
export function enumeratePatients(dataDir: string): string[] {
  if (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory()) {
    throw new Error(`--data-dir does not exist or is not a directory: ${dataDir}`);
  }
  const out: string[] = [];
  for (const name of fs.readdirSync(dataDir)) {
    const notesDir = path.join(dataDir, name, "notes");
    if (!fs.existsSync(notesDir) || !fs.statSync(notesDir).isDirectory()) continue;
    const hasTxt = fs.readdirSync(notesDir).some((f) => f.endsWith(".txt"));
    if (hasTxt) out.push(name);
  }
  return out.sort();
}
