"""CLI entry point for the NER skill via the Claude Agent SDK."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

from .budget import BudgetExceeded
from .council import (
    CouncilConfig,
    DEFAULT_CLAUDE_COUNCIL_ROLE,
    DEFAULT_CODEX_COUNCIL_ROLE,
    run_council,
)
from .ner_runner import (
    DEFAULT_PROJECT_ROOT,
    NerConfig,
    NerResult,
    run_ner_skill,
)
from .pricing import estimate_cost_usd
from .providers import resolve_model


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="claude-agent",
        description="Claude-agent repo tools: NER runner plus multi-agent council",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    ner_parser = subparsers.add_parser(
        "ner",
        help="Run the NER skill on a single (note_id, text) pair",
    )
    _add_ner_args(ner_parser)

    council_parser = subparsers.add_parser(
        "council",
        help="Run a structured Claude + Codex discussion over a repo snapshot",
    )
    _add_council_args(council_parser)

    args = parser.parse_args()

    if args.command == "ner":
        callbacks = _build_callbacks(args.verbose)
        try:
            ner_result = _run_ner_from_args(args, callbacks)
        except BudgetExceeded as exc:
            # Distinct exit code so batch-loop wrappers can detect a budget
            # stop vs a real failure. 2 is conventional for "blocked by
            # policy / preconditions" (sysexits.h EX_USAGE-ish).
            print(f"[budget] {exc}", file=sys.stderr)
            sys.exit(2)
        _emit_ner_result(ner_result, as_json=args.json)
        if ner_result.agent_result.is_error:
            sys.exit(1)
        return
    if args.command == "council":
        result = asyncio.run(_run_council_from_args(args))
        print(f"session_dir={result.session_dir}")
        print(f"manifest={result.manifest_path}")
        print(f"transcript={result.transcript_path}")
        print(f"summary={result.summary_path}")
        return


def _build_callbacks(verbose: bool) -> dict[str, object]:
    callbacks: dict[str, object] = {}
    if verbose:
        callbacks["on_assistant_text"] = lambda text: print(f"[assistant] {text[:200]}", file=sys.stderr)
        callbacks["on_thinking"] = lambda text: print(f"[thinking] {text[:500]}", file=sys.stderr)
        callbacks["on_tool_use"] = lambda name, inp: print(f"[tool] {name} {inp}", file=sys.stderr)
        callbacks["on_stderr"] = lambda line: print(f"[stderr] {line}", file=sys.stderr)
    return callbacks


# ------------------------ ner (single-shot) ------------------------

def _add_ner_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--note-id", required=True, help="Note identifier embedded in the prompt")
    parser.add_argument(
        "--person-id", default=None,
        help="Optional patient/person identifier associated with this note",
    )
    text_source = parser.add_mutually_exclusive_group(required=True)
    text_source.add_argument(
        "--text", default=None,
        help="Inline abstract / note text to annotate (alternative to --text-file)",
    )
    text_source.add_argument(
        "--text-file", default=None,
        help="Path to a UTF-8 file whose contents are the text to annotate",
    )
    parser.add_argument(
        "--data-root", required=True,
        help="Directory containing concepts.json (typically ./ontology). Injected into "
             "ner_mcp via --data-root.",
    )
    parser.add_argument(
        "--output-root", required=True,
        help="Output directory for the NER JSON. Passed to write_ner.py via --output-root.",
    )
    parser.add_argument("--model", default=None, help="Claude model override")
    parser.add_argument("--max-turns", type=int, default=200, help="Agent max turns")
    parser.add_argument(
        "--max-budget", type=float, default=5.0,
        help="Cost cap in USD per task (default 5.0)",
    )
    parser.add_argument(
        "--total-budget", type=float, default=50.0,
        help="Cumulative cost cap in USD across all runs sharing the same "
             "budget state file (default 50.0). The runner refuses to start "
             "a case if the prior cumulative + --max-budget would exceed this.",
    )
    parser.add_argument(
        "--budget-state-file", default=None,
        help="JSON state file tracking cumulative cost. Default: "
             "<output-root>/.budget_state.json — share it across invocations "
             "to enforce a batch-wide cap. Delete to reset.",
    )
    parser.add_argument(
        "--verbose", "-v", action="store_true",
        help="Print assistant and tool events to stderr",
    )
    parser.add_argument("--json", action="store_true", help="Print the final result as JSON")


def _run_ner_from_args(
    args: argparse.Namespace, callbacks: dict[str, object]
) -> NerResult:
    if args.text_file:
        text_path = Path(args.text_file).expanduser().resolve()
        if not text_path.is_file():
            raise SystemExit(f"--text-file does not exist: {text_path}")
        text = text_path.read_text(encoding="utf-8")
    else:
        text = args.text

    config = NerConfig(
        note_id=args.note_id,
        text=text,
        person_id=args.person_id,
        data_root=Path(args.data_root).expanduser().resolve(),
        output_root=Path(args.output_root).expanduser().resolve(),
        project_root=DEFAULT_PROJECT_ROOT.resolve(),
        model=args.model,
        max_turns=args.max_turns,
        max_budget_usd=args.max_budget,
        total_budget_usd=args.total_budget,
        budget_state_file=(
            Path(args.budget_state_file).expanduser().resolve()
            if args.budget_state_file else None
        ),
    )
    return run_ner_skill(config, **callbacks)


def _emit_ner_result(result: NerResult, *, as_json: bool) -> None:
    if as_json:
        print(json.dumps(result.to_dict(), ensure_ascii=False, indent=2))
        return

    ar = result.agent_result
    status = "ERROR" if ar.is_error else "OK"
    cfg = result.config
    print(f"{status} ner  note_id={cfg.note_id}  person_id={cfg.person_id}")
    if ar.result:
        print(ar.result)
    dest = str(result.output_path) if result.output_path else "(no output file)"
    print(f"  → {dest}")
    # Use the same provider-aware estimator the JSON augmenter uses, so the
    # terminal cost matches the file. Falls back to the SDK's Anthropic-priced
    # number when the model isn't in our price table.
    resolved_model = cfg.model or resolve_model()
    cost_estimated = estimate_cost_usd(resolved_model, ar.usage)
    if cost_estimated is not None:
        cost_str = f"${cost_estimated:.4f} (estimated for {resolved_model})"
    else:
        cost_str = f"${ar.cost_usd:.4f} (SDK Anthropic-priced; {resolved_model} not in price table)"
    print(
        f"\n--- Cost: {cost_str} | Turns: {ar.turns} | "
        f"Duration: {ar.duration_ms}ms ---",
        file=sys.stderr,
    )


def _add_council_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--task",
        required=True,
        help="Shared task for Claude and Codex to discuss",
    )
    parser.add_argument(
        "--cwd",
        default=".",
        help="Repository root to snapshot and discuss (default: current directory)",
    )
    parser.add_argument(
        "--output-root",
        default="results/council",
        help="Directory where council session artifacts are written",
    )
    parser.add_argument(
        "--rounds",
        type=int,
        default=2,
        help="Number of exchange rounds to run (default: 2)",
    )
    parser.add_argument(
        "--focus",
        action="append",
        default=[],
        help="Repo-relative file or directory to include in the snapshot (repeatable)",
    )
    parser.add_argument(
        "--max-file-chars",
        type=int,
        default=12_000,
        help="Per-focus-file character budget before truncation (default: 12000)",
    )
    parser.add_argument("--claude-model", default=None, help="Optional Claude model override")
    parser.add_argument("--codex-model", default=None, help="Optional Codex model override")
    parser.add_argument("--claude-bin", default="claude", help="Claude CLI binary or absolute path")
    parser.add_argument("--codex-bin", default="codex", help="Codex CLI binary or absolute path")
    parser.add_argument(
        "--claude-role",
        default=DEFAULT_CLAUDE_COUNCIL_ROLE,
        help="Custom role prompt for Claude",
    )
    parser.add_argument(
        "--codex-role",
        default=DEFAULT_CODEX_COUNCIL_ROLE,
        help="Custom role prompt for Codex",
    )


async def _run_council_from_args(args: argparse.Namespace):
    config = CouncilConfig(
        task=args.task,
        cwd=Path(args.cwd).expanduser(),
        output_root=Path(args.output_root).expanduser(),
        rounds=args.rounds,
        focus_paths=tuple(args.focus or []),
        max_file_chars=args.max_file_chars,
        claude_model=args.claude_model,
        codex_model=args.codex_model,
        claude_bin=args.claude_bin,
        codex_bin=args.codex_bin,
        claude_role=args.claude_role,
        codex_role=args.codex_role,
    )
    return await run_council(config)


if __name__ == "__main__":
    main()
