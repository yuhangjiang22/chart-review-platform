---
name: faithfulness-check
description: Verify that a quoted clinical span actually appears verbatim in the source chart at the claimed location. Use to enforce evidence-grounded answers and reject hallucinated quotes during chart review.
---

# Faithfulness Check

Validates that a claimed source span exists in the patient's chart at the cited offsets.

## How it works (today)

Implemented as `app/server/faithfulness.ts`. The platform calls `verifyFaithful(noteId, claimedSpan, offsets)` whenever an agent or reviewer cites a source span.

## Future externalization

Out of scope for batch E.0.
