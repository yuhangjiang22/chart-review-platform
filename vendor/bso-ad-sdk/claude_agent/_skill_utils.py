"""Shared utilities for skill runners.

What lives here:
  * build_run_clauses — the "Your turn is NOT complete unless..." prompt
                        tail every skill appends to its single-shot prompt
  * load_mcp_servers — parse skill-local .mcp.json + inject one runtime arg
  * check_mcp_server_importable — fork-probe the skill's MCP deps, cached

Per-skill differences (arg name, deps list, write-script name) become
parameters instead of separate function bodies.
"""

from __future__ import annotations

import functools
import json
import os
import subprocess
import sys
from pathlib import Path


# ─── Prompt boilerplate ─────────────────────────────────────────────────────

def build_run_clauses(
    *,
    model: str,
    output_root: Path,
    write_script_relpath: str,
    extra_args: dict[str, str | Path] | None = None,
) -> str:
    """Return the boilerplate every skill appends to its single-shot prompt.

    Pins `--model` and `--output-root` so:
      1. The agent can't self-identify (third-party providers often misreport
         their own model id), which would corrupt the output filename.
      2. The output goes wherever the caller specified, not whatever default
         the script falls back to.

    Also forces an actual Bash invocation of the write script so a text-only
    "I decided ..." response cannot pass as success.

    `write_script_relpath` is the path the agent will see in its prompt —
    e.g. ".claude/skills/bso-ad/scripts/write_ner.py".

    `extra_args` lets per-skill runners pin additional pass-through args
    (e.g. ``{"--source-text-file": path}`` for NER offset validation).
    """
    pinned = [f"--output-root={output_root}", f"--model={model}"]
    if extra_args:
        for name, value in extra_args.items():
            pinned.append(f"{name}={value}")
    pinned_str = " ".join(pinned)
    return (
        "\n\nYour turn is NOT complete unless you have actually invoked the "
        f"Bash tool to run `python3 {write_script_relpath}` with all required "
        "flags. A text-only response that merely describes or announces the "
        "decision is a FAILURE — the result file will not exist on disk. "
        "Do not stop, do not write a summary, do not say the decision has "
        "been recorded until the Bash call has returned its one-line JSON "
        "success summary.\n\n"
        f"When calling the script, pass {pinned_str} exactly as given "
        "(do not substitute your own model name or alter any path)."
    )


# ─── MCP server loading ─────────────────────────────────────────────────────

def load_mcp_servers(
    *,
    project_root: Path,
    mcp_json_relpath: Path,
    runtime_arg_name: str | None = None,
    runtime_arg_value: Path | None = None,
    runtime_args: dict[str, Path] | None = None,
) -> dict:
    """Parse a skill-local .mcp.json, inject runtime args, return the dict
    shape `mcp_servers=` wants on ClaudeAgentOptions.

    Two ways to specify args:
      * Single arg: pass `runtime_arg_name` + `runtime_arg_value`
        (back-compat shape; equivalent to ``runtime_args={name: value}``).
      * Multiple args: pass `runtime_args` mapping arg name → resolved path.

    Each entry is appended as ``--name=value`` to every server's args so the
    location is explicit at spawn time instead of being baked into the MCP
    script. Mixing both forms raises ValueError to avoid the "user passed
    both, which one wins" footgun.
    """
    mcp_json = project_root / mcp_json_relpath
    raw = json.loads(mcp_json.read_text())
    servers = raw.get("mcpServers") or {}
    if not servers:
        raise ValueError(f"No mcpServers defined in {mcp_json}")

    if runtime_arg_name is not None and runtime_args is not None:
        raise ValueError(
            "Pass either (runtime_arg_name, runtime_arg_value) OR runtime_args, not both"
        )
    if runtime_args is None:
        if runtime_arg_name is None or runtime_arg_value is None:
            raise ValueError(
                "load_mcp_servers requires runtime_args or "
                "(runtime_arg_name + runtime_arg_value)"
            )
        runtime_args = {runtime_arg_name: runtime_arg_value}

    appended = [f"{name}={value}" for name, value in runtime_args.items()]
    for spec in servers.values():
        args = list(spec.get("args") or [])
        args.extend(appended)
        spec["args"] = args
        # Portability: a skill-local .mcp.json typically declares
        # `"command": "python3"`, but the Claude CLI resolves that name
        # against PATH — which may be a different interpreter than the one
        # running this runner (e.g. the system python without the skill's
        # deps). That mismatch makes the MCP server crash silently on import
        # (fastmcp not found), the agent sees zero tools, and falls back to
        # arbitrary Bash — breaking the skill contract. It also defeats
        # check_mcp_server_importable, which probes sys.executable (the venv,
        # passes) while the real spawn uses `python3` (fails). Pin the server
        # to the SAME interpreter as the runner so its deps are guaranteed.
        cmd = spec.get("command")
        if isinstance(cmd, str) and Path(cmd).name in {
            "python",
            "python3",
            f"python{sys.version_info.major}",
            f"python{sys.version_info.major}.{sys.version_info.minor}",
        }:
            spec["command"] = sys.executable
    return servers


# ─── MCP dep probe (shared, cached) ─────────────────────────────────────────

# Cache key: (project_root, deps_probe_str). The probe outcome is stable
# within a process — if it succeeded once, the deps haven't disappeared.
@functools.lru_cache(maxsize=8)
def _probe_cached(
    project_root_str: str,
    deps_probe: str,
    fix_hint: str,
) -> None:
    """Fork-probe the skill's Python deps. Cached per (project_root, deps).

    Claude CLI swallows MCP startup errors silently — if a dep is missing the
    agent sees zero tools and falls back to arbitrary Bash, which silently
    breaks the skill contract. We catch that here so the user gets a clear
    `pip install` hint instead of a mysteriously empty toolset.
    """
    try:
        result = subprocess.run(
            [sys.executable, "-c", deps_probe],
            capture_output=True,
            text=True,
            timeout=10,
            cwd=project_root_str,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError) as exc:
        raise RuntimeError(
            f"Failed to probe MCP server Python environment: {exc}"
        ) from exc

    if result.returncode != 0:
        raise RuntimeError(
            "MCP server dependencies are missing in the Python environment "
            f"the Claude CLI will use to spawn the server ({sys.executable}).\n"
            f"Probe stderr:\n{result.stderr.strip()}\n\n"
            f"Fix: {fix_hint}"
        )


def check_mcp_server_importable(
    *,
    project_root: Path,
    mcp_script_relpath: Path,
    deps_probe: str,
    skip_env_var: str,
) -> None:
    """Public entry: verify the skill's MCP server can import its deps.

    `mcp_script_relpath` is the path from project_root to the server script;
    we check the file exists before forking. `deps_probe` is the Python code
    snippet that imports every dep the server needs. `skip_env_var` is the
    skill-specific env var that bypasses the probe (e.g. for tests / CI
    where the deps aren't installed).
    """
    script = project_root / mcp_script_relpath
    if not script.is_file():
        raise FileNotFoundError(f"MCP server script not found at {script}.")

    if os.environ.get(skip_env_var) == "1":
        return

    pkg_name = mcp_script_relpath.parts[-1].removesuffix(".py")
    fix_hint = f"pip install -r {project_root / 'requirements.txt'}  # for {pkg_name}"
    _probe_cached(str(project_root), deps_probe, fix_hint)
