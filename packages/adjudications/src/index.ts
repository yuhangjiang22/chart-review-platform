// app/server/adjudications.ts
import fs from "fs";
import path from "path";
import { writeJsonAtomic } from "@chart-review/fs-atomic";

export type AdjudicationClassification =
  | "guideline_gap"
  | "agent_a_error"
  | "agent_b_error"
  | "true_clinical_ambiguity";

export interface Adjudication {
  patient_id: string;
  field_id: string;
  pair: { agent_a: string; agent_b: string };
  classification: AdjudicationClassification;
  /** Required when classification is "guideline_gap". */
  suggested_revision?: string;
  reviewer: string;
  timestamp: string;
  notes?: string;
}

function adjudicationsPath(pilotIterDir: string): string {
  return path.join(pilotIterDir, "adjudications.json");
}

function listFromFile(fp: string): Adjudication[] {
  if (!fs.existsSync(fp)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(fp, "utf8"));
    return Array.isArray(raw) ? raw : Array.isArray(raw.adjudications) ? raw.adjudications : [];
  } catch {
    return [];
  }
}

export function listAdjudications(pilotIterDir: string): Adjudication[] {
  return listFromFile(adjudicationsPath(pilotIterDir));
}

export function writeAdjudication(pilotIterDir: string, adj: Adjudication): void {
  if (adj.classification === "guideline_gap" && !adj.suggested_revision?.trim()) {
    throw new Error("suggested_revision required when classification is guideline_gap");
  }
  fs.mkdirSync(pilotIterDir, { recursive: true });
  const fp = adjudicationsPath(pilotIterDir);
  const existing = listFromFile(fp);
  // Replace any existing adjudication for the same (patient, field, pair).
  const filtered = existing.filter(
    (e) => !(e.patient_id === adj.patient_id && e.field_id === adj.field_id && e.pair.agent_a === adj.pair.agent_a && e.pair.agent_b === adj.pair.agent_b),
  );
  filtered.push(adj);
  writeJsonAtomic(fp, filtered);
}

export interface SplitResult {
  guideline_gaps: Adjudication[];
  agent_errors: Adjudication[];
  clinical_ambiguities: Adjudication[];
}

export function splitByClassification(adjs: Adjudication[]): SplitResult {
  const out: SplitResult = { guideline_gaps: [], agent_errors: [], clinical_ambiguities: [] };
  for (const a of adjs) {
    if (a.classification === "guideline_gap") out.guideline_gaps.push(a);
    else if (a.classification === "agent_a_error" || a.classification === "agent_b_error") out.agent_errors.push(a);
    else if (a.classification === "true_clinical_ambiguity") out.clinical_ambiguities.push(a);
  }
  return out;
}

export function writeAgentErrors(pilotIterDir: string, adjs: Adjudication[]): void {
  const fp = path.join(pilotIterDir, "agent_errors.json");
  fs.mkdirSync(pilotIterDir, { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(adjs, null, 2));
}

export function writeUnresolved(pilotIterDir: string, items: Array<{ patient_id: string; field_id: string; pair: { agent_a: string; agent_b: string } }>): void {
  const fp = path.join(pilotIterDir, "unresolved.json");
  fs.mkdirSync(pilotIterDir, { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(items, null, 2));
}
