// Convert AD-CDE OWL → BSO-AD-shaped concepts.json
//
// Reads /AD-ontology/AD_CDE_w_constraint.owl and emits a JSON file
// shaped like the BSO-AD ontology already loaded by
// `@chart-review/ontology` and the NER MCP server. The output goes
// to .agents/skills/chart-review-ad-cde-ner/references/ontology/concepts.json
// (created in the next step).
//
// Shape mirrored from BSO-AD's concepts.json:
//   {
//     "<Root>": {
//       "root_id":  "<Root>",
//       "root_iri": "...",
//       "n_concepts": N,
//       "concepts": [ { "id": "...", "label": "..." }, ... ]
//     },
//     ...
//   }
//
// Decisions:
// - Keep 7 NER-friendly roots: Disease, Procedure, Medication,
//   Diagnostic_Test, Social_Determinant_Of_Health, Rating_Criteria,
//   Fertility.
// - Drop Constraint_Information (metadata, not extractable text),
//   Study_Variable (only 2 concepts, sparse), and 3 singleton orphans.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const OWL_PATH = path.join(REPO_ROOT, "AD-ontology", "AD_CDE_w_constraint.owl");
const OUT_PATH = path.resolve(
  __dirname, "..", ".agents", "skills", "chart-review-ad-cde-ner",
  "references", "ontology", "concepts.json",
);

const KEPT_ROOTS = new Set([
  "Disease",
  "Procedure",
  "Medication",
  "Diagnostic_Test",
  "Social_Determinant_Of_Health",
  "Rating_Criteria",
  "Fertility",
]);

const xml = fs.readFileSync(OWL_PATH, "utf8");

// ── Lightweight XML scan — no SAX dependency needed ────────────────────────
// 1. Collect every Class IRI.
// 2. Collect SubClassOf(child, parent) pairs.
// 3. Walk top-down from each kept root.

const classIris = new Set();
for (const m of xml.matchAll(/<Class IRI="([^"]+)"\s*\/>/g)) classIris.add(m[1]);

// SubClassOf in this OWL is rendered as:
//   <SubClassOf>
//       <Class IRI="#Child"/>
//       <Class IRI="#Parent"/>
//   </SubClassOf>
// We extract pairs by matching the block.
const parents = new Map(); // child -> Set<parent>
const subRe = /<SubClassOf>([\s\S]*?)<\/SubClassOf>/g;
for (const m of xml.matchAll(subRe)) {
  const body = m[1];
  const iris = [...body.matchAll(/<Class IRI="([^"]+)"\s*\/>/g)].map((x) => x[1]);
  if (iris.length >= 2) {
    const [child, parent] = iris;
    let s = parents.get(child);
    if (!s) { s = new Set(); parents.set(child, s); }
    s.add(parent);
  }
}

// rdfs:label lookup (optional — most class IRIs already carry a
// human-readable suffix, but if there's an English label we use it).
const labels = new Map();
for (const m of xml.matchAll(
  /<AnnotationAssertion>\s*<AnnotationProperty[^>]*abbreviatedIRI="rdfs:label"[^>]*\/>\s*<IRI>([^<]+)<\/IRI>\s*<Literal[^>]*>([^<]+)<\/Literal>\s*<\/AnnotationAssertion>/g,
)) {
  labels.set(m[1], m[2]);
}

// Children index (parent -> children[]).
const children = new Map();
for (const [child, parentSet] of parents) {
  for (const p of parentSet) {
    let arr = children.get(p);
    if (!arr) { arr = []; children.set(p, arr); }
    arr.push(child);
  }
}

function shortName(iri) {
  return iri.split("#").pop().split("/").pop();
}
function humanLabel(iri) {
  return labels.get(iri) ?? shortName(iri).replace(/_/g, " ");
}

// Walk subtree breadth-first from a root, emitting one record per
// descendant with parent_id / parent_label / depth — matching the
// BSO-AD concepts.json shape so the NER MCP server's get_concept_tree
// tool can render a real hierarchy. Visits each class exactly once even
// when SubClassOf produces multiple parents (we keep the first parent
// reached — concept_name lookup stays unambiguous).
function collectSubtree(rootIri) {
  const out = [];
  const seen = new Set([rootIri]);
  const queue = [{ iri: rootIri, parentIri: null, depth: 0 }];
  while (queue.length) {
    const { iri, parentIri, depth } = queue.shift();
    out.push({
      id: shortName(iri),
      label: humanLabel(iri),
      parent_id: parentIri ? shortName(parentIri) : null,
      parent_label: parentIri ? humanLabel(parentIri) : null,
      depth,
    });
    for (const ch of children.get(iri) ?? []) {
      if (seen.has(ch)) continue;
      seen.add(ch);
      queue.push({ iri: ch, parentIri: iri, depth: depth + 1 });
    }
  }
  return out;
}

const ontology = {};
for (const rootName of KEPT_ROOTS) {
  // Find the root IRI by matching the short name. The OWL puts the
  // top-level roots as either bare `#<Name>` or namespaced. Search
  // every class IRI for an exact short-name match.
  let rootIri = null;
  for (const iri of classIris) {
    if (shortName(iri) === rootName) { rootIri = iri; break; }
  }
  if (!rootIri) {
    console.error(`! root '${rootName}' not found in OWL — skipping`);
    continue;
  }
  const concepts = collectSubtree(rootIri);
  ontology[rootName] = {
    root_id: rootName,
    root_iri: rootIri,
    n_concepts: concepts.length,
    concepts,
  };
}

fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
fs.writeFileSync(OUT_PATH, JSON.stringify(ontology, null, 2));

// Summary
console.log(`Wrote ${OUT_PATH}`);
let total = 0;
for (const [k, v] of Object.entries(ontology)) {
  console.log(`  ${k}: ${v.n_concepts}`);
  total += v.n_concepts;
}
console.log(`  TOTAL: ${total}`);
