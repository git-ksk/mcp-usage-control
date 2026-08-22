import {
  UsageStateError,
  type Budget,
  type UsageRequest,
  type UsageOperationReconciliation,
  type UsageOperationReconciliationInput,
} from 'mcp-usage-control';
import {
  CloudflareUsageTransportError,
  createCloudflareUsageStoreGateway,
  type CloudflareDurableObjectNamespace,
  type CloudflareUsageStoreGatewayOptions,
  type RemoteCloudflareUsageStoreOptions,
} from './index.js';
import type {
  CloudflareLookupCommand,
  CloudflareLookupReply,
} from './reconciliation-protocol.js';

const DEFAULT_PATH = '/v1/usage-store';
const MAX_GATEWAY_BODY_BYTES = 65_536;
const RESERVATION_ID_PATTERN = /^cf1\.[a-f0-9]{64}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

interface CloudflareLookupDurableObjectStub {
  lookup(command: CloudflareLookupCommand): Promise<CloudflareLookupReply>;
}

export type RemoteCloudflareReconciliationOptions = Pick<
  RemoteCloudflareUsageStoreOptions,
  'endpoint' | 'headers' | 'fetch' | 'timeoutMs'
>;

export type CloudflareReserveReconciliationInput = UsageOperationReconciliationInput;
export type CloudflareReserveReconciliation = UsageOperationReconciliation;

/**
 * Drop-in gateway wrapper that preserves the normal usage-store protocol and
 * adds one authenticated read-only `lookup` method for explicit reconciliation.
 */
export function createReconciliableCloudflareUsageStoreGateway(
  options: CloudflareUsageStoreGatewayOptions,
) {
  const baseHandler = createCloudflareUsageStoreGateway(options);
  const path = options.path ?? DEFAULT_PATH;
  const domainName = options.domainName ?? 'default';

  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== path || request.method !== 'POST') return baseHandler(request);

    const contentLength = Number(request.headers.get('content-length') ?? '0');
    if (Number.isFinite(contentLength) && contentLength > MAX_GATEWAY_BODY_BYTES) {
      return baseHandler(request);
    }

    let text: string;
    try {
      text = await request.clone().text();
    } catch {
      return baseHandler(request);
    }
    if (new TextEncoder().encode(text).byteLength > MAX_GATEWAY_BODY_BYTES) {
      return baseHandler(request);
    }

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return baseHandler(request);
    }
    if (!isLookupHttpRequest(body)) return baseHandler(request);

    let authorized = false;
    try {
      authorized = (await options.authorize(request)) === true;
    } catch {
      authorized = false;
    }
    if (!authorized) return responseJson({ error: 'unauthorized' }, 401);

    let stub: CloudflareLookupDurableObjectStub;
    try {
      stub = resolveLookupStub(options.namespace, domainName);
    } catch {
      return responseJson({ error: 'store_unavailable' }, 503);
    }

    try {
      const result = await stub.lookup(body.input);
      return responseJson({ version: 1, result }, 200);
    } catch {
      return responseJson({ error: 'store_unavailable' }, 503);
    }
  };
}

/**
 * Reconciles one retained scalar logical operation. This function performs a
 * single read-only lookup and never retries or creates a reservation. It is also
 * the v0.8 generic entry point for ambiguous initial-reserve acknowledgement recovery.
 */
export async function reconcileRemoteCloudflareOperation(
  options: RemoteCloudflareReconciliationOptions,
  input: UsageOperationReconciliationInput,
): Promise<UsageOperationReconciliation> {
  const prepared = await prepareReconciliation(input);
  const reply = await postLookup(options, prepared.reservationId);

  if (reply.status === 'absent') {
    return { status: 'absent', reservationId: prepared.reservationId };
  }

  verifyLookupIdentity(reply, prepared, input.units);

  if (reply.status === 'active') {
    return {
      status: 'active',
      state: reply.state,
      reservation: {
        id: prepared.reservationId,
        operationId: input.request.operationId,
        principalId: input.request.principal.id,
        ...(input.request.principal.tenantId === undefined
          ? {}
          : { tenantId: input.request.principal.tenantId }),
        ...(input.request.principal.plan === undefined
          ? {}
          : { plan: input.request.principal.plan }),
        tool: input.request.tool,
        budgetKeys: prepared.budgets.map(budget => budget.key),
        reservedUnits: reply.reservedUnits,
        expiresAt: reply.expiresAt,
      },
    };
  }

  if (reply.status === 'expired') {
    return {
      status: 'expired',
      state: reply.state,
      reservationId: prepared.reservationId,
      expiredAt: reply.expiredAt,
    };
  }

  return {
    status: 'settled',
    reservationId: prepared.reservationId,
    reservedUnits: reply.reservedUnits,
    actualUnits: reply.actualUnits,
    tombstoneExpiresAt: reply.tombstoneExpiresAt,
  };
}

/** Backward-compatible v0.7 name for initial-reserve acknowledgement reconciliation. */
export async function reconcileRemoteCloudflareReserve(
  options: RemoteCloudflareReconciliationOptions,
  input: CloudflareReserveReconciliationInput,
): Promise<CloudflareReserveReconciliation> {
  return reconcileRemoteCloudflareOperation(options, input);
}

interface PreparedReconciliation {
  reservationId: string;
  budgets: Budget[];
  budgetIds: string[];
}

async function prepareReconciliation(
  input: CloudflareReserveReconciliationInput,
): Promise<PreparedReconciliation> {
  validateRequestIdentity(input.request);
  assertNonNegativeInteger(input.units, 'units');
  const budgets = canonicalizeBudgets(input.budgets);
  const operationHash = await digest(
    JSON.stringify([
      input.request.principal.tenantId ?? null,
      input.request.principal.id,
      input.request.tool,
      input.request.operationId,
    ]),
  );
  const budgetIds = await Promise.all(budgets.map(budget => digest(budget.key)));
  return { reservationId: `cf1.${operationHash}`, budgets, budgetIds };
}

async function postLookup(
  options: RemoteCloudflareReconciliationOptions,
  reservationId: string,
): Promise<CloudflareLookupReply> {
  const endpoint = new URL(options.endpoint);
  const isLocalHttp =
    endpoint.protocol === 'http:' &&
    (endpoint.hostname === '127.0.0.1' || endpoint.hostname === 'localhost');
  if (endpoint.protocol !== 'https:' && !isLocalHttp) {
    throw new RangeError('Cloudflare usage store endpoint must use HTTPS (local HTTP is test-only)');
  }
  if (endpoint.username || endpoint.password) {
    throw new RangeError('Cloudflare usage store endpoint must not embed credentials');
  }

  const timeoutMs = options.timeoutMs ?? 10_000;
  assertPositiveInteger(timeoutMs, 'timeoutMs');
  assertPortableTimerDelay(timeoutMs, 'timeoutMs');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let resolvedHeaders: HeadersInit | undefined;
    try {
      resolvedHeaders = await waitForAbort(resolveHeaders(options.headers), controller.signal);
    } catch (error) {
      if (controller.signal.aborted) throw new CloudflareUsageTransportError('timeout');
      throw error;
    }

    const headers = new Headers(resolvedHeaders);
    headers.set('content-type', 'application/json');
    headers.set('accept', 'application/json');

    let response: Response;
    try {
      response = await waitForAbort(
        (options.fetch ?? fetch)(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            version: 1,
            method: 'lookup',
            input: { reservationId },
          }),
          signal: controller.signal,
        }),
        controller.signal,
      );
    } catch (error) {
      if (controller.signal.aborted) throw new CloudflareUsageTransportError('timeout');
      if (error instanceof CloudflareUsageTransportError) throw error;
      throw new CloudflareUsageTransportError('network');
    }

    if (response.status === 401 || response.status === 403) {
      throw new CloudflareUsageTransportError('unauthorized', response.status);
    }
    if (!response.ok) throw new CloudflareUsageTransportError('remote', response.status);

    let payload: unknown;
    try {
      payload = await waitForAbort(response.json(), controller.signal);
    } catch (error) {
      if (controller.signal.aborted) throw new CloudflareUsageTransportError('timeout');
      if (error instanceof CloudflareUsageTransportError) throw error;
      throw new CloudflareUsageTransportError('protocol', response.status);
    }
    if (!isLookupHttpResponse(payload)) {
      throw new CloudflareUsageTransportError('protocol', response.status);
    }
    return payload.result;
  } finally {
    clearTimeout(timer);
  }
}

function verifyLookupIdentity(
  reply: Exclude<CloudflareLookupReply, { status: 'absent' }>,
  prepared: PreparedReconciliation,
  units: number,
): void {
  if (reply.reservationId !== prepared.reservationId) {
    throw new UsageStateError('Cloudflare reconciliation returned a different reservation');
  }
  if (reply.reservedUnits !== units) {
    throw new UsageStateError('Cloudflare reconciliation reservedUnits did not match expected retained state');
  }
  if (
    reply.budgetIds.length !== prepared.budgetIds.length ||
    reply.budgetIds.some((id, index) => id !== prepared.budgetIds[index])
  ) {
    throw new UsageStateError('Cloudflare reconciliation budgets did not match expected retained state');
  }
}

function resolveLookupStub(
  namespace: CloudflareDurableObjectNamespace,
  domainName: string,
): CloudflareLookupDurableObjectStub {
  const candidate = namespace.getByName
    ? namespace.getByName(domainName)
    : namespace.idFromName && namespace.get
      ? namespace.get(namespace.idFromName(domainName))
      : undefined;
  if (!candidate) throw new TypeError('Durable Object namespace is unavailable');

  const lookup = (candidate as unknown as { lookup?: unknown }).lookup;
  if (typeof lookup !== 'function') {
    throw new TypeError('Durable Object does not expose reconciliation lookup');
  }
  return candidate as unknown as CloudflareLookupDurableObjectStub;
}

function isLookupHttpRequest(
  value: unknown,
): value is { version: 1; method: 'lookup'; input: CloudflareLookupCommand } {
  return (
    isRecord(value) &&
    value.version === 1 &&
    value.method === 'lookup' &&
    isRecord(value.input) &&
    typeof value.input.reservationId === 'string' &&
    RESERVATION_ID_PATTERN.test(value.input.reservationId)
  );
}

function isLookupHttpResponse(
  value: unknown,
): value is { version: 1; result: CloudflareLookupReply } {
  return isRecord(value) && value.version === 1 && isLookupReply(value.result);
}

function isLookupReply(value: unknown): value is CloudflareLookupReply {
  if (!isRecord(value) || typeof value.status !== 'string') return false;
  if (value.status === 'absent') return true;

  if (
    typeof value.reservationId !== 'string' ||
    !RESERVATION_ID_PATTERN.test(value.reservationId) ||
    !isNonNegativeInteger(value.reservedUnits) ||
    !isHashArray(value.budgetIds)
  ) {
    return false;
  }

  if (value.status === 'active') {
    return (
      (value.state === 'pending' || value.state === 'liable') &&
      isNonNegativeInteger(value.expiresAt)
    );
  }
  if (value.status === 'expired') {
    return (
      (value.state === 'pending' || value.state === 'liable') &&
      isNonNegativeInteger(value.expiredAt)
    );
  }
  if (value.status === 'settled') {
    return (
      isNonNegativeInteger(value.actualUnits) &&
      isNonNegativeInteger(value.tombstoneExpiresAt)
    );
  }
  return false;
}

function canonicalizeBudgets(budgets: readonly Budget[]): Budget[] {
  if (budgets.length === 0) throw new RangeError('budgets must contain at least one budget');
  const normalized = budgets.map(budget => {
    if (typeof budget.key !== 'string' || budget.key.length === 0) {
      throw new RangeError('budget.key must be a non-empty string');
    }
    assertNonNegativeInteger(budget.limit, `budget.limit (${budget.key})`);
    return { key: budget.key, limit: budget.limit };
  });
  normalized.sort((a, b) => a.key.localeCompare(b.key));
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1]!.key === normalized[index]!.key) {
      throw new RangeError(`duplicate budget key: ${normalized[index]!.key}`);
    }
  }
  return normalized;
}

function validateRequestIdentity(request: UsageRequest): void {
  if (!request.operationId) throw new RangeError('operationId must be non-empty');
  if (!request.principal.id) throw new RangeError('principal.id must be non-empty');
  if (!request.tool) throw new RangeError('tool must be non-empty');
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
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

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isHashArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(id => typeof id === 'string' && HASH_PATTERN.test(id));
}

async function digest(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function resolveHeaders(
  headers: RemoteCloudflareReconciliationOptions['headers'],
): Promise<HeadersInit | undefined> {
  if (typeof headers === 'function') return headers();
  return headers;
}

function waitForAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('operation aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new Error('operation aborted'));
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      value => {
        cleanup();
        resolve(value);
      },
      error => {
        cleanup();
        reject(error);
      },
    );
  });
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
