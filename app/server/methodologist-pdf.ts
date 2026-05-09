// app/server/methodologist-pdf.ts
import PDFDocument from "pdfkit";
import { Readable } from "stream";
import { computeQAStats } from "./qa-panel.js";
import { loadCompiledTask } from "./tasks.js";

export async function generatePdf(taskId: string, reviewsRoot: string): Promise<Readable> {
  const task = loadCompiledTask(taskId);
  const qa = await computeQAStats(taskId, reviewsRoot);

  const doc = new PDFDocument({ size: "letter", margin: 50 });

  // Page 1: Header
  doc.fontSize(20).text("Chart Review Verification Report", { align: "center" });
  doc.moveDown(0.5);
  doc.fontSize(14).text(`Task: ${taskId}`, { align: "center" });
  doc.moveDown();
  doc.fontSize(10).text(`Generated: ${new Date().toISOString()}`);
  doc.moveDown();
  doc.text(`Total records: ${qa.total_records}`);
  doc.text(`Locked: ${qa.records_locked}`);
  doc.text(`Validated: ${qa.records_validated}`);
  doc.text(`In progress: ${qa.records_in_progress}`);

  // Page 2: Locked task contract
  doc.addPage();
  doc.fontSize(16).text("Task contract");
  doc.moveDown();
  if (task && task.fields) {
    for (const f of task.fields) {
      doc.fontSize(12).font("Helvetica-Bold").text(f.id);
      if (f.prompt) {
        doc.font("Helvetica").fontSize(10).text(f.prompt, { paragraphGap: 6 });
      }
      doc.moveDown(0.5);
    }
  } else {
    doc.font("Helvetica").fontSize(10).text("(Task definition not found or no fields defined.)");
  }

  // Page 3+: Calibration metrics
  doc.addPage();
  doc.fontSize(16).text("Calibration metrics");
  doc.moveDown();
  const criterionEntries = Object.entries(qa.by_criterion);
  if (criterionEntries.length === 0) {
    doc.font("Helvetica").fontSize(10).text("(No calibration data available.)");
  } else {
    for (const [fid, c] of criterionEntries) {
      doc.fontSize(12).font("Helvetica-Bold").text(fid);
      doc.font("Helvetica").fontSize(10);
      doc.text(
        `Override rate: ${(c.override_rate * 100).toFixed(1)}% (${c.override_count}/${c.reviewer_touched})`,
      );
      if (c.kappa !== undefined) {
        doc.text(
          `kappa = ${c.kappa.toFixed(3)} (${c.kappa_reviewers?.[0]} vs ${c.kappa_reviewers?.[1]}, ${c.kappa_n_shared} shared)`,
        );
      }
      const reasonEntries = Object.entries(c.override_reasons);
      if (reasonEntries.length > 0) {
        doc.text(
          `Reasons: ${reasonEntries.map(([r, n]) => `${r}: ${n}`).join(", ")}`,
        );
      }
      doc.moveDown();
    }
  }

  // Last page: Drift alerts (if any)
  if (qa.drift_alerts.length > 0) {
    doc.addPage();
    doc.fontSize(16).text("Drift alerts");
    doc.moveDown();
    for (const alert of qa.drift_alerts) {
      doc.font("Helvetica").fontSize(10);
      doc.text(
        `${alert.field_id}: baseline ${(alert.baseline_rate * 100).toFixed(1)}% -> current ${(alert.current_rate * 100).toFixed(1)}% (delta ${alert.delta_pp.toFixed(1)}pp), triggered ${alert.triggered_at.slice(0, 19)}`,
      );
      doc.moveDown(0.3);
    }
  }

  doc.end();
  return doc as unknown as Readable;
}
