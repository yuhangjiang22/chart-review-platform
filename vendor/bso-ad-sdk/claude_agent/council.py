"""Structured multi-agent discussion runner for Claude Code and Codex.

The MVP is intentionally discussion-first: it snapshots repository context,
asks both agents to reason over the same snapshot, and records a round-based
dialogue. That avoids concurrent write conflicts while still giving the user a
real collaboration artifact they can review or hand off into implementation.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import subprocess
import textwrap
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal, Protocol, Sequence

from pydantic import BaseModel, Field, ValidationError

DEFAULT_CLAUDE_COUNCIL_ROLE = (
    "Act as the skeptical reviewer. Pressure-test assumptions, spot hidden "
    "risks, and ask the questions that might otherwise be missed."
)

DEFAULT_CODEX_COUNCIL_ROLE = (
    "Act as the implementation-minded engineer. Turn ideas into concrete "
    "steps, highlight execution tradeoffs, and keep the plan grounded."
)


class CouncilResponse(BaseModel):
    """Structured payload each agent must return every round."""

    summary: str
    findings: list[str] = Field(default_factory=list)
    proposed_actions: list[str] = Field(default_factory=list)
    concerns: list[str] = Field(default_factory=list)
    questions_for_peer: list[str] = Field(default_factory=list)
    answers_for_peer: list[str] = Field(default_factory=list)
    confidence: Literal["low", "medium", "high"] = "medium"


@dataclass(frozen=True)
class CouncilConfig:
    task: str
    cwd: Path
    output_root: Path
    rounds: int = 2
    focus_paths: tuple[str, ...] = ()
    max_file_chars: int = 12_000
    claude_model: str | None = None
    codex_model: str | None = None
    claude_bin: str = "claude"
    codex_bin: str = "codex"
    claude_role: str = DEFAULT_CLAUDE_COUNCIL_ROLE
    codex_role: str = DEFAULT_CODEX_COUNCIL_ROLE


@dataclass(frozen=True)
class CouncilRunResult:
    session_dir: Path
    manifest_path: Path
    transcript_path: Path
    summary_path: Path
    messages_path: Path


@dataclass(frozen=True)
class CompletedInvocation:
    command: tuple[str, ...]
    stdout: str
    stderr: str
    exit_code: int
    duration_ms: int


@dataclass(frozen=True)
class CouncilMessage:
    agent_name: str
    round_index: int
    role_prompt: str
    response: CouncilResponse
    raw_text: str
    stderr_text: str
    duration_ms: int

    def to_record(self) -> dict:
        return {
            "agent": self.agent_name,
            "round": self.round_index,
            "role_prompt": self.role_prompt,
            "duration_ms": self.duration_ms,
            "response": self.response.model_dump(),
            "raw_text": self.raw_text,
            "stderr_text": self.stderr_text,
        }


class CouncilClient(Protocol):
    name: str
    role_prompt: str

    async def run_turn(
        self,
        *,
        prompt: str,
        cwd: Path,
        round_index: int,
        session_dir: Path,
        schema_path: Path,
    ) -> CouncilMessage:
        ...


class ClaudeCouncilClient:
    name = "claude"

    def __init__(
        self,
        *,
        binary: str,
        model: str | None,
        role_prompt: str,
    ) -> None:
        self.binary = binary
        self.model = model
        self.role_prompt = role_prompt

    async def run_turn(
        self,
        *,
        prompt: str,
        cwd: Path,
        round_index: int,
        session_dir: Path,
        schema_path: Path,
    ) -> CouncilMessage:
        raw_dir = session_dir / self.name
        raw_dir.mkdir(parents=True, exist_ok=True)
        raw_path = raw_dir / f"round_{round_index:02d}_raw.json"
        stderr_path = raw_dir / f"round_{round_index:02d}_stderr.txt"

        args = [
            self.binary,
            "-p",
            "--output-format",
            "text",
            "--json-schema",
            schema_path.read_text(encoding="utf-8"),
            "--tools",
            "",
            "--disable-slash-commands",
            "--no-session-persistence",
        ]
        if self.model:
            args.extend(["--model", self.model])

        invocation = await _run_subprocess(args=args, prompt=prompt, cwd=cwd)
        raw_text = invocation.stdout.strip()
        raw_path.write_text(raw_text + ("\n" if raw_text else ""), encoding="utf-8")
        stderr_path.write_text(invocation.stderr, encoding="utf-8")
        response = parse_council_response(raw_text, source="claude")
        return CouncilMessage(
            agent_name=self.name,
            round_index=round_index,
            role_prompt=self.role_prompt,
            response=response,
            raw_text=raw_text,
            stderr_text=invocation.stderr,
            duration_ms=invocation.duration_ms,
        )


class CodexCouncilClient:
    name = "codex"

    def __init__(
        self,
        *,
        binary: str,
        model: str | None,
        role_prompt: str,
    ) -> None:
        self.binary = binary
        self.model = model
        self.role_prompt = role_prompt
        self._prepared_home: Path | None = None

    async def run_turn(
        self,
        *,
        prompt: str,
        cwd: Path,
        round_index: int,
        session_dir: Path,
        schema_path: Path,
    ) -> CouncilMessage:
        raw_dir = session_dir / self.name
        raw_dir.mkdir(parents=True, exist_ok=True)
        raw_path = raw_dir / f"round_{round_index:02d}_raw.json"
        stderr_path = raw_dir / f"round_{round_index:02d}_stderr.txt"
        codex_home = self._prepared_home or _prepare_codex_home(session_dir)
        self._prepared_home = codex_home

        args = [
            self.binary,
            "--disable",
            "plugins",
            "-a",
            "never",
            "exec",
            "-C",
            str(cwd),
            "-s",
            "read-only",
            "--skip-git-repo-check",
            "--ephemeral",
            "--ignore-user-config",
            "--color",
            "never",
            "--output-schema",
            str(schema_path),
            "-o",
            str(raw_path),
        ]
        if self.model:
            args.extend(["-m", self.model])

        env = os.environ.copy()
        env["CODEX_HOME"] = str(codex_home)
        invocation = await _run_subprocess(args=args, prompt=prompt, cwd=cwd, env=env)
        if raw_path.exists():
            raw_text = raw_path.read_text(encoding="utf-8").strip()
        else:
            raw_text = invocation.stdout.strip()
            raw_path.write_text(raw_text + ("\n" if raw_text else ""), encoding="utf-8")
        stderr_path.write_text(invocation.stderr, encoding="utf-8")
        response = parse_council_response(raw_text, source="codex")
        return CouncilMessage(
            agent_name=self.name,
            round_index=round_index,
            role_prompt=self.role_prompt,
            response=response,
            raw_text=raw_text,
            stderr_text=invocation.stderr,
            duration_ms=invocation.duration_ms,
        )


def parse_council_response(raw_text: str, *, source: str) -> CouncilResponse:
    """Parse a CouncilResponse, tolerating a small amount of wrapper text."""

    text = raw_text.strip()
    if not text:
        raise RuntimeError(f"{source} returned an empty response")
    try:
        return CouncilResponse.model_validate_json(text)
    except ValidationError:
        pass
    except json.JSONDecodeError:
        pass

    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise RuntimeError(
            f"{source} did not return valid JSON. First 200 chars:\n{text[:200]}"
        )
    candidate = text[start : end + 1]
    try:
        return CouncilResponse.model_validate_json(candidate)
    except (ValidationError, json.JSONDecodeError) as exc:
        raise RuntimeError(
            f"{source} returned malformed CouncilResponse JSON: {exc}\n"
            f"First 200 chars:\n{text[:200]}"
        ) from exc


async def run_council(
    config: CouncilConfig,
    *,
    clients: Sequence[CouncilClient] | None = None,
) -> CouncilRunResult:
    """Run the multi-agent council and persist the full transcript."""

    config = _normalize_config(config)
    session_dir = _make_session_dir(config.output_root)
    repo_context = build_repo_context(
        cwd=config.cwd,
        focus_paths=config.focus_paths,
        max_file_chars=config.max_file_chars,
    )
    (session_dir / "repo_context.md").write_text(repo_context, encoding="utf-8")

    schema_path = session_dir / "response_schema.json"
    schema_path.write_text(
        json.dumps(CouncilResponse.model_json_schema(), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    active_clients = list(clients or _default_clients(config))
    history: list[CouncilMessage] = []

    for round_index in range(1, config.rounds + 1):
        tasks = []
        for client in active_clients:
            prompt = build_turn_prompt(
                agent_name=client.name,
                role_prompt=client.role_prompt,
                task=config.task,
                repo_context=repo_context,
                history=history,
                round_index=round_index,
                total_rounds=config.rounds,
            )
            prompt_path = session_dir / client.name / f"round_{round_index:02d}_prompt.md"
            prompt_path.parent.mkdir(parents=True, exist_ok=True)
            prompt_path.write_text(prompt, encoding="utf-8")
            tasks.append(
                client.run_turn(
                    prompt=prompt,
                    cwd=config.cwd,
                    round_index=round_index,
                    session_dir=session_dir,
                    schema_path=schema_path,
                )
            )
        history.extend(await asyncio.gather(*tasks))

    messages_path = session_dir / "messages.jsonl"
    with messages_path.open("w", encoding="utf-8") as fh:
        for item in sorted(history, key=lambda x: (x.round_index, x.agent_name)):
            fh.write(json.dumps(item.to_record(), ensure_ascii=False) + "\n")

    transcript_path = session_dir / "transcript.md"
    transcript_path.write_text(
        render_transcript(
            task=config.task,
            cwd=config.cwd,
            focus_paths=config.focus_paths,
            messages=history,
        ),
        encoding="utf-8",
    )

    summary_path = session_dir / "final_summary.md"
    summary_path.write_text(
        render_final_summary(task=config.task, messages=history),
        encoding="utf-8",
    )

    manifest = {
        "created_at": _now_iso(),
        "task": config.task,
        "cwd": str(config.cwd),
        "rounds": config.rounds,
        "focus_paths": list(config.focus_paths),
        "max_file_chars": config.max_file_chars,
        "clients": [
            {
                "name": client.name,
                "role_prompt": client.role_prompt,
            }
            for client in active_clients
        ],
        "artifacts": {
            "repo_context": str(session_dir / "repo_context.md"),
            "messages": str(messages_path),
            "transcript": str(transcript_path),
            "final_summary": str(summary_path),
            "response_schema": str(schema_path),
        },
    }
    manifest_path = session_dir / "manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    return CouncilRunResult(
        session_dir=session_dir,
        manifest_path=manifest_path,
        transcript_path=transcript_path,
        summary_path=summary_path,
        messages_path=messages_path,
    )


def build_turn_prompt(
    *,
    agent_name: str,
    role_prompt: str,
    task: str,
    repo_context: str,
    history: Sequence[CouncilMessage],
    round_index: int,
    total_rounds: int,
) -> str:
    """Build one round prompt for an agent participant."""

    peer_name = "codex" if agent_name == "claude" else "claude"
    peer_previous = [
        msg for msg in history if msg.agent_name == peer_name and msg.round_index == round_index - 1
    ]
    prior_history = _format_history(history)
    peer_block = (
        _format_message_block(peer_previous[-1])
        if peer_previous
        else "No prior message from your peer yet."
    )
    return textwrap.dedent(
        f"""
        You are {agent_name}, participating in a structured two-agent discussion about a software repository.

        Role:
        {role_prompt}

        Rules:
        - Treat this as discussion-only snapshot mode.
        - Do not propose editing files directly in this turn.
        - Base your reasoning on the repository snapshot below.
        - If something is uncertain, say so plainly instead of guessing.
        - Return exactly one JSON object matching the provided schema.
        - Keep findings concrete and action-oriented.

        Shared task:
        {task}

        Round:
        {round_index} of {total_rounds}

        Peer message from the previous round:
        {peer_block}

        Prior transcript:
        {prior_history}

        Repository snapshot:
        {repo_context}
        """
    ).strip() + "\n"


def build_repo_context(
    *,
    cwd: Path,
    focus_paths: Sequence[str],
    max_file_chars: int,
) -> str:
    """Build a bounded, reproducible snapshot of repository context."""

    sections = [
        "# Repository Snapshot",
        "",
        f"- Root: {cwd}",
    ]
    git_status = _safe_command_output(["git", "status", "--short", "--branch"], cwd=cwd)
    if git_status:
        sections.extend(
            [
                "",
                "## Git Status",
                "```text",
                git_status.rstrip(),
                "```",
            ]
        )

    sections.extend(
        [
            "",
            "## Top-level Entries",
            "```text",
            "\n".join(_top_level_entries(cwd)) or "(empty)",
            "```",
        ]
    )

    focus = list(focus_paths)
    if not focus:
        readme = cwd / "README.md"
        if readme.exists():
            focus.append("README.md")

    if focus:
        sections.append("")
        sections.append("## Focused Context")
        for raw_path in focus:
            sections.extend(
                [
                    "",
                    _render_focus_path(
                        cwd=cwd,
                        raw_path=raw_path,
                        max_file_chars=max_file_chars,
                    )
                ]
            )
    else:
        sections.extend(
            [
                "",
                "## Focused Context",
                "No focus paths were supplied. Add --focus PATH to include specific files.",
            ]
        )
    return "\n".join(sections).strip() + "\n"


def render_transcript(
    *,
    task: str,
    cwd: Path,
    focus_paths: Sequence[str],
    messages: Sequence[CouncilMessage],
) -> str:
    lines = [
        "# Agent Council Transcript",
        "",
        f"- Task: {task}",
        f"- Repository: {cwd}",
        f"- Focus paths: {', '.join(focus_paths) if focus_paths else '(default snapshot)'}",
    ]
    for msg in sorted(messages, key=lambda x: (x.round_index, x.agent_name)):
        lines.extend(
            [
                "",
                f"## Round {msg.round_index} - {msg.agent_name}",
                "",
                f"- Role: {msg.role_prompt}",
                f"- Confidence: {msg.response.confidence}",
                f"- Duration: {msg.duration_ms} ms",
                "",
                f"Summary: {msg.response.summary}",
            ]
        )
        lines.extend(_render_list_section("Findings", msg.response.findings))
        lines.extend(_render_list_section("Proposed actions", msg.response.proposed_actions))
        lines.extend(_render_list_section("Concerns", msg.response.concerns))
        lines.extend(_render_list_section("Questions for peer", msg.response.questions_for_peer))
        lines.extend(_render_list_section("Answers for peer", msg.response.answers_for_peer))
    return "\n".join(lines).strip() + "\n"


def render_final_summary(*, task: str, messages: Sequence[CouncilMessage]) -> str:
    latest = _latest_messages(messages)
    agreements = _find_agreements(latest)
    questions = []
    for msg in latest.values():
        questions.extend(msg.response.questions_for_peer)
    lines = [
        "# Agent Council Summary",
        "",
        f"Task: {task}",
        "",
        "## Latest positions",
    ]
    for agent_name in sorted(latest):
        msg = latest[agent_name]
        lines.extend(
            [
                "",
                f"### {agent_name}",
                "",
                f"Summary: {msg.response.summary}",
            ]
        )
        lines.extend(_render_list_section("Proposed actions", msg.response.proposed_actions))
        lines.extend(_render_list_section("Concerns", msg.response.concerns))
    lines.extend(
        [
            "",
            "## Auto-detected overlap",
        ]
    )
    if agreements:
        for item in agreements:
            lines.append(f"- {item}")
    else:
        lines.append("- No exact recommendation overlap detected automatically.")
    lines.extend(
        [
            "",
            "## Open questions",
        ]
    )
    if questions:
        for item in questions:
            lines.append(f"- {item}")
    else:
        lines.append("- None recorded in the latest round.")
    return "\n".join(lines).strip() + "\n"


def _render_list_section(title: str, values: Sequence[str]) -> list[str]:
    lines = ["", f"{title}:"]
    if values:
        lines.extend([f"- {value}" for value in values])
    else:
        lines.append("- None")
    return lines


def _format_history(history: Sequence[CouncilMessage]) -> str:
    if not history:
        return "No prior transcript yet."
    parts = []
    for msg in sorted(history, key=lambda x: (x.round_index, x.agent_name)):
        parts.append(_format_message_block(msg))
    return "\n\n".join(parts)


def _format_message_block(message: CouncilMessage) -> str:
    body = [
        f"{message.agent_name} round {message.round_index}",
        f"summary: {message.response.summary}",
        _format_scalar_list("findings", message.response.findings),
        _format_scalar_list("proposed_actions", message.response.proposed_actions),
        _format_scalar_list("concerns", message.response.concerns),
        _format_scalar_list("questions_for_peer", message.response.questions_for_peer),
        _format_scalar_list("answers_for_peer", message.response.answers_for_peer),
        f"confidence: {message.response.confidence}",
    ]
    return "\n".join(body)


def _format_scalar_list(name: str, values: Sequence[str]) -> str:
    if not values:
        return f"{name}: []"
    return f"{name}: " + " | ".join(values)


def _default_clients(config: CouncilConfig) -> list[CouncilClient]:
    return [
        ClaudeCouncilClient(
            binary=_resolve_binary(config.claude_bin),
            model=config.claude_model,
            role_prompt=config.claude_role,
        ),
        CodexCouncilClient(
            binary=_resolve_binary(config.codex_bin),
            model=config.codex_model,
            role_prompt=config.codex_role,
        ),
    ]


def _normalize_config(config: CouncilConfig) -> CouncilConfig:
    cwd = config.cwd.expanduser().resolve()
    output_root = config.output_root.expanduser().resolve()
    if not cwd.is_dir():
        raise FileNotFoundError(f"council cwd does not exist: {cwd}")
    if not config.task.strip():
        raise ValueError("--task must not be empty")
    if config.rounds < 1:
        raise ValueError("--rounds must be >= 1")
    if config.max_file_chars < 1000:
        raise ValueError("--max-file-chars must be >= 1000")
    output_root.mkdir(parents=True, exist_ok=True)
    return CouncilConfig(
        task=config.task.strip(),
        cwd=cwd,
        output_root=output_root,
        rounds=config.rounds,
        focus_paths=tuple(config.focus_paths),
        max_file_chars=config.max_file_chars,
        claude_model=config.claude_model,
        codex_model=config.codex_model,
        claude_bin=config.claude_bin,
        codex_bin=config.codex_bin,
        claude_role=config.claude_role,
        codex_role=config.codex_role,
    )


def _make_session_dir(output_root: Path) -> Path:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    session_dir = output_root / f"council_{stamp}"
    suffix = 1
    while session_dir.exists():
        suffix += 1
        session_dir = output_root / f"council_{stamp}_{suffix:02d}"
    session_dir.mkdir(parents=True, exist_ok=False)
    return session_dir


def _resolve_binary(binary: str) -> str:
    if Path(binary).expanduser().is_file():
        return str(Path(binary).expanduser().resolve())
    resolved = shutil.which(binary)
    if resolved:
        return resolved
    raise FileNotFoundError(f"required CLI not found on PATH: {binary}")


def _prepare_codex_home(session_dir: Path) -> Path:
    """Create a writable CODEX_HOME clone with just enough auth/config state."""

    source_home = Path(
        os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))
    ).expanduser()
    target_home = session_dir / ".codex-home"
    target_home.mkdir(parents=True, exist_ok=True)
    for name in ("auth.json", "version.json", "installation_id"):
        src = source_home / name
        dst = target_home / name
        if src.exists() and not dst.exists():
            shutil.copy2(src, dst)
    return target_home


async def _run_subprocess(
    *,
    args: Sequence[str],
    prompt: str,
    cwd: Path,
    env: dict[str, str] | None = None,
) -> CompletedInvocation:
    started = time.perf_counter()
    proc = await asyncio.create_subprocess_exec(
        *args,
        cwd=str(cwd),
        env=env,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout_bytes, stderr_bytes = await proc.communicate(prompt.encode("utf-8"))
    duration_ms = int((time.perf_counter() - started) * 1000)
    stdout = stdout_bytes.decode("utf-8", errors="replace")
    stderr = stderr_bytes.decode("utf-8", errors="replace")
    if proc.returncode != 0:
        cmd_preview = " ".join(args[:8])
        raise RuntimeError(
            f"subprocess failed ({proc.returncode}) for {cmd_preview}\n"
            f"stderr:\n{stderr[:4000]}"
        )
    return CompletedInvocation(
        command=tuple(args),
        stdout=stdout,
        stderr=stderr,
        exit_code=proc.returncode,
        duration_ms=duration_ms,
    )


def _safe_command_output(args: Sequence[str], *, cwd: Path) -> str:
    try:
        result = subprocess.run(
            list(args),
            cwd=str(cwd),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
        )
    except OSError:
        return ""
    if result.returncode != 0:
        return ""
    return result.stdout


def _top_level_entries(cwd: Path) -> list[str]:
    entries = []
    for child in sorted(cwd.iterdir(), key=lambda p: p.name):
        if child.name == ".git":
            continue
        entries.append(child.name + ("/" if child.is_dir() else ""))
    return entries


def _render_focus_path(*, cwd: Path, raw_path: str, max_file_chars: int) -> str:
    resolved = (cwd / raw_path).resolve()
    if not resolved.is_relative_to(cwd):
        raise ValueError(f"focus path escapes repository root: {raw_path}")
    if not resolved.exists():
        raise FileNotFoundError(f"focus path does not exist: {raw_path}")
    if resolved.is_dir():
        children = [
            str(path.relative_to(cwd))
            for path in sorted(resolved.rglob("*"))
            if path.is_file()
        ]
        preview = "\n".join(children[:200]) or "(no files)"
        if len(children) > 200:
            preview += "\n... truncated ..."
        return "\n".join(
            [
                f"### {raw_path}/",
                "```text",
                preview,
                "```",
            ]
        )

    try:
        text = resolved.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return "\n".join(
            [
                f"### {raw_path}",
                "```text",
                "(non-UTF-8 or binary file omitted from snapshot)",
                "```",
            ]
        )
    truncated = False
    if len(text) > max_file_chars:
        text = text[:max_file_chars]
        truncated = True
    numbered = _add_line_numbers(text)
    header = f"### {raw_path}"
    if truncated:
        header += " (truncated)"
    return "\n".join(
        [
            header,
            "```text",
            numbered,
            "```",
        ]
    )


def _add_line_numbers(text: str) -> str:
    lines = text.splitlines()
    if not lines:
        return "1: "
    return "\n".join(f"{idx:4}: {line}" for idx, line in enumerate(lines, start=1))


def _latest_messages(messages: Sequence[CouncilMessage]) -> dict[str, CouncilMessage]:
    latest: dict[str, CouncilMessage] = {}
    for msg in sorted(messages, key=lambda x: (x.round_index, x.agent_name)):
        latest[msg.agent_name] = msg
    return latest


def _normalize_overlap_key(text: str) -> str:
    return re.sub(r"\W+", " ", text.lower()).strip()


def _find_agreements(latest: dict[str, CouncilMessage]) -> list[str]:
    if len(latest) < 2:
        return []
    recommendations_by_agent = {
        name: {
            _normalize_overlap_key(item): item
            for item in message.response.proposed_actions
            if _normalize_overlap_key(item)
        }
        for name, message in latest.items()
    }
    common_keys = set.intersection(*(set(items.keys()) for items in recommendations_by_agent.values()))
    ordered = []
    for key in sorted(common_keys):
        for agent_name in sorted(recommendations_by_agent):
            ordered.append(recommendations_by_agent[agent_name][key])
            break
    return ordered


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
