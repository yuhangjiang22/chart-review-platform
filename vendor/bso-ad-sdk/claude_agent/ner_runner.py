"""Single-shot orchestrator for the `ner` skill + MCP.

Mirrors the structure of `auditing_runner.py` — one invocation handles
exactly one (note_id, text) pair, runs the agent, and writes a
single JSON file via `write_ner.py`.

Owns its own:
  * `build_ner_prompt` — the prompt sent to the agent
  * `_load_mcp_servers` — parses skill-local `.mcp.json` and injects
    `--data-root=<resolved path>`
  * `_precheck` — fails fast on missing skill / MCP deps / invalid paths
  * `_check_mcp_server_importable` — same dep-probe pattern as auditing
"""

from __future__ import annotations

import json
import logging
import re
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable

from ._skill_utils import (
    build_run_clauses,
    check_mcp_server_importable,
    load_mcp_servers,
)
from .review.ontology import read_ontology_version
from .budget import BudgetExceeded, BudgetGuard
from .core import AgentResult, run_agent
from .pricing import estimate_cost_usd
from .providers import resolve_model
from .event_log import EventLog

# Repository root — the parent of this package directory. Used as the agent's
# cwd so the SDK auto-discovers `.claude/skills/` from a stable path,
# regardless of where the CLI was invoked from.
DEFAULT_PROJECT_ROOT = Path(__file__).resolve().parents[1]

logger = logging.getLogger("claude_agent_framework")

_FILENAME_SAFE_RE = re.compile(r"[^A-Za-z0-9._-]")


def _sanitize(value: str) -> str:
    """Mirror the sanitization in `write_ner.py` so the runner can locate
    the file the script will produce."""
    return _FILENAME_SAFE_RE.sub("-", value)


@dataclass(slots=True)
class NerConfig:
    """Config for a single NER run.

    Mirrors the inputs in `.claude/skills/bso-ad/SKILL.md`. `data_root` is the
    directory containing `concepts.json`. When omitted it falls back to
    `<benchmark_root>/ontology` (the layout produced by
    `ontology/scripts/build_concepts.py`). `output_root` likewise falls back
    to `<benchmark_root>/results/ner`.
    """

    note_id: str
    text: str
    person_id: str | None = None
    benchmark_root: Path | None = None
    data_root: Path | None = None
    output_root: Path | None = None
    project_root: Path = field(default_factory=lambda: DEFAULT_PROJECT_ROOT.resolve())
    model: str | None = None
    max_turns: int = 200
    max_budget_usd: float = 5.0
    # Cumulative cap shared across invocations against the same state file.
    # Defends batch loops (`for i in $(seq 1 1000); do ./run_docker.sh ner ...`)
    # from accumulating into a $200 surprise. Disable by setting to 0 or a
    # very large value.
    total_budget_usd: float = 50.0
    # When None, derived as <output_root>/.budget_state.json — share the file
    # across runs that target the same output dir, point elsewhere to keep
    # separate ledgers per workstream.
    budget_state_file: Path | None = None


@dataclass(slots=True)
class NerResult:
    config: NerConfig
    prompt: str
    agent_result: AgentResult
    output_path: Path | None

    def to_dict(self) -> dict[str, Any]:
        cfg = asdict(self.config)
        cfg["benchmark_root"] = str(self.config.benchmark_root) if self.config.benchmark_root else None
        cfg["data_root"] = str(self.config.data_root) if self.config.data_root else None
        cfg["output_root"] = str(self.config.output_root) if self.config.output_root else None
        cfg["project_root"] = str(self.config.project_root)
        return {
            "config": cfg,
            "prompt": self.prompt,
            "result": self.agent_result.result,
            "cost_usd": self.agent_result.cost_usd,
            "turns": self.agent_result.turns,
            "duration_ms": self.agent_result.duration_ms,
            "session_id": self.agent_result.session_id,
            "is_error": self.agent_result.is_error,
            "output_path": str(self.output_path) if self.output_path else None,
        }


def _ner_run_clauses(
    model: str,
    output_root: Path,
    source_text_file: Path,
    data_root: Path | None = None,
) -> str:
    """Boilerplate appended to every NER prompt. Pins --output-root, --model,
    --source-text-file, and --ontology-version."""
    concepts_path = (data_root or DEFAULT_PROJECT_ROOT / "ontology") / "concepts.json"
    return build_run_clauses(
        model=model,
        output_root=output_root,
        write_script_relpath=".claude/skills/bso-ad/scripts/write_ner.py",
        extra_args={
            "--source-text-file": source_text_file,
            "--ontology-version": read_ontology_version(concepts_path),
        },
    )


def build_ner_prompt(
    model: str,
    note_id: str,
    text: str,
    output_root: Path,
    source_text_file: Path,
    data_root: Path | None = None,
) -> str:
    """Build the single-shot NER prompt sent to the agent."""
    body = (
        f"Please run NER on note_id={note_id}. "
        f"For each candidate entity span: pick an entity_type from the "
        f"supported BSO-AD set (call `list_entity_types`); map the span to a "
        f"canonical concept_name via `normalize_to_ontology`; resolve its "
        f"authoritative character offsets via `locate_in_source` (DO NOT "
        f"guess offsets — LLM character arithmetic is unreliable). Spans "
        f"that cannot be mapped should be tagged status=\"novel_candidate\". "
        f"When done, invoke `write_ner.py` with the full --entities-json list "
        f"including the start/end values returned by `locate_in_source`.\n\n"
        f"The source-text sidecar that `locate_in_source` and `write_ner.py` "
        f"need is ALREADY pre-written by the runner at:\n"
        f"  {source_text_file}\n"
        f"Do NOT try to write this file yourself — it exists. Just reference "
        f"it via the --source-text-file arg passed in the write_ner.py call "
        f"below. Do NOT Read this file either — the full note text is already "
        f"inlined below, `locate_in_source` reads the sidecar internally via "
        f"its --source-text-file pin, and the `Read` tool is disabled on this "
        f"run so the call will be rejected.\n\n"
        f"Text:\n\"\"\"\n{text}\n\"\"\""
    )
    return body + _ner_run_clauses(model, output_root, source_text_file, data_root=data_root)


def run_ner_skill(
    config: NerConfig,
    *,
    on_assistant_text: Callable[[str], None] | None = None,
    on_thinking: Callable[[str], None] | None = None,
    on_tool_use: Callable[[str, dict], None] | None = None,
    on_stderr: Callable[[str], None] | None = None,
) -> NerResult:
    """Run the NER skill once for the given config."""
    data_root, output_root = _resolve_paths(config)

    _precheck(config, data_root, output_root)

    # Persist the source text alongside the result file. Both ner_mcp's
    # locate_in_source AND write_ner.py's offset validator need to read the
    # exact bytes the agent annotated, and the runner is the single source of
    # truth (`config.text` may be inline or have come from --text-file with
    # arbitrary encoding). Sidecar lives next to the JSON output for trivial
    # post-hoc auditing — same naming convention as .events.jsonl.
    source_text_file = _source_text_path(output_root, config)
    source_text_file.parent.mkdir(parents=True, exist_ok=True)
    source_text_file.write_text(config.text, encoding="utf-8")

    mcp_servers = _load_mcp_servers(
        config.project_root, data_root, source_text_file,
    )
    resolved_model = config.model or resolve_model()

    prompt = build_ner_prompt(
        model=resolved_model,
        note_id=config.note_id,
        text=config.text,
        output_root=output_root,
        source_text_file=source_text_file,
        data_root=data_root,
    )

    events_path = _events_path(output_root, config)
    common = {
        "note_id": config.note_id,
        "person_id": config.person_id,
        "model": resolved_model,
    }
    turn_counter = [0]

    budget_state_file = config.budget_state_file or BudgetGuard.default_state_file_for(output_root)
    budget_guard = BudgetGuard(
        state_file=budget_state_file,
        total_budget_usd=config.total_budget_usd,
    )

    with EventLog(events_path, common=common) as log:
        # Pre-flight budget check. Raises BudgetExceeded → caller exits non-zero.
        # We log the check (and any abort) so the events.jsonl is the authoritative
        # record of why a batch stopped.
        try:
            budget_state = budget_guard.check_or_raise(config.max_budget_usd)
        except BudgetExceeded as exc:
            log.emit("budget_exceeded", reason=str(exc))
            raise
        # Always print to stderr — users running through run_docker.sh need
        # the budget banner visible even without --verbose so a stuck batch
        # is obvious from the terminal scrollback.
        print(
            f"[budget] ${budget_state.total_cost_usd:.4f} / "
            f"${config.total_budget_usd:.4f} used "
            f"({budget_state.runs} prior runs) before this case",
            file=sys.stderr,
        )

        log.emit(
            "run_start",
            max_turns=config.max_turns,
            max_budget_usd=config.max_budget_usd,
            total_budget_usd=config.total_budget_usd,
            total_used_so_far=budget_state.total_cost_usd,
            prior_runs=budget_state.runs,
            data_root=str(data_root),
            output_root=str(output_root),
        )

        def _hook_tool_use(name: str, inp: dict) -> None:
            turn_counter[0] += 1
            log.emit(
                "tool_call",
                turn=turn_counter[0],
                tool_name=name,
                input_preview=str(inp)[:300],
            )
            if on_tool_use is not None:
                on_tool_use(name, inp)

        try:
            agent_result = run_agent(
                prompt=prompt,
                cwd=str(config.project_root),
                model=resolved_model,
                max_turns=config.max_turns,
                max_budget_usd=config.max_budget_usd,
                setting_sources=["project"],
                mcp_servers=mcp_servers,
                # PHI hygiene: NER never edits files in-place — every output
                # goes through the bso-ad skill's `write_ner.py` CLI (invoked
                # via Bash). Edit / Write are off by core.py default. The
                # Bash allow-list narrows the surviving Bash channel to the
                # one CLI the skill actually needs, so a prompt-injected
                # `curl exfil` or `env | base64` can't get out.
                allowed_bash_patterns=[
                    "python3 .claude/skills/bso-ad/scripts/write_ner.py *",
                ],
                # Read is off because the note text is already inlined in
                # `build_ner_prompt` and the source-text sidecar is read by
                # `locate_in_source` internally (via --source-text-file). The
                # agent has nothing legitimate to Read; observed runs hit
                # the sidecar 90% of notes redundantly. Blocking saves the
                # re-injected ~1-15 KB / note of duplicate cache_read.
                allow_read=False,
                on_assistant_text=on_assistant_text,
                on_thinking=on_thinking,
                on_tool_use=_hook_tool_use,
                on_stderr=on_stderr,
            )
        except Exception as exc:
            log.emit(
                "error",
                error_kind=type(exc).__name__,
                error_msg=str(exc)[:500],
            )
            raise

        output_path = _find_output_file(output_root, config)
        if output_path is not None:
            _augment_output_with_runtime_metrics(output_path, agent_result, resolved_model)

        cost_estimated = estimate_cost_usd(resolved_model, agent_result.usage)
        # Record cost regardless of success/error — the request still hit
        # the upstream provider and incurred billing. Skipping on error
        # would make a flaky batch silently overshoot the budget ceiling.
        post_state = budget_guard.record(cost_estimated or 0.0)
        print(
            f"[budget] ${post_state.total_cost_usd:.4f} / "
            f"${config.total_budget_usd:.4f} used "
            f"({post_state.runs} total runs) after this case "
            f"(+${(cost_estimated or 0.0):.4f})",
            file=sys.stderr,
        )
        if agent_result.is_error:
            log.emit(
                "error",
                error_kind="agent_returned_error",
                error_msg=(agent_result.result or "")[:500],
            )
        log.emit(
            "run_end",
            turns=agent_result.turns,
            duration_ms=agent_result.duration_ms,
            usage=agent_result.usage,
            cost_usd_estimated=cost_estimated,
            total_used_after=post_state.total_cost_usd,
            total_runs_after=post_state.runs,
            is_error=agent_result.is_error,
            output_path=str(output_path) if output_path else None,
        )

    return NerResult(
        config=config,
        prompt=prompt,
        agent_result=agent_result,
        output_path=output_path,
    )


SKILL_DIR = Path(".claude") / "skills" / "bso-ad"
SKILL_MCP_JSON = SKILL_DIR / ".mcp.json"
SKILL_MCP_SCRIPT = SKILL_DIR / "scripts" / "mcp" / "ner_mcp.py"

_DEPS_PROBE = (
    "import fastmcp, pydantic  # noqa: F401\n"
    "print('ok')"
)


def _resolve_paths(config: NerConfig) -> tuple[Path, Path]:
    """Resolve data_root / output_root, falling back to benchmark_root defaults."""
    data_root = config.data_root
    output_root = config.output_root
    if data_root is None or output_root is None:
        if config.benchmark_root is None:
            raise ValueError(
                "Provide either --benchmark-root, or both --data-root and "
                "--output-root explicitly."
            )
        if data_root is None:
            data_root = config.benchmark_root / "ontology"
        if output_root is None:
            output_root = config.benchmark_root / "results" / "ner"
    return data_root.expanduser().resolve(), output_root.expanduser().resolve()


def _load_mcp_servers(
    project_root: Path,
    data_root: Path,
    source_text_file: Path,
) -> dict:
    """Parse skill-local `.mcp.json` and inject `--data-root=<abs>` plus
    `--source-text-file=<abs>` so `locate_in_source` can resolve offsets."""
    return load_mcp_servers(
        project_root=project_root,
        mcp_json_relpath=SKILL_MCP_JSON,
        runtime_args={
            "--data-root": data_root,
            "--source-text-file": source_text_file,
        },
    )


def _precheck(config: NerConfig, data_root: Path, output_root: Path) -> None:
    """Fail fast with clear messages before spending any API cost."""
    root = config.project_root

    skill = root / SKILL_DIR / "SKILL.md"
    if not skill.is_file():
        raise FileNotFoundError(f"NER SKILL.md not found at {skill}.")

    mcp_json = root / SKILL_MCP_JSON
    if not mcp_json.is_file():
        raise FileNotFoundError(f".mcp.json not found at {mcp_json}.")

    _check_mcp_server_importable(root)

    if config.benchmark_root is not None and not config.benchmark_root.is_dir():
        raise FileNotFoundError(
            f"benchmark_root does not exist or is not a directory: "
            f"{config.benchmark_root}"
        )

    if not data_root.is_dir():
        raise FileNotFoundError(
            f"NER data root does not exist: {data_root}. "
            f"Pass --data-root or populate <benchmark_root>/ontology."
        )

    ontology_path = data_root / "concepts.json"
    if not ontology_path.is_file():
        raise FileNotFoundError(
            f"Ontology JSON not found at {ontology_path}. Generate it with "
            f"`python ontology/scripts/build_concepts.py` before running this skill."
        )

    output_root.mkdir(parents=True, exist_ok=True)
    probe = output_root / ".writable_probe"
    try:
        probe.touch()
        probe.unlink()
    except OSError as exc:
        raise PermissionError(
            f"Output directory is not writable: {output_root} ({exc})"
        ) from exc

    if not config.note_id.strip():
        raise ValueError("note_id is required and must be non-empty")
    if not config.text.strip():
        raise ValueError("text is required and must be non-empty")


def _check_mcp_server_importable(project_root: Path) -> None:
    """Thin wrapper around the shared probe utility."""
    check_mcp_server_importable(
        project_root=project_root,
        mcp_script_relpath=SKILL_MCP_SCRIPT,
        deps_probe=_DEPS_PROBE,
        skip_env_var="NER_MCP_SKIP_PROBE",
    )


def _events_path(output_root: Path, config: NerConfig) -> Path:
    """Sidecar JSONL path keyed solely by note_id."""
    return output_root / f"{_sanitize(config.note_id)}_events.jsonl"


def _source_text_path(output_root: Path, config: NerConfig) -> Path:
    """Hidden scratch file holding the exact bytes the agent annotated.

    Lives under `_intermediate/` so public globs over `results/ner/` skip it
    entirely. Leading dot keeps it out of casual directory listings too. One
    file per note_id keeps the dir tidy when re-running with multiple models.
    """
    return output_root / "_intermediate" / f".source_{_sanitize(config.note_id)}.txt"


def _find_output_file(output_root: Path, config: NerConfig) -> Path | None:
    """Compute the deterministic file path write_ner.py will produce.

    Returns the path if it now exists on disk, else None — None signals the
    agent likely failed to invoke write_ner.py (caller can flag is_error).
    """
    expected = output_root / f"{_sanitize(config.note_id)}.json"
    return expected if expected.is_file() else None


def _augment_output_with_runtime_metrics(
    path: Path, agent_result: AgentResult, resolved_model: str
) -> None:
    """Inject runtime metrics into the agent's write_ner.py output.

    Adds `usage`, `cost_usd_estimated`, `turns`, `duration_ms` keys, plus
    `is_partial: true` when the agent reported an error or wrote a payload
    with no entities (so downstream readers can filter).

    The agent can't self-report runtime metrics (they only exist once
    ResultMessage arrives), so the runner post-processes the JSON the agent
    wrote. Idempotent: overwrites these keys without disturbing entities or
    skill_version.

    `cost_usd_estimated` uses the local `pricing` table — this matches the
    actual provider (Azure / OpenAI / Anthropic) for the resolved model,
    unlike the SDK's `total_cost_usd` which always assumes Anthropic Sonnet
    pricing and is misleading when requests go through `claude_proxy` to a
    third-party provider.
    """
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("Cannot augment %s with runtime metrics: %s", path, exc)
        return
    entities = payload.get("entities")
    is_partial = (
        agent_result.is_error
        or not isinstance(entities, list)
        or len(entities) == 0
    )
    payload["usage"] = agent_result.usage
    payload["cost_usd_estimated"] = estimate_cost_usd(resolved_model, agent_result.usage)
    payload["turns"] = agent_result.turns
    payload["duration_ms"] = agent_result.duration_ms
    if is_partial:
        payload["is_partial"] = True
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
