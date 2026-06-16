"""Load task-specific Python plugin tools for the deepagents sidecar.

The TS run pins a tool profile; for tasks with `pythonPlugins`, the run spec
carries `python_plugins` (import paths) + `data_dir`. We import each module, bind
`data_dir` into each tool in its `TOOLS` list (preserving __name__/__doc__ so
deepagents can build the LLM tool schema, exactly like RUCAM/agent_v2's
_bind_data_dir), and return the flattened list to append after load_mcp_tools.

Plugin tools are read/compute only — they never write review_state.
"""
import functools
import importlib
from typing import Callable, List


def load_python_plugins(module_paths: List[str], data_dir: str) -> List[Callable]:
    out: List[Callable] = []
    for path in module_paths or []:
        mod = importlib.import_module(path)
        for fn in getattr(mod, "TOOLS", []):
            @functools.wraps(fn)
            def bound(*args, _fn=fn, **kwargs):
                kwargs.setdefault("data_dir", data_dir)
                return _fn(*args, **kwargs)
            out.append(bound)
    return out
