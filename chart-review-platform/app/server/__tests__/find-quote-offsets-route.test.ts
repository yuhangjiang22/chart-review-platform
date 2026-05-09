import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import express from "express";
import request from "supertest";

// patients.ts resolves CORPUS_ROOT / PATIENTS_ROOT at module-load time, so
// the env var must be set BEFORE importing the route module (which transitively
// imports patients.ts via find-quote-offsets-impl.ts).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fqo-route-"));
const PID = "test_patient_001";
const NOTE = "2025-07-15__pcp_visit";
const NOTE_TEXT = "PMH: Hypertension (controlled), hyperlipidemia.";

process.env.CHART_REVIEW_CORPUS_ROOT = TMP;
fs.mkdirSync(path.join(TMP, "patients", PID, "notes"), { recursive: true });
fs.writeFileSync(
  path.join(TMP, "patients", PID, "notes", `${NOTE}.txt`),
  NOTE_TEXT,
  "utf8",
);

const { reviewRouter } = await import("../adapters/http/review-routes.js");

const app = express();
app.use(express.json());
app.use(
  reviewRouter({
    broadcastReviewStateUpdate: () => {},
  }),
);

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  delete process.env.CHART_REVIEW_CORPUS_ROOT;
});

describe("POST /api/reviews/:patientId/find-quote-offsets", () => {
  it("returns ok=true with span_offsets for a valid snippet", async () => {
    const res = await request(app)
      .post(`/api/reviews/${PID}/find-quote-offsets`)
      .send({ note_id: NOTE, snippet: "Hypertension (controlled)" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.span_offsets).toEqual([
      NOTE_TEXT.indexOf("Hypertension (controlled)"),
      NOTE_TEXT.indexOf("Hypertension (controlled)") +
        "Hypertension (controlled)".length,
    ]);
    expect(res.body.verbatim_quote).toBe("Hypertension (controlled)");
  });

  it("returns ok=false snippet_not_found for missing text", async () => {
    const res = await request(app)
      .post(`/api/reviews/${PID}/find-quote-offsets`)
      .send({ note_id: NOTE, snippet: "diabetes mellitus type 2" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error_code).toBe("snippet_not_found");
  });

  it("returns 400 when body is missing required fields", async () => {
    const res = await request(app)
      .post(`/api/reviews/${PID}/find-quote-offsets`)
      .send({ note_id: NOTE });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });
});
