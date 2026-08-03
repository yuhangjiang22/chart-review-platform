---
name: keyword-search
description: Search chart note text for terms or phrases; return hits with note_id and span offsets. Use when extracting evidence from a patient's notes during chart review, especially when looking for specific clinical concepts or codes.
---

# Keyword Search

Searches the patient's note corpus for keyword matches and returns structured hits.

## How it works (today)

This skill is currently implemented as a TypeScript module: `app/server/chart-search.ts`. The platform invokes it directly during chart review; the agent does not yet auto-trigger it via Claude's skill loader.

## Future externalization

To externalize as a filesystem-loaded skill (consumable by `claude-code` or any Claude SDK with code execution), wrap `chart-search.ts` in a CLI script under `scripts/keyword_search.py` and expand this SKILL.md with concrete invocation examples. Out of scope for batch E.0.
