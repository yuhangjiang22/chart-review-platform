---
name: role-c-proposal
description: Draft a v.next of the chart-review-guideline-skill when drift detection flags a criterion as needing revision. Use to mechanize Role C proposals from drift signals into a methodologist-reviewable patch.
---

# Role C Proposal

Generates a versioned guideline patch when a drift threshold is crossed.

## How it works (today)

Implemented as `app/server/auto-role-c.ts`. Triggered by drift-detection when 3 or more alerts accumulate on the same field within 24h.

## Future externalization

Out of scope for batch E.0.
