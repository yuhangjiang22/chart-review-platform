import fs from "fs";
import path from "path";
import { writeJsonAtomic } from "../lib/fs-atomic.js";
import {
  DerivedAdjudicationSchema,
  type DerivedAdjudication,
} from "./schema.js";

function storePath(pilotIterDir: string): string {
  return path.join(pilotIterDir, "derived-adjudications.json");
}

function readAll(fp: string): DerivedAdjudication[] {
  if (!fs.existsSync(fp)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(fp, "utf8"));
    if (!Array.isArray(raw)) return [];
    const out: DerivedAdjudication[] = [];
    for (const item of raw) {
      const parsed = DerivedAdjudicationSchema.safeParse(item);
      if (parsed.success) out.push(parsed.data);
    }
    return out;
  } catch {
    return [];
  }
}

export function listDerivedAdjudications(pilotIterDir: string): DerivedAdjudication[] {
  return readAll(storePath(pilotIterDir));
}

export function findDerivedAdjudicationsForPatient(
  pilotIterDir: string,
  patientId: string,
): DerivedAdjudication[] {
  return readAll(storePath(pilotIterDir)).filter((r) => r.patient_id === patientId);
}

export function writeDerivedAdjudication(
  pilotIterDir: string,
  record: DerivedAdjudication,
): void {
  // Validate before write so we never persist a malformed row.
  DerivedAdjudicationSchema.parse(record);
  fs.mkdirSync(pilotIterDir, { recursive: true });
  const fp = storePath(pilotIterDir);
  const existing = readAll(fp);
  const filtered = existing.filter(
    (r) => !(r.patient_id === record.patient_id && r.field_id === record.field_id),
  );
  filtered.push(record);
  writeJsonAtomic(fp, filtered);
}
