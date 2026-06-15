// qa-seed.ts — deterministic QA spot-check helpers (cluster 8 — U12)
//
// Extracted as a pure module so it can be unit-tested independently of
// React components.  DualAgentLayout imports from here.

/**
 * Deterministic integer hash of a patient_id string.
 * Uses a simple polynomial rolling hash (seed = sum of char codes * 31).
 * Same patient_id always produces the same hash across renders.
 */
export function hashPatientId(patientId: string): number {
  let seed = 0;
  for (let i = 0; i < patientId.length; i++) {
    seed = (seed * 31 + patientId.charCodeAt(i)) & 0xffffffff;
  }
  return Math.abs(seed);
}

/**
 * Returns true when this patient is a QA-sample patient.
 * Deterministic: patientIndex % 5 === 4  (0-indexed positions 4, 9, 14, …)
 *
 * Alternative seeded check: `parseInt(patientId, 16) % 5 === 0` for hex ids.
 * We use the ordering-based approach because the patient_id may not be hex.
 */
export function isQaPatient(patientIndex: number): boolean {
  return patientIndex % 5 === 4;
}

/**
 * Pick the QA-sample field for a given patient.
 *
 * - Returns null when patientIndex % 5 !== 4 (not a QA patient).
 * - Returns null when agreedFieldIds is empty.
 * - Otherwise selects deterministically by hashing patientId and taking
 *   hash % agreedFieldIds.length.
 *
 * The same (patientId, agreedFieldIds) pair always returns the same field,
 * making this safe to call multiple times per render.
 */
export function pickQAField(
  agreedFieldIds: string[],
  patientIndex: number,
  patientId: string,
): string | null {
  if (!isQaPatient(patientIndex)) return null;
  if (agreedFieldIds.length === 0) return null;
  const h = hashPatientId(patientId);
  return agreedFieldIds[h % agreedFieldIds.length];
}
