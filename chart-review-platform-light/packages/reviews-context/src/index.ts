/**
 * Per-async-chain override of the reviews root.
 *
 * The batch-run driver (`runs.ts`) needs to redirect both review_state
 * writes (`review-state.ts`) AND chat audit logs (`audit-trail.ts`)
 * for one agent invocation, without leaking to parallel runs (env vars
 * don't survive parallelism). Both modules read this AsyncLocalStorage
 * so the redirect is consistent across them.
 *
 * Production code never sets the override — the reviews root falls
 * through to `CHART_REVIEW_REVIEWS_ROOT` or the platform default in
 * each module.
 */

import { AsyncLocalStorage } from "async_hooks";

const reviewsRootStore = new AsyncLocalStorage<string>();

export function getReviewsRootOverride(): string | undefined {
  return reviewsRootStore.getStore();
}

/**
 * Run `fn` with the given reviews root visible to every nested call to
 * `reviewsRoot()` in either review-state.ts or audit-trail.ts. Parallel
 * invocations with different roots do not interfere — `AsyncLocalStorage`
 * propagates per-async-chain.
 */
export function withReviewsRoot<T>(root: string, fn: () => Promise<T>): Promise<T> {
  return reviewsRootStore.run(root, fn);
}
