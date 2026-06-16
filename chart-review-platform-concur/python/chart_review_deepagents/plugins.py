"""Load task-specific Python plugin tools for the deepagents sidecar.

The TS run pins a tool profile; for tasks with `pythonPlugins`, the run spec
carries `python_plugins` (import paths) + run context to bind (`data_dir`, and
for cohort-CSV tasks like RUCAM, `person_id`). We import each module and
FORCE-bind that context into every tool in its `TOOLS` list — restricted to the
params each tool actually declares — so the agent cannot override which patient
or data dir a tool reads. __name__/__doc__ are preserved so deepagents builds the
LLM tool schema (exactly like RUCAM/agent_v2's _bind_data_dir).

Plugin tools are read/compute only — they never write review_state.
"""
import functools
import importlib
import inspect
from typing import Any, Callable, Dict, List, Optional


def load_python_plugins(
    module_paths: List[str],
    bind: Optional[Dict[str, Any]] = None,
) -> List[Callable]:
    bind = bind or {}
    out: List[Callable] = []
    for path in module_paths or []:
        mod = importlib.import_module(path)
        for fn in getattr(mod, "TOOLS", []):
            params = inspect.signature(fn).parameters
            forced = {k: v for k, v in bind.items() if k in params}

            @functools.wraps(fn)
            def bound(*args, _fn=fn, _forced=forced, **kwargs):
                kwargs.update(_forced)  # run context wins over anything the LLM passed
                return _fn(*args, **kwargs)

            out.append(bound)
    return out
