# chart_review_plugins — task-specific READ/COMPUTE tools the deepagents sidecar
# loads as plugins (selected per task by @chart-review/task-tools ToolProfile
# .pythonPlugins). Each plugin module exports a `TOOLS` list of callables.
#
# Invariant (per the per-task tool registry design): plugin tools are read/compute
# only — they never write review_state and never cite note byte-offsets. Anything
# that writes or quotes a note stays an MCP tool (faithfulness-gated).
