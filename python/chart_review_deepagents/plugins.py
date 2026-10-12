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

The bound params are also HIDDEN from the LLM-facing tool schema. This used to
be a documented limitation — `functools.wraps` copies `__wrapped__` and
`inspect.signature` (which deepagents uses to build the schema) follows it, so
`person_id` stayed a REQUIRED parameter in the schema the model sees. The
consequence was worse than the docs claimed: the item prompts tell the agent the
tools are "already bound to this patient — pass no arguments", and a model that
OBEYED that got `person_id: Field required` from pydantic validation before the
binding wrapper ever ran. Measured on the 2026-10-12 Qwen3.8-27B RUCAM runs: 6 of
7 patients opened with `get_patient_summary {}` / `get_suspect_drug {}` /
`compute_r_ratio {}` and got that error, then burned ~40 of 116 tool calls
(patient 07) wandering the virtual filesystem for a person_id. They only
recovered because the materialized notes carry a `Patient ID:` header the agent
could read the id off; a corpus without that header never recovers and thrashes
until the context overflows. Setting `__signature__` on the wrapper stops
`inspect.signature` from unwrapping (its `unwrap` call stops at any object that
has `__signature__`), so the bound params disappear from the schema and the
empty call the prompt asks for validates. The runtime override is kept anyway,
for callers that still pass a value.

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
            sig = inspect.signature(fn)
            forced = {k: v for k, v in bind.items() if k in sig.parameters}

            @functools.wraps(fn)
            def bound(*args, _fn=fn, _forced=forced, **kwargs):
                kwargs.update(_forced)  # run context wins over anything the LLM passed
                return _fn(*args, **kwargs)

            if forced:
                # Hide the bound params from the schema the model is shown. Both
                # halves matter: __signature__ stops inspect.signature from
                # following __wrapped__ back to the unbound function, and
                # __annotations__ (copied wholesale by functools.wraps) is what a
                # get_type_hints-based schema builder would read instead.
                bound.__signature__ = sig.replace(
                    parameters=[p for name, p in sig.parameters.items() if name not in forced])
                bound.__annotations__ = {
                    k: v for k, v in getattr(fn, "__annotations__", {}).items() if k not in forced}

            out.append(bound)
    return out
