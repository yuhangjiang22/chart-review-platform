// Ontology lifecycle routes for NER tasks.
//
// Phase 2.9 minimal slice: surface pending ontology-extension proposals
// (written to disk by the `chart-review-ner-ontology-extend` skill) and
// let the methodologist promote one. Promotion bumps the ontology
// version (a separate identity from any task version) and writes a new
// concepts.json snapshot under var/ontologies/<id>/<version>/.
//
// Routes:
//   GET    /api/ontology/:ontologyId/extension-proposals
//   GET    /api/ontology/:ontologyId/extension-proposals/:proposalId
//   POST   /api/ontology/:ontologyId/extension-proposals/:proposalId/promote   (methodologist)

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { RouteEntry } from "./router.js";
import { isMethodologist, readReviewerFromRequest } from "./auth.js";
import { PLATFORM_ROOT } from "@chart-review/patients";

function httpErr(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

function ontologyDir(ontologyId: string): string {
  if (!/^[a-z][a-z0-9-]+$/.test(ontologyId)) {
    throw httpErr(400, `invalid ontology_id: ${ontologyId}`);
  }
  return path.join(PLATFORM_ROOT, "var", "ontologies", ontologyId);
}

function proposalsDir(ontologyId: string): string {
  return path.join(ontologyDir(ontologyId), "proposals");
}

interface ProposalSummary {
  proposal_id: string;
  ontology_id: string;
  current_version: string;
  target_version: string;
  kind: string;
  entity_type: string;
  status: string;
  generated_at?: string;
  rationale_preview: string;
}

function summarizeProposal(filepath: string, proposalId: string): ProposalSummary | null {
  try {
    const yaml = parseYaml(fs.readFileSync(filepath, "utf8")) as Record<string, unknown>;
    return {
      proposal_id: proposalId,
      ontology_id: String(yaml.ontology_id ?? ""),
      current_version: String(yaml.current_version ?? ""),
      target_version: String(yaml.target_version ?? ""),
      kind: String(yaml.kind ?? ""),
      entity_type: String(yaml.entity_type ?? ""),
      status: String(yaml.status ?? "draft"),
      generated_at: typeof yaml.generated_at === "string" ? yaml.generated_at : undefined,
      rationale_preview: String(yaml.rationale ?? "").split("\n")[0]?.slice(0, 120) ?? "",
    };
  } catch { return null; }
}

export const ontologyRoutes: RouteEntry[] = [
  {
    method: "GET", pattern: "/api/ontology/:ontologyId/extension-proposals",
    handler: async (_b, _r, p) => {
      const dir = proposalsDir(p.ontologyId);
      if (!fs.existsSync(dir)) return { ok: true, proposals: [] };
      const out: ProposalSummary[] = [];
      for (const name of fs.readdirSync(dir).sort()) {
        if (!name.endsWith(".yaml")) continue;
        const proposalId = name.replace(/\.yaml$/, "");
        const summary = summarizeProposal(path.join(dir, name), proposalId);
        if (summary) out.push(summary);
      }
      return { ok: true, proposals: out };
    },
  },

  {
    method: "GET", pattern: "/api/ontology/:ontologyId/extension-proposals/:proposalId",
    handler: async (_b, _r, p) => {
      const fp = path.join(proposalsDir(p.ontologyId), `${p.proposalId}.yaml`);
      if (!fs.existsSync(fp)) throw httpErr(404, "proposal not found");
      return { ok: true, proposal_id: p.proposalId, yaml: fs.readFileSync(fp, "utf8") };
    },
  },

  {
    method: "POST", pattern: "/api/ontology/:ontologyId/extension-proposals/:proposalId/promote",
    handler: async (_body, req, p) => {
      const reviewerId = readReviewerFromRequest(req);
      if (!isMethodologist(reviewerId)) {
        throw httpErr(403, "ontology promotion requires methodologist privilege");
      }
      const fp = path.join(proposalsDir(p.ontologyId), `${p.proposalId}.yaml`);
      if (!fs.existsSync(fp)) throw httpErr(404, "proposal not found");
      // Minimal MVP: mark the proposal as accepted; the actual concept
      // tree mutation is deferred to a downstream operator-tool run.
      // (Doing a real ontology version bump from here would also
      // require coordinating with every task that has ontology_pin
      // matching the old version — a Phase 3 concern.)
      const yaml = parseYaml(fs.readFileSync(fp, "utf8")) as Record<string, unknown>;
      yaml.status = "accepted";
      yaml.accepted_at = new Date().toISOString();
      yaml.accepted_by = reviewerId;
      fs.writeFileSync(fp, stringifyYaml(yaml));
      return { ok: true, proposal_id: p.proposalId, status: "accepted" };
    },
  },
];
