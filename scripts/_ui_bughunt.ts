/* UI bug-hunt: entity render (synthetic) + multi-note switcher (real, no PHI shots).
 * Reads session ids from /tmp/g_ui + /tmp/g_real_pn (field 1). */
import { chromium, type ConsoleMessage } from "playwright";
import fs from "node:fs";

const SERVER = "http://localhost:3002";
const CLIENT = "http://localhost:5174";
const synthSess = fs.readFileSync("/tmp/g_ui", "utf8").trim().split(" ")[0];
const realSess = fs.readFileSync("/tmp/g_real_pn", "utf8").trim().split(" ")[0];
fs.mkdirSync("/tmp/uiqa", { recursive: true });

const errors: string[] = [];
function watch(page: import("playwright").Page, tag: string) {
  page.on("pageerror", (e) => errors.push(`[${tag}] pageerror: ${e.message}`));
  page.on("console", (m: ConsoleMessage) => { if (m.type() === "error") errors.push(`[${tag}] console.error: ${m.text().slice(0, 200)}`); });
}

async function login(): Promise<string> {
  const r = await fetch(`${SERVER}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reviewer_id: "yuhang" }) });
  return (await r.json() as { token: string }).token;
}

async function openPatient(page: import("playwright").Page, token: string, sess: string, patient: string) {
  await page.addInitScript(({ t, s }: { t: string; s: string }) => {
    localStorage.setItem("chart-review-token", t);
    localStorage.setItem("chart-review-reviewer-id", "yuhang");
    localStorage.setItem("chart-review:active-session:acts", s);
  }, { t: token, s: sess });
  await page.goto(`${CLIENT}/#/studio/acts/validate`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);
  // click the patient button in the validate roster
  const btn = page.getByRole("button", { name: new RegExp(patient.replace(/_/g, "[_ ]?"), "i") });
  if (await btn.count() > 0) { await btn.first().click(); await page.waitForTimeout(2500); return true; }
  // fallback: any element with the patient id text
  const el = page.getByText(patient, { exact: false });
  if (await el.count() > 0) { await el.first().click(); await page.waitForTimeout(2500); return true; }
  return false;
}

(async () => {
  const token = await login();
  const browser = await chromium.launch();
  const findings: string[] = [];

  // ---- Test A: entity render (synthetic, screenshots OK) ----
  {
    const page = await browser.newPage(); watch(page, "synth");
    const opened = await openPatient(page, token, synthSess, "patient_fake_acts_02");
    findings.push(`A. synthetic patient opened: ${opened}`);
    // step through criteria looking for allergen/vaccine entity render
    const body = await page.locator("body").innerText().catch(() => "");
    await page.screenshot({ path: "/tmp/uiqa/entity-initial.png", fullPage: false });
    findings.push(`A. "[object Object]" present (render bug)? ${body.includes("[object Object]")}`);
    // navigate to allergen criterion via the criterion stepper if a jump control exists
    for (const label of ["allergen", "vaccine_name"]) {
      // try clicking a criterion chip/name
      const chip = page.getByText(label, { exact: false });
      if (await chip.count() > 0) { await chip.first().click().catch(() => {}); await page.waitForTimeout(1200); }
      const t = await page.locator("body").innerText().catch(() => "");
      await page.screenshot({ path: `/tmp/uiqa/entity-${label}.png` });
      findings.push(`A. ${label}: page shows entity values? penicillin=${t.includes("penicillin") || t.includes("Penicillin")} MMR=${t.includes("MMR")} | [object Object]=${t.includes("[object Object]")}`);
    }
    await page.close();
  }

  // ---- Test B: multi-note switcher (REAL per-note — NO screenshots/PHI) ----
  {
    const page = await browser.newPage(); watch(page, "real-pernote");
    const opened = await openPatient(page, token, realSess, "patient_real_acts_01");
    findings.push(`\nB. real per-note patient opened: ${opened}`);
    const nextBtn = page.getByTitle("Next note");
    const prevBtn = page.getByTitle("Previous note");
    const nextCount = await nextBtn.count();
    findings.push(`B. note switcher present (Next/Prev buttons)? next=${nextCount} prev=${await prevBtn.count()}`);
    // the "N / M" counter
    const counter = await page.locator("text=/\\d+ \\/ \\d+/").first().innerText().catch(() => "(none)");
    findings.push(`B. note counter: ${counter}`);
    if (nextCount > 0) {
      await nextBtn.first().click().catch(() => {});
      await page.waitForTimeout(1200);
      const counter2 = await page.locator("text=/\\d+ \\/ \\d+/").first().innerText().catch(() => "(none)");
      findings.push(`B. after Next click, counter: ${counter2} (changed=${counter !== counter2})`);
    }
    await page.close();
  }

  await browser.close();
  console.log("=== UI FINDINGS ===");
  findings.forEach((f) => console.log(" ", f));
  console.log("\n=== CONSOLE / PAGE ERRORS ===");
  console.log(errors.length ? errors.map((e) => "  " + e).join("\n") : "  none ✓");
})();
