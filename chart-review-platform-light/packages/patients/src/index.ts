import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { NoteListing, PatientSummary } from "@chart-review/platform-types";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve PLATFORM_ROOT: env var wins, else walk up from this file
// looking for the v2 marker (.agents/skills/). Critical because this
// package lives at packages/patients/src/ — the original
// `__dirname/../..` heuristic resolved to v2 root only when the file
// was at server/lib/. Walk-up makes the resolution location-independent.
function findPlatformRoot(): string {
  if (process.env.CHART_REVIEW_PLATFORM_ROOT) return process.env.CHART_REVIEW_PLATFORM_ROOT;
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
    if (fs.existsSync(path.join(dir, ".agents", "skills"))) return dir;
  }
  // Fallback: process.cwd() — deployment owners should set the env var.
  return process.cwd();
}
export const PLATFORM_ROOT = findPlatformRoot();
export const CORPUS_ROOT =
  process.env.CHART_REVIEW_CORPUS_ROOT ?? path.join(PLATFORM_ROOT, "corpus");
// CHART_REVIEW_PATIENTS_ROOT lets a caller (e.g. the deploy runner) point note
// reading straight at a cohort dir laid out as <patient_id>/notes/*.txt, without
// the corpus/patients nesting. Unset → the default corpus location.
export const PATIENTS_ROOT =
  process.env.CHART_REVIEW_PATIENTS_ROOT ?? path.join(CORPUS_ROOT, "patients");

const FILENAME_DATE_RE = /^(\d{4}-\d{2}-\d{2})__([a-z0-9_]+)\.txt$/i;

interface IndexEntry {
  patient_id: string;
  category?: string;
  difficulty?: string;
  headline?: string;
}

interface CorpusMeta {
  patient_id: string;
  category?: string;
  demographics?: { age?: number; sex?: string; region?: string };
  smoking?: string;
  index_date?: string;
  doc_types?: string[];
  generated_by?: string;
  /** #46 — set to true on patients whose data must route through a
   *  HIPAA-eligible model. composeAgentOptions inspects this and swaps
   *  the model to CHART_REVIEW_PHI_MODEL (and the runtime is expected
   *  to be configured with a HIPAA-eligible base URL). */
  phi?: boolean;
}

/** #46 — surface the patient's PHI flag without exposing the rest of meta. */
export function isPhiPatient(patientId: string): boolean {
  try {
    return readMeta(patientId)?.phi === true;
  } catch {
    return false;
  }
}

function readIndex(): IndexEntry[] {
  const indexPath = path.join(CORPUS_ROOT, "index.json");
  if (!fs.existsSync(indexPath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
    return Array.isArray(parsed?.patients) ? parsed.patients : [];
  } catch {
    return [];
  }
}

function readMeta(patientId: string): CorpusMeta | null {
  const metaPath = path.join(PATIENTS_ROOT, patientId, "meta.json");
  if (!fs.existsSync(metaPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(metaPath, "utf-8"));
  } catch {
    return null;
  }
}

export function patientDir(patientId: string): string {
  const candidate = path.resolve(PATIENTS_ROOT, patientId);
  if (!candidate.startsWith(PATIENTS_ROOT + path.sep)) {
    throw new Error(`invalid patient_id: ${patientId}`);
  }
  if (!fs.existsSync(candidate)) {
    throw new Error(`unknown patient: ${patientId}`);
  }
  return candidate;
}

/**
 * Compose the platform's index.json + per-patient meta.json into the
 * UI-facing PatientSummary shape. The corpus is the source of truth;
 * we no longer have a synthetic patients/ folder under the app.
 */
export function listPatients(): PatientSummary[] {
  const index = readIndex();

  // Union of index.json + dir-scan so locally-added patient dirs (e.g.
  // gitignored patient_sample_*/) show up in the UI even if they're not
  // checked into index.json. Dir-scan extras render FIRST so methodologists
  // who just dropped a private import find it without scrolling past 20+
  // synthetic test patients; index.json order is preserved for the rest.
  const indexIds = index.map((e) => e.patient_id);
  const scanned = fs.existsSync(PATIENTS_ROOT)
    ? fs.readdirSync(PATIENTS_ROOT)
        .filter((d) => d.startsWith("patient_"))
        .sort()
    : [];
  const inIndex = new Set(indexIds);
  const extras = scanned.filter((id) => !inIndex.has(id));
  const ids = [...extras, ...indexIds];

  return ids.map((id): PatientSummary => {
    const idx = index.find((e) => e.patient_id === id);
    const meta = readMeta(id);
    return {
      patient_id: id,
      display_name: prettyId(id),
      age: meta?.demographics?.age,
      sex: meta?.demographics?.sex,
      index_date: meta?.index_date,
      headline: idx?.headline || categoryLabel(meta?.category, idx?.difficulty),
      category: idx?.category ?? meta?.category,
      difficulty: idx?.difficulty,
      phi: meta?.phi === true ? true : undefined, // #46
    };
  });
}

export function listNotes(patientId: string): NoteListing[] {
  const notesDir = path.join(patientDir(patientId), "notes");
  if (!fs.existsSync(notesDir)) return [];
  return fs
    .readdirSync(notesDir)
    .filter((f) => f.endsWith(".txt"))
    .sort()
    .map((filename) => {
      const m = filename.match(FILENAME_DATE_RE);
      return m
        ? { filename, date: m[1], doctype: m[2].replace(/_/g, " ") }
        : { filename };
    });
}

export function readNote(patientId: string, filename: string): string {
  if (
    !filename.endsWith(".txt") ||
    filename.includes("/") ||
    filename.includes("..")
  ) {
    throw new Error(`invalid note filename: ${filename}`);
  }
  return fs.readFileSync(
    path.join(patientDir(patientId), "notes", filename),
    "utf-8",
  );
}

const OMOP_TABLES = [
  "conditions",
  "procedures",
  "measurements",
  "drugs",
  "observations",
  "encounters",
] as const;

export type OmopTable = (typeof OMOP_TABLES)[number];

export interface StructuredResponse extends Record<OmopTable, unknown[]> {
  index_date?: string;
}

/**
 * OMOP-canonical column names vary by table (`condition_concept_name`,
 * `procedure_date`, `icd10_code`, …) but the UI's StructuredTab + TimelineTab
 * read simplified aliases (`concept_name`, `date`, `icd10cm`, …). This wraps
 * each row with the simplified aliases (preserving the originals) so both
 * naming conventions render correctly.
 */
function normalizeRow(table: OmopTable, raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const pick = (...keys: string[]): unknown => {
    for (const k of keys) if (r[k] != null) return r[k];
    return undefined;
  };
  const out: Record<string, unknown> = { ...r };
  const setIfMissing = (k: string, v: unknown) => {
    if (v != null && out[k] == null) out[k] = v;
  };
  setIfMissing(
    "concept_id",
    pick(
      "concept_id",
      "condition_concept_id",
      "procedure_concept_id",
      "measurement_concept_id",
      "drug_concept_id",
      "observation_concept_id",
      "visit_concept_id",
    ),
  );
  setIfMissing(
    "concept_name",
    pick(
      "concept_name",
      "condition_concept_name",
      "procedure_concept_name",
      "measurement_concept_name",
      "drug_concept_name",
      "observation_concept_name",
      "visit_concept_name",
    ),
  );
  setIfMissing(
    "date",
    pick(
      "date",
      "condition_start_date",
      "procedure_date",
      "measurement_date",
      "drug_exposure_start_date",
      "observation_date",
      "visit_start_date",
      "start_date",
    ),
  );
  setIfMissing("icd10cm", pick("icd10cm", "icd10_code"));
  setIfMissing("cpt", pick("cpt", "cpt_code"));
  setIfMissing("loinc", pick("loinc", "loinc_code"));
  setIfMissing("rxnorm", pick("rxnorm", "rxnorm_code"));
  if (table === "encounters") {
    setIfMissing("start_date", pick("start_date", "visit_start_date"));
    setIfMissing("end_date", pick("end_date", "visit_end_date"));
    setIfMissing("encounter_id", pick("encounter_id", "visit_occurrence_id"));
  }
  return out;
}

export function readStructured(patientId: string): StructuredResponse {
  const dir = path.join(patientDir(patientId), "omop");
  const tables = Object.fromEntries(OMOP_TABLES.map((t) => [t, [] as unknown[]])) as unknown as Record<OmopTable, unknown[]>;
  if (fs.existsSync(dir)) {
    for (const t of OMOP_TABLES) {
      const fp = path.join(dir, `${t}.json`);
      if (!fs.existsSync(fp)) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(fp, "utf-8"));
        if (Array.isArray(parsed)) tables[t] = parsed.map((row) => normalizeRow(t, row));
      } catch {
        // leave as []
      }
    }
  }
  const meta = readMeta(patientId);
  return {
    ...tables,
    index_date: meta?.index_date,
  };
}

function prettyId(id: string): string {
  // patient_easy_nsclc_01 → "easy nsclc 01"
  const trimmed = id.startsWith("patient_") ? id.slice("patient_".length) : id;
  return trimmed.replace(/_/g, " ");
}

function categoryLabel(category?: string, difficulty?: string): string {
  if (!category) return "";
  const tag = difficulty ? ` [${difficulty}]` : "";
  return `${category.replace(/_/g, " ")}${tag}`;
}
