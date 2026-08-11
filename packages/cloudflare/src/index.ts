import {
  UsageStateError,
  emitUsageEvent,
  type Budget,
  type BudgetRemaining,
  type MarkLiableInput,
  type MarkLiableResult,
  type RenewInput,
  type RenewResult,
  type SettleInput,
  type SettlementResult,
  type StoreReserveResult,
  type UsageObserver,
  type UsageRequest,
  type UsageStore,
} from 'mcp-usage-control';

export interface CloudflareRecoverySummary {
  pendingCount: number;
  pendingUnits: number;
  liableCount: number;
  liableUnits: number;
}

export interface CloudflareDirectRecovery {
  reservationId: string;
  state: 'pending' | 'liable';
  reservedUnits: number;
}

export interface CloudflareRecoveryReport {
  aggregate: CloudflareRecoverySummary;
  direct?: CloudflareDirectRecovery;
}

export type CloudflareStoreErrorCode =
  | 'not_found_or_expired'
  | 'settlement_conflict'
  | 'actual_units_exceed_reserved';

export type CloudflareStoreEnvelope<T> =
  | { ok: true; result: T; recovery: CloudflareRecoveryReport }
  | { ok: false; error: CloudflareStoreErrorCode; recovery: CloudflareRecoveryReport };

export interface CloudflareHashedBudget {
  id: string;
  limit: number;
}

export interface CloudflareReserveCommand {
  reservationId: string;
  units: number;
  budgets: readonly CloudflareHashedBudget[];
  ttlMs: number;
  cleanupBatchSize: number;
  idempotencyTtlMs: number;
}

export type CloudflareReserveReply =
  | {
      accepted: true;
      expiresAt: number;
      remainingByBudget: readonly { id: string; remaining: number }[];
    }
  | {
      accepted: false;
      reason: 'quota_exceeded' | 'duplicate_operation';
      limitingBudgetId?: string;
      remaining?: number;
    };

export interface CloudflareMarkLiableCommand {
  reservationId: string;
  idempotencyTtlMs: number;
}

export interface CloudflareRenewCommand {
  reservationId: string;
  ttlMs: number;
  idempotencyTtlMs: number;
}

export interface CloudflareSettleCommand {
  reservationId: string;
  actualUnits: number;
  outcomeHash: string;
  idempotencyTtlMs: number;
}

export interface CloudflareSettlementReply {
  reservedUnits: number;
  actualUnits: number;
  releasedUnits: number;
  replayed: boolean;
}

/** Structural type for a Durable Object RPC stub. */
export interface CloudflareUsageDurableObjectStub {
  reserve(command: CloudflareReserveCommand): Promise<CloudflareStoreEnvelope<CloudflareReserveReply>>;
  markLiable(
    command: CloudflareMarkLiableCommand,
  ): Promise<CloudflareStoreEnvelope<{ expiresAt: number }>>;
  renew(command: CloudflareRenewCommand): Promise<CloudflareStoreEnvelope<{ expiresAt: number }>>;
  settle(
    command: CloudflareSettleCommand,
  ): Promise<CloudflareStoreEnvelope<CloudflareSettlementReply>>;
}

/**
 * Structural namespace type so this package does not force generated Cloudflare
 * runtime types on Node-only remote clients.
 */
export interface CloudflareDurableObjectNamespace {
  getByName?(name: string): CloudflareUsageDurableObjectStub;
  idFromName?(name: string): unknown;
  get?(id: unknown): CloudflareUsageDurableObjectStub;
}

export interface CloudflareUsageStoreOptions {
  /** One Durable Object is one atomic usage-control transaction domain. */
  domainName?: string;
  /** Maximum expired reservations/tombstones reclaimed by one reserve call. */
  cleanupBatchSize?: number;
  /** Settled replay-protection period. Defaults to 24 hours. */
  idempotencyTtlMs?: number;
  /** Optional best-effort recovery observer. */
  observer?: UsageObserver;
}

interface NormalizedCloudflareUsageStoreOptions {
  domainName: string;
  cleanupBatchSize: number;
  idempotencyTtlMs: number;
  observer?: UsageObserver;
}

interface PreparedReserve {
  command: CloudflareReserveCommand;
  reservationId: string;
  budgets: Budget[];
  budgetById: Map<string, Budget>;
}

const RESERVATION_ID_PATTERN = /^cf1\.[a-f0-9]{64}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_PATH = '/v1/usage-store';
const MAX_GATEWAY_BODY_BYTES = 65_536;

/** Worker-local UsageStore backed by a Durable Object namespace binding. */
export class CloudflareUsageStore implements UsageStore {
  private readonly options: NormalizedCloudflareUsageStoreOptions;

  constructor(
    private readonly namespace: CloudflareDurableObjectNamespace,
    options: CloudflareUsageStoreOptions = {},
  ) {
    this.options = normalizeOptions(options);
  }

  async reserve(input: {
    request: UsageRequest;
    units: number;
    budgets: readonly Budget[];
    ttlMs: number;
  }): Promise<StoreReserveResult> {
    const prepared = await prepareReserve(input, this.options);
    const envelope = await this.stub().reserve(prepared.command);
    this.emitRecovery(envelope.recovery);
    if (!envelope.ok) throw mapStoreError(envelope.error);
    return mapReserveReply(envelope.result, prepared, input.request, input.units);
  }

  async markLiable(input: MarkLiableInput): Promise<MarkLiableResult> {
    assertReservationId(input.reservationId);
    const envelope = await this.stub().markLiable({
      reservationId: input.reservationId,
      idempotencyTtlMs: this.options.idempotencyTtlMs,
    });
    this.emitRecovery(envelope.recovery);
    if (!envelope.ok) throw mapStoreError(envelope.error);
    return { reservationId: input.reservationId, expiresAt: envelope.result.expiresAt };
  }

  async renew(input: RenewInput): Promise<RenewResult> {
    assertReservationId(input.reservationId);
    assertPositiveInteger(input.ttlMs, 'ttlMs');
    const envelope = await this.stub().renew({
      reservationId: input.reservationId,
      ttlMs: input.ttlMs,
      idempotencyTtlMs: this.options.idempotencyTtlMs,
    });
    this.emitRecovery(envelope.recovery);
    if (!envelope.ok) throw mapStoreError(envelope.error);
    return { reservationId: input.reservationId, expiresAt: envelope.result.expiresAt };
  }

  async settle(input: SettleInput): Promise<SettlementResult> {
    assertReservationId(input.reservationId);
    assertNonNegativeInteger(input.actualUnits, 'actualUnits');
    const outcomeHash = await digest(input.outcome);
    const envelope = await this.stub().settle({
      reservationId: input.reservationId,
      actualUnits: input.actualUnits,
      outcomeHash,
      idempotencyTtlMs: this.options.idempotencyTtlMs,
    });
    this.emitRecovery(envelope.recovery);
    if (!envelope.ok) throw mapStoreError(envelope.error);
    return {
      reservationId: input.reservationId,
      reservedUnits: envelope.result.reservedUnits,
      actualUnits: envelope.result.actualUnits,
      releasedUnits: envelope.result.releasedUnits,
      outcome: input.outcome,
    };
  }

  private stub(): CloudflareUsageDurableObjectStub {
    return resolveStub(this.namespace, this.options.domainName);
  }

  private emitRecovery(report: CloudflareRecoveryReport): void {
    emitRecovery(this.options.observer, report);
  }
}

export interface RemoteCloudflareUsageStoreOptions {
  /** HTTPS endpoint exposing createCloudflareUsageStoreGateway(). */
  endpoint: string;
  /** Authorization or other request headers. Prefer a callback for rotating credentials. */
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  /** Override fetch for tests or custom transports. No automatic retry is performed. */
  fetch?: typeof fetch;
  /** Full-call timeout covering header resolution, fetch, and response decoding. Defaults to 10 seconds. */
  timeoutMs?: number;
  /** Optional best-effort recovery observer. */
  observer?: UsageObserver;
}

export class CloudflareUsageTransportError extends Error {
  constructor(
    public readonly code: 'timeout' | 'network' | 'unauthorized' | 'remote' | 'protocol',
    /** Bounded HTTP status metadata when a response was received. Response bodies are never exposed. */
    public readonly status?: number,
  ) {
    super('Cloudflare usage store transport failed');
    this.name = 'CloudflareUsageTransportError';
  }
}

/** Node/edge remote UsageStore for a separately deployed Cloudflare gateway Worker. */
export class RemoteCloudflareUsageStore implements UsageStore {
  private readonly endpoint: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly observer?: UsageObserver;

  constructor(private readonly options: RemoteCloudflareUsageStoreOptions) {
    this.endpoint = new URL(options.endpoint);
    const isLocalHttp =
      this.endpoint.protocol === 'http:' &&
      (this.endpoint.hostname === '127.0.0.1' || this.endpoint.hostname === 'localhost');
    if (this.endpoint.protocol !== 'https:' && !isLocalHttp) {
      throw new RangeError('Cloudflare usage store endpoint must use HTTPS (local HTTP is test-only)');
    }
    if (this.endpoint.username || this.endpoint.password) {
      throw new RangeError('Cloudflare usage store endpoint must not embed credentials');
    }
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    assertPositiveInteger(this.timeoutMs, 'timeoutMs');
    this.observer = options.observer;
  }

  async reserve(input: {
    request: UsageRequest;
    units: number;
    budgets: readonly Budget[];
    ttlMs: number;
  }): Promise<StoreReserveResult> {
    const prepared = await prepareReserve(input, {
      cleanupBatchSize: 1,
      idempotencyTtlMs: 1,
    });
    const envelope = await this.post<CloudflareReserveReply>({
      version: 1,
      method: 'reserve',
      input: {
        reservationId: prepared.command.reservationId,
        units: prepared.command.units,
        budgets: prepared.command.budgets,
        ttlMs: prepared.command.ttlMs,
      },
    });
    this.emitRecovery(envelope.recovery);
    if (!envelope.ok) throw mapStoreError(envelope.error);
    return mapReserveReply(envelope.result, prepared, input.request, input.units);
  }

  async markLiable(input: MarkLiableInput): Promise<MarkLiableResult> {
    assertReservationId(input.reservationId);
    const envelope = await this.post<{ expiresAt: number }>({
      version: 1,
      method: 'mark_liable',
      input: { reservationId: input.reservationId },
    });
    this.emitRecovery(envelope.recovery);
    if (!envelope.ok) throw mapStoreError(envelope.error);
    return { reservationId: input.reservationId, expiresAt: envelope.result.expiresAt };
  }

  async renew(input: RenewInput): Promise<RenewResult> {
    assertReservationId(input.reservationId);
    assertPositiveInteger(input.ttlMs, 'ttlMs');
    const envelope = await this.post<{ expiresAt: number }>({
      version: 1,
      method: 'renew',
      input: { reservationId: input.reservationId, ttlMs: input.ttlMs },
    });
    this.emitRecovery(envelope.recovery);
    if (!envelope.ok) throw mapStoreError(envelope.error);
    return { reservationId: input.reservationId, expiresAt: envelope.result.expiresAt };
  }

  async settle(input: SettleInput): Promise<SettlementResult> {
    assertReservationId(input.reservationId);
    assertNonNegativeInteger(input.actualUnits, 'actualUnits');
    const outcomeHash = await digest(input.outcome);
    const envelope = await this.post<CloudflareSettlementReply>({
      version: 1,
      method: 'settle',
      input: {
        reservationId: input.reservationId,
        actualUnits: input.actualUnits,
        outcomeHash,
      },
    });
    this.emitRecovery(envelope.recovery);
    if (!envelope.ok) throw mapStoreError(envelope.error);
    return {
      reservationId: input.reservationId,
      reservedUnits: envelope.result.reservedUnits,
      actualUnits: envelope.result.actualUnits,
      releasedUnits: envelope.result.releasedUnits,
      outcome: input.outcome,
    };
  }

  private async post<T>(body: CloudflareHttpRequest): Promise<CloudflareStoreEnvelope<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      let resolvedHeaders: HeadersInit | undefined;
      try {
        resolvedHeaders = await waitForAbort(resolveHeaders(this.options.headers), controller.signal);
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
          this.fetchImpl(this.endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
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
      if (!isEnvelope(payload)) throw new CloudflareUsageTransportError('protocol', response.status);
      return payload as CloudflareStoreEnvelope<T>;
    } finally {
      clearTimeout(timer);
    }
  }

  private emitRecovery(report: CloudflareRecoveryReport): void {
    emitRecovery(this.observer, report);
  }
}

export type CloudflareGatewayAuthorize = (request: Request) => boolean | Promise<boolean>;

export interface CloudflareUsageStoreGatewayOptions extends CloudflareUsageStoreOptions {
  namespace: CloudflareDurableObjectNamespace;
  /** Required application-defined auth. There is intentionally no allow-all default. */
  authorize: CloudflareGatewayAuthorize;
  /** Defaults to /v1/usage-store. */
  path?: string;
}

export type CloudflareHttpRequest =
  | {
      version: 1;
      method: 'reserve';
      input: {
        reservationId: string;
        units: number;
        budgets: readonly CloudflareHashedBudget[];
        ttlMs: number;
      };
    }
  | { version: 1; method: 'mark_liable'; input: { reservationId: string } }
  | { version: 1; method: 'renew'; input: { reservationId: string; ttlMs: number } }
  | {
      version: 1;
      method: 'settle';
      input: { reservationId: string; actualUnits: number; outcomeHash: string };
    };

/**
 * Creates a public-HTTP-compatible Worker handler for non-Cloudflare callers.
 * Authentication is mandatory and must be supplied by the application.
 */
export function createCloudflareUsageStoreGateway(options: CloudflareUsageStoreGatewayOptions) {
  const normalized = normalizeOptions(options);
  const path = options.path ?? DEFAULT_PATH;
  if (!path.startsWith('/')) throw new RangeError('gateway path must start with /');

  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== path) return responseJson({ error: 'not_found' }, 404);
    if (request.method !== 'POST') return responseJson({ error: 'method_not_allowed' }, 405);

    let authorized = false;
    try {
      authorized = await options.authorize(request);
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
    if (!isHttpRequest(body)) return responseJson({ error: 'invalid_request' }, 400);

    const stub = resolveStub(options.namespace, normalized.domainName);
    try {
      const envelope = await invokeGateway(stub, body, normalized);
      return responseJson(envelope, 200);
    } catch {
      // Never serialize raw Durable Object/runtime exceptions to remote callers.
      return responseJson({ error: 'store_unavailable' }, 503);
    }
  };
}

async function invokeGateway(
  stub: CloudflareUsageDurableObjectStub,
  body: CloudflareHttpRequest,
  options: NormalizedCloudflareUsageStoreOptions,
): Promise<CloudflareStoreEnvelope<unknown>> {
  switch (body.method) {
    case 'reserve':
      return stub.reserve({
        ...body.input,
        cleanupBatchSize: options.cleanupBatchSize,
        idempotencyTtlMs: options.idempotencyTtlMs,
      });
    case 'mark_liable':
      return stub.markLiable({
        reservationId: body.input.reservationId,
        idempotencyTtlMs: options.idempotencyTtlMs,
      });
    case 'renew':
      return stub.renew({
        reservationId: body.input.reservationId,
        ttlMs: body.input.ttlMs,
        idempotencyTtlMs: options.idempotencyTtlMs,
      });
    case 'settle':
      return stub.settle({
        reservationId: body.input.reservationId,
        actualUnits: body.input.actualUnits,
        outcomeHash: body.input.outcomeHash,
        idempotencyTtlMs: options.idempotencyTtlMs,
      });
  }
}

async function prepareReserve(
  input: {
    request: UsageRequest;
    units: number;
    budgets: readonly Budget[];
    ttlMs: number;
  },
  options: Pick<NormalizedCloudflareUsageStoreOptions, 'cleanupBatchSize' | 'idempotencyTtlMs'>,
): Promise<PreparedReserve> {
  validateRequestIdentity(input.request);
  assertNonNegativeInteger(input.units, 'units');
  assertPositiveInteger(input.ttlMs, 'ttlMs');
  const budgets = canonicalizeBudgets(input.budgets);
  const operationHash = await digest(
    JSON.stringify([
      input.request.principal.tenantId ?? null,
      input.request.principal.id,
      input.request.tool,
      input.request.operationId,
    ]),
  );
  const reservationId = `cf1.${operationHash}`;
  const budgetEntries = await Promise.all(
    budgets.map(async budget => ({ budget, id: await digest(budget.key) })),
  );
  const budgetById = new Map(budgetEntries.map(entry => [entry.id, entry.budget]));
  return {
    reservationId,
    budgets,
    budgetById,
    command: {
      reservationId,
      units: input.units,
      budgets: budgetEntries.map(entry => ({ id: entry.id, limit: entry.budget.limit })),
      ttlMs: input.ttlMs,
      cleanupBatchSize: options.cleanupBatchSize,
      idempotencyTtlMs: options.idempotencyTtlMs,
    },
  };
}

function mapReserveReply(
  reply: CloudflareReserveReply,
  prepared: PreparedReserve,
  request: UsageRequest,
  units: number,
): StoreReserveResult {
  if (!reply.accepted) {
    if (reply.reason === 'duplicate_operation') return { accepted: false, reason: reply.reason };
    if (!reply.limitingBudgetId || reply.remaining === undefined) {
      throw new UsageStateError('Cloudflare quota reply was incomplete');
    }
    const budget = prepared.budgetById.get(reply.limitingBudgetId);
    if (!budget) throw new UsageStateError('Cloudflare quota reply referenced an unknown budget');
    return {
      accepted: false,
      reason: 'quota_exceeded',
      limitingBudgetKey: budget.key,
      remaining: reply.remaining,
    };
  }

  const remainingByBudget: BudgetRemaining[] = reply.remainingByBudget.map(balance => {
    const budget = prepared.budgetById.get(balance.id);
    if (!budget) throw new UsageStateError('Cloudflare reserve reply referenced an unknown budget');
    return { key: budget.key, remaining: balance.remaining };
  });
  if (remainingByBudget.length !== prepared.budgets.length) {
    throw new UsageStateError('Cloudflare reserve reply omitted a budget balance');
  }

  return {
    accepted: true,
    reservation: {
      id: prepared.reservationId,
      operationId: request.operationId,
      principalId: request.principal.id,
      ...(request.principal.tenantId === undefined ? {} : { tenantId: request.principal.tenantId }),
      ...(request.principal.plan === undefined ? {} : { plan: request.principal.plan }),
      tool: request.tool,
      budgetKeys: prepared.budgets.map(budget => budget.key),
      reservedUnits: units,
      expiresAt: reply.expiresAt,
    },
    remainingByBudget,
  };
}

function emitRecovery(observer: UsageObserver, report: CloudflareRecoveryReport): void {
  if (report.direct) {
    emitUsageEvent(observer, {
      type: 'reservation.recovered',
      timestamp: Date.now(),
      store: 'cloudflare',
      recovery: report.direct.state === 'pending' ? 'pending_released' : 'liable_retained',
      reservationId: report.direct.reservationId,
      reservedUnits: report.direct.reservedUnits,
      count: 1,
    });
  }
  if (report.aggregate.pendingCount > 0) {
    emitUsageEvent(observer, {
      type: 'reservation.recovered',
      timestamp: Date.now(),
      store: 'cloudflare',
      recovery: 'pending_released',
      reservedUnits: report.aggregate.pendingUnits,
      count: report.aggregate.pendingCount,
    });
  }
  if (report.aggregate.liableCount > 0) {
    emitUsageEvent(observer, {
      type: 'reservation.recovered',
      timestamp: Date.now(),
      store: 'cloudflare',
      recovery: 'liable_retained',
      reservedUnits: report.aggregate.liableUnits,
      count: report.aggregate.liableCount,
    });
  }
}

function mapStoreError(code: CloudflareStoreErrorCode): UsageStateError {
  switch (code) {
    case 'settlement_conflict':
      return new UsageStateError('Reservation was already settled with a different result');
    case 'actual_units_exceed_reserved':
      return new UsageStateError('actualUnits cannot exceed reservedUnits');
    case 'not_found_or_expired':
      return new UsageStateError('Reservation not found or expired');
  }
}

function resolveStub(
  namespace: CloudflareDurableObjectNamespace,
  domainName: string,
): CloudflareUsageDurableObjectStub {
  if (namespace.getByName) return namespace.getByName(domainName);
  if (namespace.idFromName && namespace.get) return namespace.get(namespace.idFromName(domainName));
  throw new TypeError('Durable Object namespace must provide getByName() or idFromName()+get()');
}

function normalizeOptions(options: CloudflareUsageStoreOptions): NormalizedCloudflareUsageStoreOptions {
  const domainName = options.domainName ?? 'default';
  const cleanupBatchSize = options.cleanupBatchSize ?? 256;
  const idempotencyTtlMs = options.idempotencyTtlMs ?? 86_400_000;
  if (domainName.length === 0 || domainName.length > 128) {
    throw new RangeError('domainName must be between 1 and 128 characters');
  }
  assertPositiveInteger(cleanupBatchSize, 'cleanupBatchSize');
  assertPositiveInteger(idempotencyTtlMs, 'idempotencyTtlMs');
  return {
    domainName,
    cleanupBatchSize,
    idempotencyTtlMs,
    ...(options.observer === undefined ? {} : { observer: options.observer }),
  };
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

function assertReservationId(value: string): void {
  if (!RESERVATION_ID_PATTERN.test(value)) throw new UsageStateError('Invalid Cloudflare reservation ID');
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
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
  headers: RemoteCloudflareUsageStoreOptions['headers'],
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
    promise.then(
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

function isHttpRequest(value: unknown): value is CloudflareHttpRequest {
  if (!isRecord(value) || value.version !== 1 || typeof value.method !== 'string' || !isRecord(value.input)) {
    return false;
  }
  const input = value.input;
  switch (value.method) {
    case 'reserve':
      return (
        isReservationId(input.reservationId) &&
        isNonNegativeInteger(input.units) &&
        isPositiveInteger(input.ttlMs) &&
        Array.isArray(input.budgets) &&
        input.budgets.length > 0 &&
        input.budgets.every(
          budget =>
            isRecord(budget) &&
            typeof budget.id === 'string' &&
            HASH_PATTERN.test(budget.id) &&
            isNonNegativeInteger(budget.limit),
        )
      );
    case 'mark_liable':
      return isReservationId(input.reservationId);
    case 'renew':
      return isReservationId(input.reservationId) && isPositiveInteger(input.ttlMs);
    case 'settle':
      return (
        isReservationId(input.reservationId) &&
        isNonNegativeInteger(input.actualUnits) &&
        typeof input.outcomeHash === 'string' &&
        HASH_PATTERN.test(input.outcomeHash)
      );
    default:
      return false;
  }
}

function isEnvelope(value: unknown): value is CloudflareStoreEnvelope<unknown> {
  if (!isRecord(value) || typeof value.ok !== 'boolean' || !isRecoveryReport(value.recovery)) return false;
  if (value.ok) return 'result' in value;
  return (
    typeof value.error === 'string' &&
    ['not_found_or_expired', 'settlement_conflict', 'actual_units_exceed_reserved'].includes(value.error)
  );
}

function isRecoveryReport(value: unknown): value is CloudflareRecoveryReport {
  if (!isRecord(value) || !isRecoverySummary(value.aggregate)) return false;
  if (value.direct === undefined) return true;
  return (
    isRecord(value.direct) &&
    isReservationId(value.direct.reservationId) &&
    (value.direct.state === 'pending' || value.direct.state === 'liable') &&
    isNonNegativeInteger(value.direct.reservedUnits)
  );
}

function isRecoverySummary(value: unknown): value is CloudflareRecoverySummary {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.pendingCount) &&
    isNonNegativeInteger(value.pendingUnits) &&
    isNonNegativeInteger(value.liableCount) &&
    isNonNegativeInteger(value.liableUnits)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isReservationId(value: unknown): value is string {
  return typeof value === 'string' && RESERVATION_ID_PATTERN.test(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function responseJson(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
