/**
 * Step 2 (Post-Processing Classification) of the ACTS Vaccine Extraction
 * Guideline: assign each extracted vaccine NAME a category AND its disease/target
 * using ONLY the CDC reference table (+ the Alzforum amyloid/tau table) — never
 * from model memory.
 *
 * Priority per the guideline: brand name → abbreviation → disease/target.
 * Brand wins (the same disease can have both live and non-live products, e.g.
 * Zostavax=Live vs Shingrix=Non-Live). A disease-only mention whose products
 * span more than one category resolves to "Ambiguous" (do not guess) — but the
 * disease itself is still reported. BCG is its own category. Amyloid/tau active
 * immunizations match by name only and are for Alzheimer's disease.
 */

export type VaccineCategory =
  | "Live Vaccine"
  | "Non-Live Vaccine"
  | "BCG"
  | "Active Amyloid or Tau Immunization"
  | "Ambiguous";

/** One CDC table row: its disease/target label (verbatim from the table) and category. */
interface VaxRow {
  disease: string;
  category: VaccineCategory;
}

export interface VaccineClassification {
  category: VaccineCategory;
  /** The disease/target the vaccine is for, from the table (e.g. "Influenza",
   *  "Herpes Zoster (shingles), recombinant", "Alzheimer's disease"); null when
   *  no table row matched. */
  disease: string | null;
}

export interface VaccineCatalog {
  /** normalized brand phrase → row; matched longest-first */
  brands: Array<{ key: string; row: VaxRow }>;
  /** normalized abbreviation token → row */
  abbrevs: Map<string, VaxRow>;
  /** normalized disease keyword → rows whose disease cell contains it (longest-first) */
  diseaseKeys: Array<{ key: string; rows: VaxRow[] }>;
  /** normalized amyloid/tau therapy name or alias (category/disease are fixed) */
  amyloid: Set<string>;
}

const CATS: VaccineCategory[] = ["Live Vaccine", "Non-Live Vaccine", "BCG", "Active Amyloid or Tau Immunization"];

/** Platform / qualifier words that appear in a table Disease cell but are NOT
 *  disease names — excluded when indexing disease-name tokens so they don't
 *  become spurious match keys. */
const DISEASE_TOKEN_STOPLIST = new Set([
  "acellular", "conjugate", "polysaccharide", "recombinant", "inactivated",
  "attenuated", "subunit", "adjuvanted", "valent", "toxoid", "live",
  "vaccine", "vaccines", "combo", "based", "culture", "syncytial",
  "virus", "human", "type", "types", "prefusion", "replicating",
  "military", "intranasal",
]);

/** lowercase, drop punctuation to spaces, collapse whitespace */
export function normVax(s: string): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function stripParen(s: string): string {
  return s.replace(/\([^)]*\)/g, " ");
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

function tableRows(md: string): string[][] {
  const rows: string[][] = [];
  for (const line of md.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("|")) continue;
    if (/^\|[\s|:-]+\|?$/.test(t)) continue; // separator row
    const cells = t.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length) rows.push(cells);
  }
  return rows;
}

function cleanCategory(cell: string): VaccineCategory | null {
  const v = cell.replace(/`/g, "").trim();
  return (CATS as string[]).includes(v) ? (v as VaccineCategory) : null;
}

/** Parse the CDC vaccine table + the amyloid/tau table into a lookup catalog. */
export function parseVaccineTables(cdcMd: string, amyloidMd: string): VaccineCatalog {
  const brands: Array<{ key: string; row: VaxRow }> = [];
  const abbrevs = new Map<string, VaxRow>();
  const diseaseMap = new Map<string, VaxRow[]>();

  for (const cells of tableRows(cdcMd)) {
    // CDC columns: [Disease/Target, Vaccine name/abbreviation, Brand(s), Platform, Category]
    if (cells.length < 5) continue;
    const category = cleanCategory(cells[4]!);
    if (!category) continue; // header / malformed
    const row: VaxRow = { disease: cells[0]!.replace(/\s+/g, " ").trim(), category };
    // brands: split on comma/semicolon/slash, drop parentheticals
    for (const b of stripParen(cells[2]!).split(/[,;/]/)) {
      const key = normVax(b);
      if (key && key !== "—") brands.push({ key, row });
    }
    // abbreviations: alnum tokens from the abbrev cell (handles "LAIV4 (LAIV3)", "9vHPV (HPV9)")
    for (const a of normVax(cells[1]!).split(" ")) {
      if (a.length >= 2 && a !== "—") abbrevs.set(a, row);
    }
    // disease keywords: main term (pre-comma) + parenthetical names + disease-name tokens
    const diseaseCell = cells[0]!;
    const keys = new Set<string>();
    const main = normVax(stripParen(diseaseCell).split(",")[0]!);
    if (main) {
      keys.add(main);
      for (const w of main.split(" ")) {
        if (w.length >= 5 && !DISEASE_TOKEN_STOPLIST.has(w)) keys.add(w);
      }
    }
    for (const m of diseaseCell.matchAll(/\(([^)]*)\)/g)) {
      // tokenize parenthetical synonyms the same way (e.g. "(shingles)" →
      // shingles), filtering platform/qualifier words so e.g. "(recombinant)"
      // or "(15-valent)" never become disease keys.
      for (const w of normVax(m[1]!).split(" ")) {
        if (w.length >= 5 && !DISEASE_TOKEN_STOPLIST.has(w) && !/^\d+$/.test(w)) keys.add(w);
      }
    }
    for (const k of keys) {
      if (!diseaseMap.has(k)) diseaseMap.set(k, []);
      diseaseMap.get(k)!.push(row);
    }
  }

  const amyloid = new Set<string>();
  for (const cells of tableRows(amyloidMd)) {
    // Amyloid columns: [Therapy name, Aliases, Target, Sponsor, Status, Category]
    if (cells.length < 2) continue;
    const name = normVax(cells[0]!);
    if (name && name !== "therapy name") amyloid.add(name);
    for (const al of stripParen(cells[1]!).split(/[,;]/)) {
      const k = normVax(al);
      if (k && k !== "—" && k.length >= 2) amyloid.add(k);
    }
  }

  brands.sort((a, b) => b.key.length - a.key.length);
  const diseaseKeys = [...diseaseMap.entries()]
    .map(([key, rows]) => ({ key, rows }))
    .sort((a, b) => b.key.length - a.key.length);
  return { brands, abbrevs, diseaseKeys, amyloid };
}

const CLINICAL_REWRITES: Array<[RegExp, string]> = [
  [/\bhep\s+a\b/g, "hepatitis a"],
  [/\bhep\s+b\b/g, "hepatitis b"],
  [/\bhepa\b/g, "hepatitis a"],
  [/\bhepb\b/g, "hepatitis b"],
  [/\bdtp\b/g, "dtap"],
  [/\bpneumonia\b/g, "pneumococcal"],
  [/\bprevnar\b/g, "prevnar pneumococcal"],
  [/\bflu\b/g, "influenza"],
];

function clinicalRewrite(q: string): string {
  let out = q;
  for (const [re, sub] of CLINICAL_REWRITES) out = out.replace(re, sub);
  return out.replace(/\s+/g, " ").trim();
}

/** Deterministic category fallback for shorthand the CDC table can't resolve on
 *  its own: influenza WITH an explicit platform qualifier, and the unambiguous
 *  legacy oral polio vaccine. Bare flu with no platform stays unresolved. */
function clinicalFallbackCategory(q: string): VaccineCategory | null {
  if (/\bopv\b|oral polio/.test(q)) return "Live Vaccine";
  if (/influenza|\bflu\b/.test(q)) {
    if (/laiv|intranasal|live attenuated|\blive\b/.test(q)) return "Live Vaccine";
    if (/inactivated|\biiv\d?\b|\btiv\b|cciiv|\briv\d?\b|recombinant|\bsplit\b|high.?dose|\bhd\b|adjuvanted|\bim\b|intramuscular|injectable/.test(q)) {
      return "Non-Live Vaccine";
    }
  }
  return null;
}

/** Classify one extracted vaccine name against the catalog, returning BOTH its
 *  category and the disease/target it is for (from the table). Priority:
 *  brand → abbreviation → amyloid-name → disease keyword, with a clinical
 *  shorthand rewrite first and a platform/legacy fallback last. */
export function classifyVaccineFull(name: string, cat: VaccineCatalog): VaccineClassification {
  const q0 = normVax(name);
  if (!q0) return { category: "Ambiguous", disease: null };
  const q = clinicalRewrite(q0);
  const tokens = new Set(q.split(" "));

  // 1. Brand (longest-first) — row-specific disease + category.
  for (const { key, row } of cat.brands) {
    if (key.length >= 3 && q.includes(key)) return { category: row.category, disease: row.disease };
  }
  // 2. Abbreviation — a whole token equals a table abbreviation.
  for (const tok of tokens) {
    const row = cat.abbrevs.get(tok);
    if (row) return { category: row.category, disease: row.disease };
  }
  // 3. Amyloid/tau active immunization — for Alzheimer's disease.
  for (const a of cat.amyloid) {
    if (a.length >= 3 && q.includes(a)) return { category: "Active Amyloid or Tau Immunization", disease: "Alzheimer's disease" };
  }
  // 4. Disease/target keyword — collect every product for the matched disease(s).
  const rows: VaxRow[] = [];
  let longestKey = "";
  for (const { key, rows: rs } of cat.diseaseKeys) {
    if (q.includes(key)) { rows.push(...rs); if (key.length > longestKey.length) longestKey = key; }
  }
  if (rows.length) {
    const cats = new Set(rows.map((r) => r.category));
    const diseaseLabels = new Set(rows.map((r) => r.disease));
    // one shared disease label → use it; otherwise the matched keyword, title-cased.
    const disease = diseaseLabels.size === 1 ? [...diseaseLabels][0]! : titleCase(longestKey);
    if (cats.size === 1) return { category: [...cats][0]!, disease };
    // mixed-platform disease → category Ambiguous unless a platform qualifier resolves it.
    return { category: clinicalFallbackCategory(q0) ?? "Ambiguous", disease };
  }
  // 5. Fallback for shorthand with no disease-keyword match (flu-platform, OPV).
  const fb = clinicalFallbackCategory(q0);
  if (fb) {
    const disease = /\bopv\b|oral polio/.test(q0) ? "Poliovirus" : (/influenza|\bflu\b/.test(q0) ? "Influenza" : null);
    return { category: fb, disease };
  }
  return { category: "Ambiguous", disease: null };
}

/** Category-only convenience wrapper. */
export function classifyVaccine(name: string, cat: VaccineCatalog): VaccineCategory {
  return classifyVaccineFull(name, cat).category;
}
