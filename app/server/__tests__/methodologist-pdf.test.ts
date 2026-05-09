// app/server/__tests__/methodologist-pdf.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { generatePdf } from "../methodologist-pdf";

let TMP: string;
beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-test-"));
});
afterEach(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe("generatePdf", () => {
  it("returns a Readable that starts with %PDF magic", async () => {
    // We can call generatePdf with a non-existent task — loadCompiledTask returns null,
    // qa-panel returns zeros, the PDF still renders a valid empty report.
    const stream = await generatePdf("nonexistent-task", TMP);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const pdf = Buffer.concat(chunks);
    expect(pdf.slice(0, 5).toString("ascii")).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(500); // sanity: a real PDF is at least a few hundred bytes
  });
});
