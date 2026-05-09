"""Headed-browser smoke: open the React UI, verify the three panes render,
click into patient_001's first note, send a chat message, and watch for
streamed assistant output."""

import sys
import time
from playwright.sync_api import sync_playwright

UI_URL = "http://localhost:5173/"
SCREENSHOT_DIR = "/tmp/chart-review-mini-screens"

import os
os.makedirs(SCREENSHOT_DIR, exist_ok=True)


def main() -> int:
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="chrome", headless=True)
        context = browser.new_context(viewport={"width": 1400, "height": 900})
        page = context.new_page()

        log: list[str] = []
        page.on("console", lambda m: log.append(f"console.{m.type}: {m.text}"))
        page.on("pageerror", lambda e: log.append(f"pageerror: {e}"))

        page.goto(UI_URL, wait_until="networkidle")
        page.screenshot(path=f"{SCREENSHOT_DIR}/01-loaded.png")

        # Both patients should show in the sidebar.
        page.wait_for_selector("text=Patient 001", timeout=10_000)
        page.wait_for_selector("text=Patient 002", timeout=2_000)

        # First patient is auto-selected; the first note's body should be visible.
        page.wait_for_selector("text=CT CHEST WITH CONTRAST", timeout=5_000)

        # Click the third note (oncology consult).
        page.click("text=2025-09-22 · oncology consult")
        page.wait_for_selector("text=ONCOLOGY CONSULTATION", timeout=5_000)
        page.screenshot(path=f"{SCREENSHOT_DIR}/02-note.png")

        # Click patient_002 to confirm switching.
        page.click("text=Patient 002")
        page.wait_for_selector("text=EMERGENCY DEPARTMENT NOTE", timeout=5_000)
        page.screenshot(path=f"{SCREENSHOT_DIR}/03-patient002.png")

        # Switch back to patient_001 for chat.
        page.click("text=Patient 001")
        page.wait_for_selector("text=CT CHEST WITH CONTRAST", timeout=5_000)

        # Send a chat message.
        chat = page.locator("textarea")
        chat.fill("In one sentence, what's this patient's diagnosis? Cite the filename.")
        page.click("button:has-text('Send')")

        # Wait for at least one assistant bubble to appear (chat container has
        # role-styled bubbles; assistant bubbles use bg-slate-100).
        try:
            page.wait_for_selector(
                "div.bg-slate-100.text-slate-800",
                timeout=60_000,
            )
        except Exception:
            page.screenshot(path=f"{SCREENSHOT_DIR}/04-no-assistant.png")
            print("FAIL: no assistant message after 60s")
            for line in log[-30:]:
                print(f"  [browser] {line}")
            return 1

        # Give it a moment to stream the full text + result.
        time.sleep(8)
        page.screenshot(path=f"{SCREENSHOT_DIR}/04-chat.png")

        # Pull final visible chat text for the report.
        chat_text = page.evaluate(
            """() => {
              const bubbles = document.querySelectorAll(
                'div.bg-slate-100.text-slate-800'
              );
              return Array.from(bubbles).map(b => b.innerText).join('\\n---\\n');
            }"""
        )

        print("PASS")
        print(f"  patient list:       Patient 001 + Patient 002 visible")
        print(f"  note tabs work:     ct_chest -> oncology_consult -> patient002 -> back")
        print(f"  chat sent + reply:  yes")
        print(f"  screenshots:        {SCREENSHOT_DIR}/")
        print(f"  assistant text (truncated to 600 chars):")
        print(f"  {chat_text[:600]}")
        if len(log) > 0:
            print(f"  browser console:    {len(log)} entries (last 5):")
            for line in log[-5:]:
                print(f"    {line}")

        browser.close()
        return 0


if __name__ == "__main__":
    sys.exit(main())
