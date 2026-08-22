import { UsageStateError } from 'mcp-usage-control';
import {
  CloudflareUsageTransportError,
  type CloudflareDurableObjectNamespace,
  type CloudflareUsageStoreOptions,
  type RemoteCloudflareUsageStoreOptions,
} from './index.js';
import {
  MAX_CLOUDFLARE_PRUNE_BUDGETS,
  type CloudflarePruneBudgetsCommand,
  type CloudflarePruneBudgetsReply,
} from './maintenance-protocol.js';

const DEFAULT_MAINTENANCE_PATH = '/v1/usage-store-maintenance';
const MAX_GATEWAY_BODY_BYTES = 65_536;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

interface CloudflareMaintenanceDurableObjectStub {
  pruneBudgets(command: CloudflarePruneBudgetsCommand): Promise<CloudflarePruneBudgetsReply>;
}

export type CloudflareMaintenanceAuthorize = (
  request: Request,
) => boolean | Promise<boolean>;

export interface CloudflareBudgetMaintenanceGatewayOptions
  extends Pick<CloudflareUsageStoreOptions, 'domainName'> {
  namespace: CloudflareDurableObjectNamespace;
  /** Use a maintenance-specific credential/authorization policy where practical. */
  authorizeMaintenance: CloudflareMaintenanceAuthorize;
  /** Defaults to /v1/usage-store-maintenance. */
  path?: string;
}

export type RemoteCloudflareMaintenanceOptions = Pick<
  RemoteCloudflareUsageStoreOptions,
  'endpoint' | 'headers' | 'fetch' | 'timeoutMs'
>;

export interface PruneRemoteCloudflareHistoricalBudgetsInput {
  /** Exact application-selected historical budget keys to attempt to delete. */
  historicalBudgetKeys: readonly string[];
  /** Current/retained budget keys that must not be deleted even if also listed as historical. */
  protectedCurrentBudgetKeys: readonly string[];
}

export interface PruneRemoteCloudflareHistoricalBudgetsResult {
  prunedKeys: string[];
  blockedProtectedKeys: string[];
  blockedActiveKeys: string[];
  missingKeys: string[];
}

/**
 * Creates a separate authenticated maintenance endpoint. It is intentionally
 * not part of the normal usage-control gateway so ordinary runtime credentials
 * do not have to grant historical-data deletion rights.
 */
export function createCloudflareBudgetMaintenanceGateway(
  options: CloudflareBudgetMaintenanceGatewayOptions,
) {
  const path = options.path ?? DEFAULT_MAINTENANCE_PATH;
  const domainName = options.domainName ?? 'default';
  if (!path.startsWith('/')) throw new RangeError('maintenance gateway path must start with /');
  if (domainName.length === 0 || domainName.length > 128) {
    throw new RangeError('domainName must be between 1 and 128 characters');
  }

  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== path) return responseJson({ error: 'not_found' }, 404);
    if (request.method !== 'POST') return responseJson({ error: 'method_not_allowed' }, 405);

    let authorized = false;
    try {
      authorized = (await options.authorizeMaintenance(request)) === true;
    } catch {
      authorized = false;
    }
    if (!authorized) return responseJson({ error: 'unauthorized' }, 401);

    const contentLength = Number(request.headers.get('content-length') ?? '0');
    if (Number.isFinite(contentLength) && contentLength > MAX_GATEWAY_BODY_BYTES) {
      return responseJson({ error: 'payload_too_large' }, 413);
    }

    let text: string;
    try {
      text = await request.text();
    } catch {
      return responseJson({ error: 'invalid_request' }, 400);
    }
    if (new TextEncoder().encode(text).byteLength > MAX_GATEWAY_BODY_BYTES) {
      return responseJson({ error: 'payload_too_large' }, 413);
    }

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return responseJson({ error: 'invalid_request' }, 400);
    }
    if (!isMaintenanceRequest(body)) return responseJson({ error: 'invalid_request' }, 400);

    let stub: CloudflareMaintenanceDurableObjectStub;
    try {
      stub = resolveMaintenanceStub(options.namespace, domainName);
    } catch {
      return responseJson({ error: 'store_unavailable' }, 503);
    }

    try {
      const result = await stub.pruneBudgets(body.input);
      return responseJson({ version: 1, result }, 200);
    } catch {
      return responseJson({ error: 'store_unavailable' }, 503);
    }
  };
}

/**
 * Explicitly attempts to delete application-selected historical budget rows.
 * The caller owns window-retention semantics. Each invocation is bounded to 64
 * candidate keys and 64 protected/current keys.
 */
export async function pruneRemoteCloudflareHistoricalBudgets(
  options: RemoteCloudflareMaintenanceOptions,
  input: PruneRemoteCloudflareHistoricalBudgetsInput,
): Promise<PruneRemoteCloudflareHistoricalBudgetsResult> {
  const historicalBudgetKeys = validateRawBudgetKeys(
    input.historicalBudgetKeys,
    'historicalBudgetKeys',
    true,
  );
  const protectedCurrentBudgetKeys = validateRawBudgetKeys(
    input.protectedCurrentBudgetKeys,
    'protectedCurrentBudgetKeys',
    false,
  );

  const candidatePairs = await Promise.all(
    historicalBudgetKeys.map(async key => [key, await digest(key)] as const),
  );
  const protectedPairs = await Promise.all(
    protectedCurrentBudgetKeys.map(async key => [key, await digest(key)] as const),
  );
  const candidateById = new Map(candidatePairs.map(([key, id]) => [id, key]));

  const reply = await postMaintenance(options, {
    candidateBudgetIds: candidatePairs.map(([, id]) => id),
    protectedBudgetIds: protectedPairs.map(([, id]) => id),
  });

  const classifications = [
    ['prunedKeys', reply.prunedIds],
    ['blockedProtectedKeys', reply.blockedProtectedIds],
    ['blockedActiveKeys', reply.blockedActiveIds],
    ['missingKeys', reply.missingIds],
  ] as const;
  const seen = new Set<string>();
  const result: PruneRemoteCloudflareHistoricalBudgetsResult = {
    prunedKeys: [],
    blockedProtectedKeys: [],
    blockedActiveKeys: [],
    missingKeys: [],
  };

  for (const [target, ids] of classifications) {
    for (const id of ids) {
      const key = candidateById.get(id);
      if (!key || seen.has(id)) {
        throw new UsageStateError('Cloudflare maintenance reply did not match the requested candidates');
      }
      seen.add(id);
      result[target].push(key);
    }
  }

  if (seen.size !== candidatePairs.length) {
    throw new UsageStateError('Cloudflare maintenance reply omitted a requested candidate');
  }
  return result;
}

async function postMaintenance(
  options: RemoteCloudflareMaintenanceOptions,
  input: CloudflarePruneBudgetsCommand,
): Promise<CloudflarePruneBudgetsReply> {
  const endpoint = new URL(options.endpoint);
  const isLocalHttp =
    endpoint.protocol === 'http:' &&
    (endpoint.hostname === '127.0.0.1' || endpoint.hostname === 'localhost');
  if (endpoint.protocol !== 'https:' && !isLocalHttp) {
    throw new RangeError('Cloudflare maintenance endpoint must use HTTPS (local HTTP is test-only)');
  }
  if (endpoint.username || endpoint.password) {
    throw new RangeError('Cloudflare maintenance endpoint must not embed credentials');
  }

  const timeoutMs = options.timeoutMs ?? 10_000;
  assertPositiveInteger(timeoutMs, 'timeoutMs');
  assertPortableTimerDelay(timeoutMs, 'timeoutMs');
  const headers = new Headers(await resolveHeaders(options.headers));
  headers.set('content-type', 'application/json');
  headers.set('accept', 'application/json');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ version: 1, method: 'prune_budgets', input }),
      signal: controller.signal,
    });
  } catch {
    if (controller.signal.aborted) throw new CloudflareUsageTransportError('timeout');
    throw new CloudflareUsageTransportError('network');
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 403) {
    throw new CloudflareUsageTransportError('unauthorized');
  }
  if (!response.ok) throw new CloudflareUsageTransportError('remote');

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new CloudflareUsageTransportError('protocol');
  }
  if (!isMaintenanceResponse(payload)) throw new CloudflareUsageTransportError('protocol');
  return payload.result;
}

function resolveMaintenanceStub(
  namespace: CloudflareDurableObjectNamespace,
  domainName: string,
): CloudflareMaintenanceDurableObjectStub {
  const candidate = namespace.getByName
    ? namespace.getByName(domainName)
    : namespace.idFromName && namespace.get
      ? namespace.get(namespace.idFromName(domainName))
      : undefined;
  if (!candidate) throw new TypeError('Durable Object namespace is unavailable');
  const pruneBudgets = (candidate as unknown as { pruneBudgets?: unknown }).pruneBudgets;
  if (typeof pruneBudgets !== 'function') {
    throw new TypeError('Durable Object does not expose budget maintenance');
  }
  return candidate as unknown as CloudflareMaintenanceDurableObjectStub;
}

function isMaintenanceRequest(
  value: unknown,
): value is { version: 1; method: 'prune_budgets'; input: CloudflarePruneBudgetsCommand } {
  return (
    isRecord(value) &&
    value.version === 1 &&
    value.method === 'prune_budgets' &&
    isRecord(value.input) &&
    isHashArray(value.input.candidateBudgetIds, true) &&
    isHashArray(value.input.protectedBudgetIds, false)
  );
}

function isMaintenanceResponse(
  value: unknown,
): value is { version: 1; result: CloudflarePruneBudgetsReply } {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.result)) return false;
  const result = value.result;
  return (
    isHashArray(result.prunedIds, false) &&
    isHashArray(result.blockedProtectedIds, false) &&
    isHashArray(result.blockedActiveIds, false) &&
    isHashArray(result.missingIds, false)
  );
}

function isHashArray(value: unknown, requireOne: boolean): value is string[] {
  return (
    Array.isArray(value) &&
    (!requireOne || value.length > 0) &&
    value.length <= MAX_CLOUDFLARE_PRUNE_BUDGETS &&
    value.every(id => typeof id === 'string' && HASH_PATTERN.test(id)) &&
    new Set(value).size === value.length
  );
}

function validateRawBudgetKeys(
  keys: readonly string[],
  name: string,
  requireOne: boolean,
): string[] {
  if (!Array.isArray(keys)) throw new RangeError(`${name} must be an array`);
  if (requireOne && keys.length === 0) throw new RangeError(`${name} must not be empty`);
  if (keys.length > MAX_CLOUDFLARE_PRUNE_BUDGETS) {
    throw new RangeError(`${name} must contain at most ${MAX_CLOUDFLARE_PRUNE_BUDGETS} entries`);
  }
  const normalized = keys.map(key => {
    if (typeof key !== 'string' || key.length === 0) {
      throw new RangeError(`${name} entries must be non-empty strings`);
    }
    return key;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new RangeError(`${name} must not contain duplicates`);
  }
  return normalized;
}

function assertPortableTimerDelay(value: number, name: string): void {
  if (value > 2_147_483_647) {
    throw new RangeError(`${name} must not exceed 2147483647ms`);
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

async function digest(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function resolveHeaders(
  headers: RemoteCloudflareMaintenanceOptions['headers'],
): Promise<HeadersInit | undefined> {
  if (typeof headers === 'function') return headers();
  return headers;
}

function responseJson(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
