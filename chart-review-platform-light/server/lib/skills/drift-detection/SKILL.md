---
name: drift-detection
description: Aggregate audit JSONLs across reviewed records and surface fields where override rates have shifted recently. Use to detect when a chart-review-guideline criterion is becoming systematically wrong and may need a guideline update.
---

# Drift Detection

Detects when a criterion's override rate is shifting outside its historical baseline.

## How it works (today)

Implemented as `app/server/drift-detector.ts`. Runs on demand (POST endpoint) and as a continuous monitor for field-level overrides over rolling windows.

## Future externalization

Out of scope for batch E.0.
