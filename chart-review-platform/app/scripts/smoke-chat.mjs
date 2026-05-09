// Live smoke test: connect to the running server's WebSocket, subscribe to
// patient_001, send one chat message, print every event until the agent
// finishes (or 90 seconds elapse), then exit.
//
//   node scripts/smoke-chat.mjs              # default patient_001 + summary prompt
//   node scripts/smoke-chat.mjs patient_002 "Does this patient have lung cancer?"
//
// Requires the server to be running at ws://localhost:3001/ws.

import WebSocket from "ws";

const patientId = process.argv[2] ?? "patient_001";
const prompt =
  process.argv.slice(3).join(" ") ||
  "Summarize this patient's chart in 4-6 sentences. Cite the filename next to any clinical claim.";

const TIMEOUT_MS = 180_000;

const ws = new WebSocket("ws://localhost:3001/ws");

const startedAt = Date.now();
let firstAssistantAt = null;
let toolCalls = 0;
let assistantTexts = 0;
let totalAssistantChars = 0;
let resolved = false;

const timer = setTimeout(() => {
  console.error(`\n[timeout after ${TIMEOUT_MS / 1000}s]`);
  finish(2);
}, TIMEOUT_MS);

ws.on("open", () => {
  console.log(`▸ connected; subscribing to ${patientId}`);
  ws.send(JSON.stringify({ type: "subscribe", patientId }));
  console.log(`▸ sending prompt: ${JSON.stringify(prompt)}`);
  ws.send(JSON.stringify({ type: "chat", patientId, content: prompt }));
});

ws.on("message", (raw) => {
  const ev = JSON.parse(raw.toString());
  switch (ev.type) {
    case "connected":
      // ignore
      break;
    case "history":
      console.log(`▸ history: ${ev.messages.length} prior messages`);
      break;
    case "user_message":
      console.log(`\n[user] ${ev.content}`);
      break;
    case "tool_use":
      toolCalls += 1;
      console.log(
        `\n[tool ${toolCalls}] ${ev.toolName}(${JSON.stringify(ev.toolInput)})`,
      );
      break;
    case "assistant_message":
      assistantTexts += 1;
      totalAssistantChars += ev.content.length;
      if (firstAssistantAt === null) firstAssistantAt = Date.now();
      console.log(`\n[assistant] ${ev.content}`);
      break;
    case "result":
      console.log(
        `\n▸ result: success=${ev.success}` +
          (ev.cost != null ? ` cost=$${ev.cost.toFixed(5)}` : "") +
          (ev.duration != null ? ` duration=${ev.duration}ms` : ""),
      );
      finish(ev.success ? 0 : 1);
      break;
    case "error":
      console.error(`\n[error] ${ev.error}`);
      finish(1);
      break;
    default:
      console.log(`\n[?] ${JSON.stringify(ev)}`);
  }
});

ws.on("error", (e) => {
  console.error(`[ws error] ${e.message}`);
  finish(1);
});

function finish(code) {
  if (resolved) return;
  resolved = true;
  clearTimeout(timer);
  const totalMs = Date.now() - startedAt;
  const ttfMs = firstAssistantAt ? firstAssistantAt - startedAt : null;
  console.log("\n--- smoke summary ---");
  console.log(`  patient_id:       ${patientId}`);
  console.log(`  total_ms:         ${totalMs}`);
  console.log(`  ttf_assistant_ms: ${ttfMs ?? "(no assistant text)"}`);
  console.log(`  tool_calls:       ${toolCalls}`);
  console.log(`  assistant_blocks: ${assistantTexts}`);
  console.log(`  assistant_chars:  ${totalAssistantChars}`);
  console.log(`  exit:             ${code}`);
  ws.close();
  process.exit(code);
}
