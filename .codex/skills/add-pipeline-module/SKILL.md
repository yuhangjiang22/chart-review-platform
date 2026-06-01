name: add-pipeline-module

description: Add a new module to the v2 6-step pluggable pipeline (or modify an existing one)

The v2 pipeline lives across six packages under packages/pipeline-{clarify,form-gen,discover,extract,validate,correct-log}/. Each module implements a contract from packages/v2-shared/src/types.ts (ClarifyModule, FormGenModule, DiscoverModule, ExtractModule, ValidateModule, CorrectLogModule).

To add a new module variant (e.g. a domain-specific clarify implementation):

1. Add a new file under packages/pipeline-<step>/src/<variant>.ts implementing the contract.
2. Export it from packages/pipeline-<step>/src/index.ts.
3. Register it in the workflow that uses it: packages/workflow-<domain>/src/index.ts.
4. Run `npm run typecheck` from chart-review-platform-v2/.

To add a NEW pipeline step (rare — the 6 steps cover the contract):

1. Create packages/pipeline-<new>/ with package.json + src/index.ts.
2. Define the module interface in packages/v2-shared/src/types.ts.
3. Add the step to the workflow composer in packages/workflow-*/src/index.ts.
4. Wire a REST endpoint at server/index.ts under /api/v2/<new>.
