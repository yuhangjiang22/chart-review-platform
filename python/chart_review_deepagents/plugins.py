"""Load task-specific Python plugin tools for the deepagents sidecar.

The TS run pins a tool profile; for tasks with `pythonPlugins`, the run spec
carries `python_plugins` (import paths) + run context to bind (`data_dir`, and
for cohort-CSV tasks like RUCAM, `person_id`). We import each module and
FORCE-bind that context into every tool in its `TOOLS` list — restricted to the
params each tool actually declares.

How the binding works at call time: the wrapper updates kwargs with the bound
values AFTER the model's kwargs, so a force-bound value always OVERRIDES whatever
the model supplied — the agent cannot change which patient or data dir a tool
reads, even if it passes its own value.

KNOWN LIMITATION — the bound params are NOT hidden from the LLM tool schema.
`functools.wraps` copies `__wrapped__`, and `inspect.signature` (which deepagents
uses to build the schema) follows `__wrapped__`, so the bound params (person_id,
data_dir) still APPEAR in the LLM-facing signature/schema. The model may
therefore still try to pass them; the override above makes that harmless, but the
params are not removed. (__name__/__doc__ are preserved so deepagents names the
tool correctly — mirrors RUCAM/agent_v2's _bind_data_dir.)

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
