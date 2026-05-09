// Diagnostic smoke: connect to the running server's WebSocket, send one
// minimal chat, dump every event WITHOUT truncation. Used to capture the
// full upstream error when a non-Anthropic model rejects our tool surface.
//
//   node scripts/diagnose-model.mjs [patient_id] [prompt]

import WebSocket from "ws";

const patientId = process.argv[2] ?? "patient_easy_nsclc_01";
const prompt = process.argv.slice(3).join(" ") || "Read meta.json and tell me the patient's age.";

const ws = new WebSocket("ws://localhost:3001/ws");
let firstError = null;
let resultArrived = false;

const TIMEOUT_MS = 240_000;
const timer = setTimeout(() => {
  console.error("\n[timeout]");
  finish(2);
}, TIMEOUT_MS);

ws.on("open", () => {
  ws.send(JSON.stringify({ type: "subscribe", patientId }));
  ws.send(JSON.stringify({ type: "chat", patientId, content: prompt }));
});

ws.on("message", (raw) => {
  const ev = JSON.parse(raw.toString());
  if (ev.type === "assistant_message") {
    // Print FULL content, never truncate.
    console.log(`\n=== assistant_message ===`);
    console.log(ev.content);
    if (/API Error/i.test(ev.content) && !firstError) firstError = ev.content;
  } else if (ev.type === "tool_use") {
    console.log(`\n--- tool_use: ${ev.toolName} ---`);
    console.log(JSON.stringify(ev.toolInput, null, 2));
  } else if (ev.type === "result") {
    console.log(`\n=== result ===`);
    console.log(`success=${ev.success} cost=${ev.cost} duration=${ev.duration}ms`);
    resultArrived = true;
    finish(ev.success ? 0 : 1);
  } else if (ev.type === "error") {
    console.log(`\n=== error ===`);
    console.log(ev.error);
    finish(1);
  }
});

ws.on("error", (e) => {
  console.error("[ws error]", e.message);
  finish(1);
});

function finish(code) {
  clearTimeout(timer);
  if (firstError && !resultArrived) {
    console.log("\n=== first API Error ===");
    console.log(firstError);
  }
  ws.close();
  process.exit(code);
}
