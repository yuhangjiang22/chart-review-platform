import WebSocket from "ws";

const patientId = "patient_neg_hard_01";
const prompt = "Investigate `pathology_report_present` for this patient. Do NOT just chat — once you have an answer, call set_field_assessment with the field_id, answer, evidence (with verbatim_quote and span_offsets), confidence, and rationale.";

const ws = new WebSocket("ws://localhost:3001/ws");
let toolCalls = 0;
let setFieldAssessmentCalls = 0;
let stateUpdates = 0;
let lastVersion = null;

ws.on("open", () => {
  ws.send(JSON.stringify({ type: "subscribe", patientId }));
  ws.send(JSON.stringify({ type: "chat", patientId, content: prompt }));
});

const timer = setTimeout(() => {
  console.error("\n[timeout]");
  finish(2);
}, 240_000);

ws.on("message", (raw) => {
  const ev = JSON.parse(raw.toString());
  if (ev.type === "tool_use") {
    toolCalls += 1;
    if (ev.toolName === "mcp__chart_review_state__set_field_assessment") {
      setFieldAssessmentCalls += 1;
      console.log(`[mcp call ${setFieldAssessmentCalls}] set_field_assessment(${JSON.stringify(ev.toolInput).slice(0, 220)}...)`);
    } else {
      console.log(`[tool ${toolCalls}] ${ev.toolName}`);
    }
  } else if (ev.type === "review_state_update") {
    stateUpdates += 1;
    lastVersion = ev.state.version;
    const a = ev.state.field_assessments;
    console.log(`[state v${lastVersion}] ${a.length} assessments — last: ${a[a.length-1]?.field_id}=${JSON.stringify(a[a.length-1]?.answer)}`);
  } else if (ev.type === "result") {
    console.log(`[result] success=${ev.success} cost=$${ev.cost?.toFixed?.(5)} duration=${ev.duration}ms`);
    finish(ev.success ? 0 : 1);
  } else if (ev.type === "assistant_message") {
    console.log(`[assistant] ${ev.content.slice(0, 200)}`);
  } else if (ev.type === "error") {
    console.log(`[error] ${ev.error}`);
    finish(1);
  }
});

function finish(code) {
  clearTimeout(timer);
  console.log(`\n--- summary ---`);
  console.log(`  tool_calls: ${toolCalls}`);
  console.log(`  set_field_assessment calls: ${setFieldAssessmentCalls}`);
  console.log(`  review_state_update events: ${stateUpdates}`);
  console.log(`  last review_state version: ${lastVersion}`);
  ws.close();
  process.exit(code);
}
