import { describe, expect, it } from 'vitest';
import { createCloudflareBearerTokenAuthorizer } from './auth.js';

function request(token?: string): Request {
  const init: RequestInit = { method: 'POST' };
  if (token !== undefined) init.headers = { authorization: `Bearer ${token}` };
  return new Request('https://usage.example.test/v1/usage-store', init);
}

describe('createCloudflareBearerTokenAuthorizer', () => {
  it('accepts the current token', () => {
    const authorize = createCloudflareBearerTokenAuthorizer({ currentToken: 'current-token' });
    expect(authorize(request('current-token'))).toBe(true);
  });

  it('accepts both current and previous tokens during a rotation overlap', () => {
    const authorize = createCloudflareBearerTokenAuthorizer({
      currentToken: 'new-token',
      previousToken: 'old-token',
    });

    expect(authorize(request('new-token'))).toBe(true);
    expect(authorize(request('old-token'))).toBe(true);
  });

  it('allows the previous slot to temporarily equal the current token', () => {
    const authorize = createCloudflareBearerTokenAuthorizer({
      currentToken: 'old-token',
      previousToken: 'old-token',
    });

    expect(authorize(request('old-token'))).toBe(true);
  });

  it('rejects stale, missing, and malformed credentials', () => {
    const authorize = createCloudflareBearerTokenAuthorizer({
      currentToken: 'new-token',
      previousToken: 'old-token',
    });

    expect(authorize(request('stale-token'))).toBe(false);
    expect(authorize(request())).toBe(false);
    expect(
      authorize(
        new Request('https://usage.example.test/v1/usage-store', {
          headers: { authorization: 'Basic abc123' },
        }),
      ),
    ).toBe(false);
  });

  it('rejects empty configured tokens', () => {
    expect(() => createCloudflareBearerTokenAuthorizer({ currentToken: '' })).toThrow(RangeError);
    expect(() =>
      createCloudflareBearerTokenAuthorizer({ currentToken: 'current-token', previousToken: '' }),
    ).toThrow(RangeError);
  });
});
