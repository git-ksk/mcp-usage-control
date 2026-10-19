import { UsageDeniedError, getUsageDenialContext } from 'mcp-usage-control';

/**
 * Trusted APP mapping of internal Store limiter IDs -> public scope labels.
 * In production populate this only from the server's own policy definition,
 * not from request arguments. Unknown keys deliberately remain 'unknown'.
 */
const SAFE_SCOPES = new Set(['daily', 'short-window', 'shared', 'unknown']);

/**
 * Convert a server-local denial into privacy-safe, non-authoritative MCP UX.
 * This is a presentation boundary, not new policy, Store access, or a retry.
 * `approvedScopes` maps exact Store budget keys to public descriptors; any
 * arbitrary value or unknown key falls back to unknown.
 * `approvedNextBoundaryByKey` optionally contains a known calendar boundary
 * calculated separately by the application from createWindowedBudgetKey().
 * A first limiter may be only ONE of several exhausted budgets, so never give
 * a guaranteed retry timestamp, even if a calendar boundary is known.
 */
export function safeDenialResult(error, {
  approvedScopes = new Map(),
  approvedNextBoundaryByKey = new Map(),
} = {}) {
  const denial = error instanceof UsageDeniedError;
  const reason = denial
    ? (error.reason === 'quota_exceeded' ? 'quota_exceeded'
      : error.reason === 'duplicate_operation' ? 'duplicate_operation' : 'policy_denied')
    : 'unavailable';
  const limiterKey = getUsageDenialContext(error)?.limitingBudgetKey;
  const scope = limiterKey === undefined ? 'unknown' : approvedScopes.get(limiterKey);
  const publicScope = SAFE_SCOPES.has(scope) ? scope : 'unknown';
  const trustedBoundary = limiterKey === undefined ? undefined : approvedNextBoundaryByKey.get(limiterKey);
  const validBoundary = Number.isSafeInteger(trustedBoundary) && trustedBoundary > 0 &&
    Number.isFinite(new Date(trustedBoundary).getTime());
  const nextWindowBoundary = reason === 'quota_exceeded' && publicScope !== 'unknown' && validBoundary
    ? new Date(trustedBoundary).toISOString() : null;
  return {
    isError: true,
    content: [{ type: 'text', text: 'Usage denied or tool unavailable' }],
    structuredContent: {
      status: 'denied', reason, scope: publicScope,
      nextWindowBoundary, // advisory boundary of ONE Store limiter, never a success guarantee
      retrySafeAt: null, // unknown until *all* relevant budgets can be checked authoritatively
    },
  };
}
