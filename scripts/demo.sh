#!/usr/bin/env bash
# End-to-end demo of the chart review platform.
#
#   Step 1: install Python deps in a local venv
#   Step 2: compile lung_cancer_phenotype.md → compiled_task.json
#   Step 3: validate the compiled task and the bundled review record
#   Step 4: run the faithfulness check on the bundled review record
#   Step 5: re-evaluate derived fields (deterministic)
#   Step 6: launch a static file server on the UI

set -euo pipefail

# Script lives at <platform-root>/scripts/demo.sh; ROOT is the parent.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIB="$ROOT/lib"
VENV="$ROOT/.venv"
TASKS="$ROOT/tasks"
CONTRACTS="$ROOT/contracts"
UI="$ROOT/ui"
COMPILED="$ROOT/build/compiled_task.json"
NOTES_DIR="$UI/public/fixtures/notes"
REVIEW_RECORD="$UI/public/fixtures/review_record.json"

PORT="${PORT:-5173}"

mkdir -p "$ROOT/build"

echo
echo "═══════════════════════════════════════════════════════════════════════"
echo " Chart Review Platform — end-to-end demo"
echo "═══════════════════════════════════════════════════════════════════════"

# ── Step 1: venv + deps ───────────────────────────────────────────────────
echo
echo "▸ Step 1 — Python environment"
if [ ! -d "$VENV" ]; then
  python3 -m venv "$VENV"
fi
# shellcheck source=/dev/null
source "$VENV/bin/activate"
pip install --quiet --upgrade pip
pip install --quiet -e "$LIB"
# macOS: clear UF_HIDDEN on the editable-install .pth file. Some sync daemons
# (Spotlight, iCloud) auto-hide files starting with `__`, which causes Python
# to skip the .pth and lose the editable install. Idempotent; harmless on Linux.
if command -v chflags >/dev/null 2>&1; then
  chflags -R nohidden "$VENV/lib" 2>/dev/null || true
fi
echo "  venv: $VENV"

# ── Step 2: compile the markdown task ─────────────────────────────────────
echo
echo "▸ Step 2 — Compile lung_cancer_phenotype.md → compiled_task.json"
chart-review compile "$TASKS/lung_cancer_phenotype.md" -o "$COMPILED" --validate \
  --contracts "$CONTRACTS"

# ── Step 3: validate the bundled review record ────────────────────────────
echo
echo "▸ Step 3 — Validate the bundled review_record.json"
chart-review validate-record "$REVIEW_RECORD" --contracts "$CONTRACTS"

# ── Step 4: faithfulness check ────────────────────────────────────────────
echo
echo "▸ Step 4 — Faithfulness check (verifying evidence offsets against note text)"
chart-review faithfulness "$REVIEW_RECORD" --notes-dir "$NOTES_DIR" || true

# ── Step 5: derive ────────────────────────────────────────────────────────
echo
echo "▸ Step 5 — Re-evaluate derived fields + cross-criterion alerts"
chart-review derive "$COMPILED" "$REVIEW_RECORD"

# ── Step 6: launch UI ─────────────────────────────────────────────────────
echo
echo "▸ Step 6 — Launching static server for the reviewer UI"
echo "  serving:   $ROOT  (so both ui/ and corpus/ are reachable)"
echo
echo "   Open in your browser:"
echo
echo "     http://localhost:$PORT/ui/Chart%20Review.html#/case/patient_neg_hard_01"
echo
echo "   (Ctrl-C here to stop the server)"
echo
cd "$ROOT"
exec python3 -m http.server "$PORT" --bind 127.0.0.1
