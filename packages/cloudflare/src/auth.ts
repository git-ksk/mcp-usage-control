export interface CloudflareBearerTokenAuthorizerOptions {
  /** Token all new callers should use. */
  currentToken: string;
  /** Optional previous token accepted only during a credential-rotation overlap window. */
  previousToken?: string;
}

/**
 * Creates a Bearer-token authorizer suitable for Cloudflare usage,
 * reconciliation, and maintenance gateways.
 *
 * For a zero-downtime rotation, first copy the current credential into
 * `previousToken`, then replace `currentToken`, move callers to the new token,
 * and finally remove `previousToken`.
 */
export function createCloudflareBearerTokenAuthorizer(
  options: CloudflareBearerTokenAuthorizerOptions,
): (request: Request) => boolean {
  const currentToken = normalizeToken(options.currentToken, 'currentToken');
  const previousToken =
    options.previousToken === undefined
      ? undefined
      : normalizeToken(options.previousToken, 'previousToken');

  return request => {
    const authorization = request.headers.get('authorization');
    if (!authorization?.startsWith('Bearer ')) return false;

    const candidate = authorization.slice('Bearer '.length);
    if (candidate.length === 0) return false;

    return (
      constantTimeEqual(candidate, currentToken) ||
      (previousToken !== undefined && constantTimeEqual(candidate, previousToken))
    );
  };
}

function normalizeToken(token: string, name: string): string {
  if (typeof token !== 'string' || token.length === 0) {
    throw new RangeError(`${name} must be a non-empty string`);
  }
  return token;
}

/** Avoid prefix-dependent token comparisons while remaining Worker-compatible. */
function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;

  for (let index = 0; index < length; index += 1) {
    const leftCode = index < left.length ? left.charCodeAt(index) : 0;
    const rightCode = index < right.length ? right.charCodeAt(index) : 0;
    difference |= leftCode ^ rightCode;
  }

  return difference === 0;
}
