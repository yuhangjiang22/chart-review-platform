// app/server/sampling.ts
import fs from "fs";
import path from "path";

export interface SamplingInput {
  taskId: string;
  reviewsRoot: string;
  patientCorpusRoot: string;
  sampleSize: number;
  stratifyBy: string[];
  seed?: number;
}

export interface StratumGroup {
  key: Record<string, unknown>;
  patient_ids: string[];
}

export interface SamplingResult {
  total_eligible: number;
  strata: StratumGroup[];
  sampled: string[];
  skipped: Array<{ patient_id: string; reason: string }>;
}

// Mulberry32 seeded PRNG
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: T[], rand: () => number): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function stratifiedSample(input: SamplingInput): SamplingResult {
  const { patientCorpusRoot, sampleSize, stratifyBy, seed = 0 } = input;
  if (!fs.existsSync(patientCorpusRoot)) {
    return { total_eligible: 0, strata: [], sampled: [], skipped: [] };
  }

  const eligible: Array<{ pid: string; key: Record<string, unknown> }> = [];
  const skipped: Array<{ patient_id: string; reason: string }> = [];

  for (const pid of fs.readdirSync(patientCorpusRoot)) {
    if (pid.startsWith("_") || pid.startsWith(".")) continue;
    const sf = path.join(patientCorpusRoot, pid, "structured.json");
    if (!fs.existsSync(sf)) {
      skipped.push({ patient_id: pid, reason: "no_structured_json" });
      continue;
    }
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(fs.readFileSync(sf, "utf8")) as Record<string, unknown>;
    } catch {
      skipped.push({ patient_id: pid, reason: "malformed_structured_json" });
      continue;
    }
    const key: Record<string, unknown> = {};
    let missing = false;
    for (const k of stratifyBy) {
      if (!(k in data)) { missing = true; break; }
      key[k] = data[k];
    }
    if (missing) {
      skipped.push({ patient_id: pid, reason: "missing_key" });
      continue;
    }
    eligible.push({ pid, key });
  }

  // Group by stratum
  const groups = new Map<string, StratumGroup>();
  for (const e of eligible) {
    const k = JSON.stringify(e.key);
    if (!groups.has(k)) groups.set(k, { key: e.key, patient_ids: [] });
    groups.get(k)!.patient_ids.push(e.pid);
  }
  const strata = [...groups.values()];

  if (eligible.length === 0) {
    return { total_eligible: 0, strata, sampled: [], skipped };
  }

  // Compute per-stratum sample size
  const total = eligible.length;
  const rand = makeRng(seed);
  const sampled: string[] = [];
  for (const s of strata) {
    const proportion = s.patient_ids.length / total;
    const n = Math.min(s.patient_ids.length, Math.max(1, Math.round(sampleSize * proportion)));
    const shuffled = shuffle(s.patient_ids, rand);
    sampled.push(...shuffled.slice(0, n));
  }

  return { total_eligible: total, strata, sampled, skipped };
}
