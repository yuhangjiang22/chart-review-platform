/**
 * Step 2 (Post-Processing Classification) of the ACTS Vaccine Extraction
 * Guideline: assign each extracted vaccine NAME a category using ONLY the CDC
 * reference table (+ the Alzforum amyloid/tau table) — never from model memory.
 *
 * Priority per the guideline: brand name → abbreviation → disease/target.
 * Brand wins (the same disease can have both live and non-live products, e.g.
 * Zostavax=Live vs Shingrix=Non-Live). A disease-only mention whose products
 * span more than one category resolves to "Ambiguous" (do not guess). BCG is its
 * own category. Amyloid/tau active immunizations match by name only.
 */

export type VaccineCategory =
  | "Live Vaccine"
  | "Non-Live Vaccine"
  | "BCG"
  | "Active Amyloid or Tau Immunization"
  | "Ambiguous";

export interface VaccineCatalog {
  /** normalized brand phrase → category; matched longest-first */
  brands: Array<{ key: string; category: VaccineCategory }>;
  /** normalized abbreviation token → category */
  abbrevs: Map<string, VaccineCategory>;
  /** normalized disease keyword → set of categories across its products */
  diseases: Array<{ key: string; categories: Set<VaccineCategory> }>;
  /** normalized amyloid/tau therapy name or alias (category is fixed) */
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
  "virus", "human", "type", "types",
]);

/** lowercase, drop punctuation to spaces, collapse whitespace */
export function normVax(s: string): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function stripParen(s: string): string {
  return s.replace(/\([^)]*\)/g, " ");
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
  const brands: Array<{ key: string; category: VaccineCategory }> = [];
  const abbrevs = new Map<string, VaccineCategory>();
  const diseaseMap = new Map<string, Set<VaccineCategory>>();

  for (const cells of tableRows(cdcMd)) {
    // CDC columns: [Disease/Target, Vaccine name/abbreviation, Brand(s), Platform, Category]
    if (cells.length < 5) continue;
    const category = cleanCategory(cells[4]!);
    if (!category) continue; // header / malformed
    // brands: split on comma/semicolon, drop parentheticals
    for (const b of stripParen(cells[2]!).split(/[,;/]/)) {
      const key = normVax(b);
      if (key && key !== "—") brands.push({ key, category });
    }
    // abbreviations: alnum tokens from the abbrev cell (handles "LAIV4 (LAIV3)", "9vHPV (HPV9)")
    for (const a of normVax(cells[1]!).split(" ")) {
      if (a.length >= 2 && a !== "—") abbrevs.set(a, category);
    }
    // disease keywords: main term (pre-comma) + parenthetical common names
    const diseaseCell = cells[0]!;
    const keys = new Set<string>();
    const main = normVax(stripParen(diseaseCell).split(",")[0]!);
    if (main) {
      keys.add(main);
      // also key on each disease-NAME token (not platform/qualifier words) so a
      // generic "<disease> vaccine" mention matches multi-word table diseases —
      // e.g. "pneumococcal vaccine" / "pertussis vaccine" / "hepatitis b". Each
      // token's category set is unioned across all rows, so a mixed-platform
      // disease (e.g. influenza: LAIV live + IIV non-live) still resolves to
      // Ambiguous, while a uniform one (all pertussis products non-live) resolves.
      for (const w of main.split(" ")) {
        if (w.length >= 5 && !DISEASE_TOKEN_STOPLIST.has(w)) keys.add(w);
      }
    }
    for (const m of diseaseCell.matchAll(/\(([^)]*)\)/g)) {
      const k = normVax(m[1]!);
      if (k) keys.add(k);
    }
    for (const k of keys) {
      if (!diseaseMap.has(k)) diseaseMap.set(k, new Set());
      diseaseMap.get(k)!.add(category);
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

  // longest brand phrase first so "fluzone high dose" wins over "fluzone"
  brands.sort((a, b) => b.key.length - a.key.length);
  const diseases = [...diseaseMap.entries()]
    .map(([key, categories]) => ({ key, categories }))
    .sort((a, b) => b.key.length - a.key.length);
  return { brands, abbrevs, diseases, amyloid };
}

/** Classify one extracted vaccine name against the catalog (brand → abbrev →
 *  amyloid → disease → Ambiguous). Returns "Ambiguous" when no deterministic
 *  match exists — the guideline's safe default for human review. */
export function classifyVaccine(name: string, cat: VaccineCatalog): VaccineCategory {
  const q = normVax(name);
  if (!q) return "Ambiguous";
  const tokens = new Set(q.split(" "));

  // 1. Brand (longest-first): brand phrase appears within the extracted name.
  for (const { key, category } of cat.brands) {
    if (key.length >= 3 && (q === key || q.includes(key))) return category;
  }
  // 2. Abbreviation: a whole token equals a table abbreviation.
  for (const tok of tokens) {
    const c = cat.abbrevs.get(tok);
    if (c) return c;
  }
  // 3. Amyloid/tau: therapy name or alias appears in the name.
  for (const a of cat.amyloid) {
    if (a.length >= 3 && (q === a || q.includes(a))) return "Active Amyloid or Tau Immunization";
  }
  // 4. Disease/target: collect categories of all products for matched diseases.
  const found = new Set<VaccineCategory>();
  for (const { key, categories } of cat.diseases) {
    if (q.includes(key)) for (const c of categories) found.add(c);
  }
  if (found.size === 1) return [...found][0]!;
  // size 0 (no match) or >1 (mixed-platform disease) → do not guess.
  return "Ambiguous";
}
