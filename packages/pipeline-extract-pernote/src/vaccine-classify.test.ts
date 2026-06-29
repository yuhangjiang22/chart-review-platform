import { describe, it, expect } from "vitest";
import { parseVaccineTables, classifyVaccine } from "./vaccine-classify.js";

const CDC = `
| Disease / Target | Vaccine name / abbreviation | Common US brand name(s) | Platform / type | Category |
|---|---|---|---|---|
| Measles-Mumps-Rubella | MMR | M-M-R II, Priorix | Live attenuated | \`Live Vaccine\` |
| Herpes Zoster (shingles), live | ZVL | Zostavax (discontinued in US, Nov 2020) | Live attenuated | \`Live Vaccine\` |
| Herpes Zoster (shingles), recombinant | RZV | Shingrix | Recombinant subunit | \`Non-Live Vaccine\` |
| Influenza, live attenuated | LAIV4 | FluMist | Live attenuated | \`Live Vaccine\` |
| Influenza, inactivated | IIV4 | Fluzone, Fluarix | Inactivated | \`Non-Live Vaccine\` |
| Typhoid (oral, live) | Ty21a | Vivotif | Live attenuated | \`Live Vaccine\` |
| Typhoid (Vi polysaccharide) | ViCPS | Typhim Vi | Polysaccharide | \`Non-Live Vaccine\` |
| Tetanus-diphtheria-acellular Pertussis (adult) | Tdap | Boostrix, Adacel | Toxoid | \`Non-Live Vaccine\` |
| Pneumococcal conjugate (20-valent) | PCV20 | Prevnar 20 | Conjugate | \`Non-Live Vaccine\` |
| Pneumococcal polysaccharide (23-valent) | PPSV23 | Pneumovax 23 | Polysaccharide | \`Non-Live Vaccine\` |
| Hepatitis A | HepA | Havrix, Vaqta | Inactivated | \`Non-Live Vaccine\` |
| Hepatitis B | HepB | Engerix-B, Recombivax HB | Recombinant subunit | \`Non-Live Vaccine\` |
| Diphtheria-Tetanus-acellular Pertussis (peds) | DTaP | Daptacel, Infanrix | Toxoid | \`Non-Live Vaccine\` |
| Tuberculosis | BCG | TICE BCG | Live attenuated | \`BCG\` |
`;
const AMYLOID = `
| Therapy name | Aliases / development codes | Target | Sponsor | Status | Category |
|---|---|---|---|---|---|
| AADvac1 | Axon peptide 108 | Tau | Axon | Phase 2 | Active Amyloid or Tau Immunization |
| Amilomotide | CAD106 | Amyloid-beta | Novartis | Discontinued | Active Amyloid or Tau Immunization |
`;

const cat = parseVaccineTables(CDC, AMYLOID);

describe("classifyVaccine — deterministic CDC-table lookup (no memory)", () => {
  it("brand wins over disease: same disease, opposite categories", () => {
    expect(classifyVaccine("Shingrix", cat)).toBe("Non-Live Vaccine");
    expect(classifyVaccine("Zostavax", cat)).toBe("Live Vaccine");
    expect(classifyVaccine("Vivotif", cat)).toBe("Live Vaccine");
    expect(classifyVaccine("Typhim Vi", cat)).toBe("Non-Live Vaccine");
    expect(classifyVaccine("FluMist", cat)).toBe("Live Vaccine");
    expect(classifyVaccine("Fluzone", cat)).toBe("Non-Live Vaccine");
  });

  it("matches a brand embedded in free text", () => {
    expect(classifyVaccine("patient received Shingrix today", cat)).toBe("Non-Live Vaccine");
  });

  it("falls back to abbreviation (whole token)", () => {
    expect(classifyVaccine("MMR", cat)).toBe("Live Vaccine");
    expect(classifyVaccine("Tdap", cat)).toBe("Non-Live Vaccine");
    expect(classifyVaccine("PPSV23", cat)).toBe("Non-Live Vaccine");
  });

  it("BCG gets its own category, not Live", () => {
    expect(classifyVaccine("BCG", cat)).toBe("BCG");
  });

  it("disease-only with UNIFORM category resolves; MIXED is Ambiguous", () => {
    expect(classifyVaccine("pneumococcal vaccine", cat)).toBe("Non-Live Vaccine"); // both pneumococcal rows non-live
    expect(classifyVaccine("shingles vaccine", cat)).toBe("Ambiguous");            // live + non-live
    expect(classifyVaccine("influenza vaccine", cat)).toBe("Ambiguous");           // LAIV live + IIV non-live
    expect(classifyVaccine("typhoid vaccine", cat)).toBe("Ambiguous");             // Ty21a live + ViCPS non-live
  });

  it("amyloid/tau active immunizations match by name or alias", () => {
    expect(classifyVaccine("AADvac1", cat)).toBe("Active Amyloid or Tau Immunization");
    expect(classifyVaccine("CAD106", cat)).toBe("Active Amyloid or Tau Immunization"); // alias
  });

  it("no table match → Ambiguous (e.g. a passive mAb), never a guess", () => {
    expect(classifyVaccine("lecanemab", cat)).toBe("Ambiguous");
    expect(classifyVaccine("", cat)).toBe("Ambiguous");
  });
});

describe("classifyVaccine — clinical-shorthand layer", () => {
  it("expands shorthand to canonical table terms", () => {
    expect(classifyVaccine("hep a / hep b", cat)).toBe("Non-Live Vaccine");      // hep -> hepatitis (not in fixture; falls to... )
    expect(classifyVaccine("dtp", cat)).toBe("Non-Live Vaccine");                // dtp -> dtap abbrev
    expect(classifyVaccine("pneumonia 23", cat)).toBe("Non-Live Vaccine");       // pneumonia -> pneumococcal
    expect(classifyVaccine("prevnar 13 vaccine", cat)).toBe("Non-Live Vaccine"); // prevnar -> pneumococcal
  });
  it("resolves influenza by explicit platform qualifier; bare flu stays Ambiguous", () => {
    expect(classifyVaccine("influenza tiv (im)", cat)).toBe("Non-Live Vaccine");
    expect(classifyVaccine("flu vaccine, split, high-dose", cat)).toBe("Non-Live Vaccine");
    expect(classifyVaccine("influenza, intranasal", cat)).toBe("Live Vaccine");
    expect(classifyVaccine("flu vaccine", cat)).toBe("Ambiguous");               // no platform → still ambiguous
    expect(classifyVaccine("flu, older 3yrs (>36 mos)", cat)).toBe("Ambiguous"); // no platform → ambiguous
  });
  it("maps the unambiguous legacy oral polio vaccine to Live", () => {
    expect(classifyVaccine("OPV", cat)).toBe("Live Vaccine");
  });
});
