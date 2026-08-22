import {
  UsageStateError,
  emitUsageEvent,
  type Budget,
  type BudgetRemaining,
  type GrowReservationInput,
  type MarkLiableInput,
  type ProgressiveUsageStore,
  type MarkLiableResult,
  type RenewInput,
  type RenewResult,
  type SettleInput,
  type SettlementResult,
  type StoreGrowResult,
  type StoreReserveResult,
  type UsageObserver,
  type UsageRequest,
  type UsageStore,
  type UsageDimension,
  type UsageDimensionActual,
  type UsageDimensionGrowth,
  type UsageDimensionReserved,
  type VectorBudgetRemaining,
  type VectorGrowReservationInput,
  type VectorReserveInput,
  type VectorSettleInput,
  type VectorSettlementResult,
  type VectorUsageStore,
  type StoreVectorGrowResult,
  type StoreVectorReserveResult,
} from 'mcp-usage-control';

export interface CloudflareRecoverySummary {
  pendingCount: number;
  pendingUnits: number;
  liableCount: number;
  liableUnits: number;
  vectorPendingCount?: number;
  vectorLiableCount?: number;
}

export type CloudflareDirectRecovery =
  | {
      reservationId: string;
      state: 'pending' | 'liable';
      reservedUnits: number;
    }
  | {
      reservationId: string;
      state: 'pending' | 'liable';
      vector: true;
      dimensionCount: number;
      budgetCount: number;
    };

export interface CloudflareRecoveryReport {
  aggregate: CloudflareRecoverySummary;
  direct?: CloudflareDirectRecovery;
}

export type CloudflareStoreErrorCode =
  | 'not_found_or_expired'
  | 'settlement_conflict'
  | 'actual_units_exceed_reserved'
  | 'growth_conflict'
  | 'growth_stale_cursor'
  | 'growth_budget_mismatch'
  | 'growth_not_supported'
  | 'vector_dimension_mismatch'
  | 'usage_mode_mismatch';

export type CloudflareStoreEnvelope<T> =
  | { ok: true; result: T; recovery: CloudflareRecoveryReport }
  | { ok: false; error: CloudflareStoreErrorCode; recovery: CloudflareRecoveryReport };

export interface CloudflareHashedBudget {
  id: string;
  limit: number;
}

export interface CloudflareHashedDimension {
  id: string;
  units: number;
  budgets: readonly CloudflareHashedBudget[];
}

export interface CloudflareVectorGrowthDimension {
  id: string;
  additionalUnits: number;
  budgets: readonly CloudflareHashedBudget[];
}

export interface CloudflareVectorActualDimension {
  id: string;
  actualUnits: number;
}

export interface CloudflareReserveCommand {
  reservationId: string;
  units: number;
  budgets: readonly CloudflareHashedBudget[];
  ttlMs: number;
  cleanupBatchSize: number;
  idempotencyTtlMs: number;
  initialGrowthCursor: string;
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

export interface CloudflareVectorReserveCommand {
  reservationId: string;
  dimensions: readonly CloudflareHashedDimension[];
  ttlMs: number;
  cleanupBatchSize: number;
  idempotencyTtlMs: number;
  initialGrowthCursor: string;
}

export type CloudflareVectorReserveReply =
  | {
      accepted: true;
      expiresAt: number;
      remainingByBudget: readonly { dimensionId: string; budgetId: string; remaining: number }[];
    }
  | {
      accepted: false;
      reason: 'quota_exceeded' | 'duplicate_operation';
      limitingDimensionId?: string;
      limitingBudgetId?: string;
      remaining?: number;
    };

export interface CloudflareGrowCommand {
  reservationId: string;
  incrementHash: string;
  expectedGrowthCursor: string;
  additionalUnits: number;
  budgets: readonly CloudflareHashedBudget[];
  fingerprint: string;
  nextGrowthCursor: string;
  idempotencyTtlMs: number;
}

export type CloudflareGrowReply =
  | {
      accepted: true;
      replayed: boolean;
      previousReservedUnits: number;
      reservedUnits: number;
      growthCursor: string;
      remainingByBudget: readonly { id: string; remaining: number }[];
    }
  | {
      accepted: false;
      reason: 'quota_exceeded';
      replayed: boolean;
      growthCursor: string;
      limitingBudgetId: string;
      remaining: number;
    };

export interface CloudflareVectorGrowCommand {
  reservationId: string;
  incrementHash: string;
  expectedGrowthCursor: string;
  dimensions: readonly CloudflareVectorGrowthDimension[];
  fingerprint: string;
  nextGrowthCursor: string;
  idempotencyTtlMs: number;
}

export type CloudflareVectorGrowReply =
  | {
      accepted: true;
      replayed: boolean;
      previousReservedByDimension: readonly { id: string; reservedUnits: number }[];
      reservedByDimension: readonly { id: string; reservedUnits: number }[];
      growthCursor: string;
      remainingByBudget: readonly { dimensionId: string; budgetId: string; remaining: number }[];
    }
  | {
      accepted: false;
      reason: 'quota_exceeded';
      replayed: boolean;
      growthCursor: string;
      limitingDimensionId: string;
      limitingBudgetId: string;
      remaining: number;
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

export interface CloudflareVectorSettleCommand {
  reservationId: string;
  actualByDimension: readonly CloudflareVectorActualDimension[];
  outcomeHash: string;
  idempotencyTtlMs: number;
}

export interface CloudflareVectorSettlementReply {
  dimensions: readonly { id: string; reservedUnits: number; actualUnits: number; releasedUnits: number }[];
  replayed: boolean;
}

/** Structural type for a Durable Object RPC stub. */
export interface CloudflareUsageDurableObjectStub {
  reserve(command: CloudflareReserveCommand): Promise<CloudflareStoreEnvelope<CloudflareReserveReply>>;
  reserveVector?(
    command: CloudflareVectorReserveCommand,
  ): Promise<CloudflareStoreEnvelope<CloudflareVectorReserveReply>>;
  grow?(command: CloudflareGrowCommand): Promise<CloudflareStoreEnvelope<CloudflareGrowReply>>;
  growVector?(
    command: CloudflareVectorGrowCommand,
  ): Promise<CloudflareStoreEnvelope<CloudflareVectorGrowReply>>;
  markLiable(
    command: CloudflareMarkLiableCommand,
  ): Promise<CloudflareStoreEnvelope<{ expiresAt: number }>>;
  renew(command: CloudflareRenewCommand): Promise<CloudflareStoreEnvelope<{ expiresAt: number }>>;
  settle(
    command: CloudflareSettleCommand,
  ): Promise<CloudflareStoreEnvelope<CloudflareSettlementReply>>;
  settleVector?(
    command: CloudflareVectorSettleCommand,
  ): Promise<CloudflareStoreEnvelope<CloudflareVectorSettlementReply>>;
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

interface PreparedGrowth {
  command: CloudflareGrowCommand;
  budgetById: Map<string, Budget>;
}

interface PreparedVectorReserve {
  command: CloudflareVectorReserveCommand;
  reservationId: string;
  dimensions: UsageDimension[];
  dimensionById: Map<string, UsageDimension>;
  budgetById: Map<string, Budget>;
}

interface PreparedVectorGrowth {
  command: CloudflareVectorGrowCommand;
  dimensionById: Map<string, UsageDimensionGrowth>;
  budgetById: Map<string, Budget>;
}

interface PreparedVectorSettlement {
  command: CloudflareVectorSettleCommand;
  dimensionKeyById: Map<string, string>;
}

const RESERVATION_ID_PATTERN = /^cf1\.[a-f0-9]{64}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_PATH = '/v1/usage-store';
const MAX_GATEWAY_BODY_BYTES = 65_536;

/** Worker-local UsageStore backed by a Durable Object namespace binding. */
export class CloudflareUsageStore implements ProgressiveUsageStore, VectorUsageStore {
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

  async reserveVector(input: VectorReserveInput): Promise<StoreVectorReserveResult> {
    const prepared = await prepareVectorReserve(input, this.options);
    const stub = this.stub();
    if (!stub.reserveVector) {
      throw new UsageStateError('Cloudflare Durable Object does not support atomic vector usage');
    }
    const envelope = await stub.reserveVector(prepared.command);
    this.emitRecovery(envelope.recovery);
    if (!envelope.ok) throw mapStoreError(envelope.error);
    return mapVectorReserveReply(envelope.result, prepared, input.request);
  }

  async growVectorReservation(input: VectorGrowReservationInput): Promise<StoreVectorGrowResult> {
    const prepared = await prepareVectorGrowth(input, this.options.idempotencyTtlMs);
    const stub = this.stub();
    if (!stub.growVector) {
      throw new UsageStateError('Cloudflare Durable Object does not support atomic vector usage');
    }
    const envelope = await stub.growVector(prepared.command);
    this.emitRecovery(envelope.recovery);
    if (!envelope.ok) throw mapStoreError(envelope.error);
    return mapVectorGrowthReply(envelope.result, input, prepared);
  }

  async settleVector(input: VectorSettleInput): Promise<VectorSettlementResult> {
    const prepared = await prepareVectorSettlement(input, this.options.idempotencyTtlMs);
    const stub = this.stub();
    if (!stub.settleVector) {
      throw new UsageStateError('Cloudflare Durable Object does not support atomic vector usage');
    }
    const envelope = await stub.settleVector(prepared.command);
    this.emitRecovery(envelope.recovery);
    if (!envelope.ok) throw mapStoreError(envelope.error);
    return mapVectorSettlementReply(envelope.result, input, prepared);
  }

  async growReservation(input: GrowReservationInput): Promise<StoreGrowResult> {
    const prepared = await prepareGrowth(input, this.options.idempotencyTtlMs);
    const stub = this.stub();
    if (!stub.grow) throw new UsageStateError('Cloudflare Durable Object does not support progressive growth');
    const envelope = await stub.grow(prepared.command);
    this.emitRecovery(envelope.recovery);
    if (!envelope.ok) throw mapStoreError(envelope.error);
    return mapGrowthReply(envelope.result, input, prepared);
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
  /**
   * Full-call timeout covering header resolution, fetch, and response decoding. Defaults to 10 seconds.
   * Must not exceed 2,147,483,647ms, the portable setTimeout ceiling used by supported runtimes.
   */
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
export class RemoteCloudflareUsageStore implements ProgressiveUsageStore, VectorUsageStore {
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
    assertPortableTimerDelay(this.timeoutMs, 'timeoutMs');
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
        initialGrowthCursor: prepared.command.initialGrowthCursor,
      },
    });
    this.emitRecovery(envelope.recovery);
    if (!envelope.ok) throw mapStoreError(envelope.error);
    return mapReserveReply(envelope.result, prepared, input.request, input.units);
  }

  async reserveVector(input: VectorReserveInput): Promise<StoreVectorReserveResult> {
    const prepared = await prepareVectorReserve(input, { cleanupBatchSize: 1, idempotencyTtlMs: 1 });
    const envelope = await this.post<CloudflareVectorReserveReply>({
      version: 1,
      method: 'reserve_vector',
      input: {
        reservationId: prepared.command.reservationId,
        dimensions: prepared.command.dimensions,
        ttlMs: prepared.command.ttlMs,
        initialGrowthCursor: prepared.command.initialGrowthCursor,
      },
    });
    this.emitRecovery(envelope.recovery);
    if (!envelope.ok) throw mapStoreError(envelope.error);
    return mapVectorReserveReply(envelope.result, prepared, input.request);
  }

  async growVectorReservation(input: VectorGrowReservationInput): Promise<StoreVectorGrowResult> {
    const prepared = await prepareVectorGrowth(input, 1);
    const envelope = await this.post<CloudflareVectorGrowReply>({
      version: 1,
      method: 'grow_vector',
      input: {
        reservationId: prepared.command.reservationId,
        incrementHash: prepared.command.incrementHash,
        expectedGrowthCursor: prepared.command.expectedGrowthCursor,
        dimensions: prepared.command.dimensions,
        fingerprint: prepared.command.fingerprint,
        nextGrowthCursor: prepared.command.nextGrowthCursor,
      },
    });
    this.emitRecovery(envelope.recovery);
    if (!envelope.ok) throw mapStoreError(envelope.error);
    return mapVectorGrowthReply(envelope.result, input, prepared);
  }

  async settleVector(input: VectorSettleInput): Promise<VectorSettlementResult> {
    const prepared = await prepareVectorSettlement(input, 1);
    const envelope = await this.post<CloudflareVectorSettlementReply>({
      version: 1,
      method: 'settle_vector',
      input: {
        reservationId: prepared.command.reservationId,
        actualByDimension: prepared.command.actualByDimension,
        outcomeHash: prepared.command.outcomeHash,
      },
    });
    this.emitRecovery(envelope.recovery);
    if (!envelope.ok) throw mapStoreError(envelope.error);
    return mapVectorSettlementReply(envelope.result, input, prepared);
  }

  async growReservation(input: GrowReservationInput): Promise<StoreGrowResult> {
    const prepared = await prepareGrowth(input, 1);
    const envelope = await this.post<CloudflareGrowReply>({
      version: 1,
      method: 'grow',
      input: {
        reservationId: prepared.command.reservationId,
        incrementHash: prepared.command.incrementHash,
        expectedGrowthCursor: prepared.command.expectedGrowthCursor,
        additionalUnits: prepared.command.additionalUnits,
        budgets: prepared.command.budgets,
        fingerprint: prepared.command.fingerprint,
        nextGrowthCursor: prepared.command.nextGrowthCursor,
      },
    });
    this.emitRecovery(envelope.recovery);
    if (!envelope.ok) throw mapStoreError(envelope.error);
    return mapGrowthReply(envelope.result, input, prepared);
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
      if (!isEnvelopeForRequest(payload, body)) {
        throw new CloudflareUsageTransportError('protocol', response.status);
      }
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
        initialGrowthCursor: string;
      };
    }
  | {
      version: 1;
      method: 'reserve_vector';
      input: {
        reservationId: string;
        dimensions: readonly CloudflareHashedDimension[];
        ttlMs: number;
        initialGrowthCursor: string;
      };
    }
  | {
      version: 1;
      method: 'grow';
      input: {
        reservationId: string;
        incrementHash: string;
        expectedGrowthCursor: string;
        additionalUnits: number;
        budgets: readonly CloudflareHashedBudget[];
        fingerprint: string;
        nextGrowthCursor: string;
      };
    }
  | {
      version: 1;
      method: 'grow_vector';
      input: {
        reservationId: string;
        incrementHash: string;
        expectedGrowthCursor: string;
        dimensions: readonly CloudflareVectorGrowthDimension[];
        fingerprint: string;
        nextGrowthCursor: string;
      };
    }
  | { version: 1; method: 'mark_liable'; input: { reservationId: string } }
  | { version: 1; method: 'renew'; input: { reservationId: string; ttlMs: number } }
  | {
      version: 1;
      method: 'settle';
      input: { reservationId: string; actualUnits: number; outcomeHash: string };
    }
  | {
      version: 1;
      method: 'settle_vector';
      input: {
        reservationId: string;
        actualByDimension: readonly CloudflareVectorActualDimension[];
        outcomeHash: string;
      };
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
      authorized = (await options.authorize(request)) === true;
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
    case 'reserve_vector':
      if (!stub.reserveVector) return failGatewayVectorUnsupported();
      return stub.reserveVector({
        ...body.input,
        cleanupBatchSize: options.cleanupBatchSize,
        idempotencyTtlMs: options.idempotencyTtlMs,
      });
    case 'grow':
      if (!stub.grow) return failGatewayGrowthUnsupported();
      return stub.grow({
        ...body.input,
        idempotencyTtlMs: options.idempotencyTtlMs,
      });
    case 'grow_vector':
      if (!stub.growVector) return failGatewayVectorUnsupported();
      return stub.growVector({
        ...body.input,
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
    case 'settle_vector':
      if (!stub.settleVector) return failGatewayVectorUnsupported();
      return stub.settleVector({
        reservationId: body.input.reservationId,
        actualByDimension: body.input.actualByDimension,
        outcomeHash: body.input.outcomeHash,
        idempotencyTtlMs: options.idempotencyTtlMs,
      });
  }
}

function failGatewayGrowthUnsupported(): CloudflareStoreEnvelope<never> {
  return {
    ok: false,
    error: 'growth_not_supported',
    recovery: {
      aggregate: {
        pendingCount: 0,
        pendingUnits: 0,
        liableCount: 0,
        liableUnits: 0,
        vectorPendingCount: 0,
        vectorLiableCount: 0,
      },
    },
  };
}

function failGatewayVectorUnsupported(): CloudflareStoreEnvelope<never> {
  return {
    ok: false,
    error: 'growth_not_supported',
    recovery: {
      aggregate: {
        pendingCount: 0,
        pendingUnits: 0,
        liableCount: 0,
        liableUnits: 0,
        vectorPendingCount: 0,
        vectorLiableCount: 0,
      },
    },
  };
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
  const initialGrowthCursor = newGrowthCursor();
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
      initialGrowthCursor,
    },
  };
}

async function prepareVectorReserve(
  input: VectorReserveInput,
  options: Pick<NormalizedCloudflareUsageStoreOptions, 'cleanupBatchSize' | 'idempotencyTtlMs'>,
): Promise<PreparedVectorReserve> {
  validateRequestIdentity(input.request);
  assertPositiveInteger(input.ttlMs, 'ttlMs');
  const dimensions = canonicalizeUsageDimensions(input.dimensions);
  const operationHash = await digest(
    JSON.stringify([
      input.request.principal.tenantId ?? null,
      input.request.principal.id,
      input.request.tool,
      input.request.operationId,
    ]),
  );
  const reservationId = `cf1.${operationHash}`;
  const encoded = await Promise.all(
    dimensions.map(async dimension => ({
      dimension,
      id: await digest(dimension.key),
      budgets: await Promise.all(
        dimension.budgets.map(async budget => ({ budget, id: await digest(budget.key) })),
      ),
    })),
  );
  const dimensionById = new Map(encoded.map(entry => [entry.id, entry.dimension] as const));
  const budgetById = new Map(
    encoded.flatMap(entry => entry.budgets.map(budget => [budget.id, budget.budget] as const)),
  );
  return {
    reservationId,
    dimensions,
    dimensionById,
    budgetById,
    command: {
      reservationId,
      dimensions: encoded.map(entry => ({
        id: entry.id,
        units: entry.dimension.units,
        budgets: entry.budgets.map(budget => ({ id: budget.id, limit: budget.budget.limit })),
      })),
      ttlMs: input.ttlMs,
      cleanupBatchSize: options.cleanupBatchSize,
      idempotencyTtlMs: options.idempotencyTtlMs,
      initialGrowthCursor: newGrowthCursor(),
    },
  };
}

async function prepareVectorGrowth(
  input: VectorGrowReservationInput,
  idempotencyTtlMs: number,
): Promise<PreparedVectorGrowth> {
  assertReservationId(input.reservationId);
  if (!input.incrementId) throw new RangeError('incrementId must be a non-empty string');
  if (!input.expectedGrowthCursor) {
    throw new RangeError('expectedGrowthCursor must be a non-empty string');
  }
  assertPositiveInteger(idempotencyTtlMs, 'idempotencyTtlMs');
  const dimensions = canonicalizeGrowthDimensions(input.dimensions);
  const encoded = await Promise.all(
    dimensions.map(async dimension => ({
      dimension,
      id: await digest(dimension.key),
      budgets: await Promise.all(
        dimension.budgets.map(async budget => ({ budget, id: await digest(budget.key) })),
      ),
    })),
  );
  const dimensionById = new Map(encoded.map(entry => [entry.id, entry.dimension] as const));
  const budgetById = new Map(
    encoded.flatMap(entry => entry.budgets.map(budget => [budget.id, budget.budget] as const)),
  );
  const encodedDimensions = encoded.map(entry => ({
    id: entry.id,
    additionalUnits: entry.dimension.additionalUnits,
    budgets: entry.budgets.map(budget => ({ id: budget.id, limit: budget.budget.limit })),
  }));
  return {
    dimensionById,
    budgetById,
    command: {
      reservationId: input.reservationId,
      incrementHash: await digest(input.incrementId),
      expectedGrowthCursor: input.expectedGrowthCursor,
      dimensions: encodedDimensions,
      fingerprint: await digest(
        JSON.stringify(
          encodedDimensions.map(dimension => [
            dimension.id,
            dimension.additionalUnits,
            dimension.budgets.map(budget => [budget.id, budget.limit]),
          ]),
        ),
      ),
      nextGrowthCursor: newGrowthCursor(),
      idempotencyTtlMs,
    },
  };
}

async function prepareVectorSettlement(
  input: VectorSettleInput,
  idempotencyTtlMs: number,
): Promise<PreparedVectorSettlement> {
  assertReservationId(input.reservationId);
  assertPositiveInteger(idempotencyTtlMs, 'idempotencyTtlMs');
  const actuals = canonicalizeActualDimensions(input.actualByDimension);
  const encoded = await Promise.all(
    actuals.map(async actual => ({ actual, id: await digest(actual.key) })),
  );
  return {
    dimensionKeyById: new Map(encoded.map(entry => [entry.id, entry.actual.key] as const)),
    command: {
      reservationId: input.reservationId,
      actualByDimension: encoded.map(entry => ({ id: entry.id, actualUnits: entry.actual.actualUnits })),
      outcomeHash: await digest(input.outcome),
      idempotencyTtlMs,
    },
  };
}

function mapVectorReserveReply(
  reply: CloudflareVectorReserveReply,
  prepared: PreparedVectorReserve,
  request: UsageRequest,
): StoreVectorReserveResult {
  if (!reply.accepted) {
    if (reply.reason === 'duplicate_operation') return { accepted: false, reason: reply.reason };
    if (!reply.limitingDimensionId || !reply.limitingBudgetId || reply.remaining === undefined) {
      throw new UsageStateError('Cloudflare vector quota reply was incomplete');
    }
    const dimension = prepared.dimensionById.get(reply.limitingDimensionId);
    const budget = prepared.budgetById.get(reply.limitingBudgetId);
    if (!dimension || !budget) {
      throw new UsageStateError('Cloudflare vector quota reply referenced unknown identifiers');
    }
    return {
      accepted: false,
      reason: 'quota_exceeded',
      limitingDimensionKey: dimension.key,
      limitingBudgetKey: budget.key,
      remaining: reply.remaining,
    };
  }
  const remainingByBudget: VectorBudgetRemaining[] = reply.remainingByBudget.map(balance => {
    const dimension = prepared.dimensionById.get(balance.dimensionId);
    const budget = prepared.budgetById.get(balance.budgetId);
    if (!dimension || !budget) {
      throw new UsageStateError('Cloudflare vector reserve reply referenced unknown identifiers');
    }
    return { dimensionKey: dimension.key, budgetKey: budget.key, remaining: balance.remaining };
  });
  if (remainingByBudget.length !== prepared.budgetById.size) {
    throw new UsageStateError('Cloudflare vector reserve reply omitted a budget balance');
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
      dimensions: prepared.dimensions.map(dimension => ({
        key: dimension.key,
        budgetKeys: dimension.budgets.map(budget => budget.key),
        reservedUnits: dimension.units,
      })),
      expiresAt: reply.expiresAt,
      growthCursor: prepared.command.initialGrowthCursor,
    },
    remainingByBudget,
  };
}

function mapVectorGrowthReply(
  reply: CloudflareVectorGrowReply,
  input: VectorGrowReservationInput,
  prepared: PreparedVectorGrowth,
): StoreVectorGrowResult {
  if (!reply.accepted) {
    const dimension = prepared.dimensionById.get(reply.limitingDimensionId);
    const budget = prepared.budgetById.get(reply.limitingBudgetId);
    if (!dimension || !budget) {
      throw new UsageStateError('Cloudflare vector growth denial referenced unknown identifiers');
    }
    return {
      accepted: false,
      reason: 'quota_exceeded',
      replayed: reply.replayed,
      reservationId: input.reservationId,
      incrementId: input.incrementId,
      growthCursor: reply.growthCursor,
      limitingDimensionKey: dimension.key,
      limitingBudgetKey: budget.key,
      remaining: reply.remaining,
    };
  }
  const mapReserved = (items: readonly { id: string; reservedUnits: number }[]): UsageDimensionReserved[] =>
    items.map(item => {
      const dimension = prepared.dimensionById.get(item.id);
      if (!dimension) throw new UsageStateError('Cloudflare vector growth reply referenced unknown dimension');
      return { key: dimension.key, reservedUnits: item.reservedUnits };
    });
  const remainingByBudget = reply.remainingByBudget.map(balance => {
    const dimension = prepared.dimensionById.get(balance.dimensionId);
    const budget = prepared.budgetById.get(balance.budgetId);
    if (!dimension || !budget) {
      throw new UsageStateError('Cloudflare vector growth reply referenced unknown identifiers');
    }
    return { dimensionKey: dimension.key, budgetKey: budget.key, remaining: balance.remaining };
  });
  if (remainingByBudget.length !== prepared.budgetById.size) {
    throw new UsageStateError('Cloudflare vector growth reply omitted a budget balance');
  }
  return {
    accepted: true,
    replayed: reply.replayed,
    reservationId: input.reservationId,
    incrementId: input.incrementId,
    previousReservedByDimension: mapReserved(reply.previousReservedByDimension),
    reservedByDimension: mapReserved(reply.reservedByDimension),
    growthCursor: reply.growthCursor,
    remainingByBudget,
  };
}

function mapVectorSettlementReply(
  reply: CloudflareVectorSettlementReply,
  input: VectorSettleInput,
  prepared: PreparedVectorSettlement,
): VectorSettlementResult {
  return {
    reservationId: input.reservationId,
    dimensions: reply.dimensions.map(dimension => {
      const key = prepared.dimensionKeyById.get(dimension.id);
      if (!key) throw new UsageStateError('Cloudflare vector settlement referenced unknown dimension');
      return {
        key,
        reservedUnits: dimension.reservedUnits,
        actualUnits: dimension.actualUnits,
        releasedUnits: dimension.releasedUnits,
      };
    }),
    outcome: input.outcome,
  };
}

async function prepareGrowth(
  input: GrowReservationInput,
  idempotencyTtlMs: number,
): Promise<PreparedGrowth> {
  assertReservationId(input.reservationId);
  if (typeof input.incrementId !== 'string' || input.incrementId.length === 0) {
    throw new RangeError('incrementId must be a non-empty string');
  }
  if (
    typeof input.expectedGrowthCursor !== 'string' ||
    input.expectedGrowthCursor.length === 0
  ) {
    throw new RangeError('expectedGrowthCursor must be a non-empty string');
  }
  assertPositiveInteger(input.additionalUnits, 'additionalUnits');
  assertPositiveInteger(idempotencyTtlMs, 'idempotencyTtlMs');
  const budgets = canonicalizeBudgets(input.budgets);
  const budgetEntries = await Promise.all(
    budgets.map(async budget => ({ budget, id: await digest(budget.key) })),
  );
  const budgetById = new Map(budgetEntries.map(entry => [entry.id, entry.budget]));
  const encodedBudgets = budgetEntries.map(entry => ({ id: entry.id, limit: entry.budget.limit }));
  return {
    budgetById,
    command: {
      reservationId: input.reservationId,
      incrementHash: await digest(input.incrementId),
      expectedGrowthCursor: input.expectedGrowthCursor,
      additionalUnits: input.additionalUnits,
      budgets: encodedBudgets,
      fingerprint: await digest(
        JSON.stringify([
          input.additionalUnits,
          encodedBudgets.map(budget => [budget.id, budget.limit]),
        ]),
      ),
      nextGrowthCursor: newGrowthCursor(),
      idempotencyTtlMs,
    },
  };
}

function mapGrowthReply(
  reply: CloudflareGrowReply,
  input: GrowReservationInput,
  prepared: PreparedGrowth,
): StoreGrowResult {
  if (!reply.accepted) {
    const budget = prepared.budgetById.get(reply.limitingBudgetId);
    if (!budget) throw new UsageStateError('Cloudflare growth quota reply referenced an unknown budget');
    return {
      accepted: false,
      reason: 'quota_exceeded',
      replayed: reply.replayed,
      reservationId: input.reservationId,
      incrementId: input.incrementId,
      growthCursor: reply.growthCursor,
      limitingBudgetKey: budget.key,
      remaining: reply.remaining,
    };
  }
  const remainingByBudget = reply.remainingByBudget.map(balance => {
    const budget = prepared.budgetById.get(balance.id);
    if (!budget) throw new UsageStateError('Cloudflare growth reply referenced an unknown budget');
    return { key: budget.key, remaining: balance.remaining };
  });
  if (remainingByBudget.length !== prepared.budgetById.size) {
    throw new UsageStateError('Cloudflare growth reply omitted a budget balance');
  }
  return {
    accepted: true,
    replayed: reply.replayed,
    reservationId: input.reservationId,
    incrementId: input.incrementId,
    previousReservedUnits: reply.previousReservedUnits,
    reservedUnits: reply.reservedUnits,
    growthCursor: reply.growthCursor,
    remainingByBudget,
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
      growthCursor: prepared.command.initialGrowthCursor,
    },
    remainingByBudget,
  };
}

function emitRecovery(observer: UsageObserver, report: CloudflareRecoveryReport): void {
  if (report.direct) {
    if ('vector' in report.direct) {
      emitUsageEvent(observer, {
        type: 'vector.reservation.recovered',
        timestamp: Date.now(),
        store: 'cloudflare',
        recovery: report.direct.state === 'pending' ? 'pending_released' : 'liable_retained',
        reservationId: report.direct.reservationId,
        dimensionCount: report.direct.dimensionCount,
        budgetCount: report.direct.budgetCount,
        count: 1,
      });
    } else {
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
  if ((report.aggregate.vectorPendingCount ?? 0) > 0) {
    emitUsageEvent(observer, {
      type: 'vector.reservation.recovered',
      timestamp: Date.now(),
      store: 'cloudflare',
      recovery: 'pending_released',
      count: report.aggregate.vectorPendingCount ?? 0,
    });
  }
  if ((report.aggregate.vectorLiableCount ?? 0) > 0) {
    emitUsageEvent(observer, {
      type: 'vector.reservation.recovered',
      timestamp: Date.now(),
      store: 'cloudflare',
      recovery: 'liable_retained',
      count: report.aggregate.vectorLiableCount ?? 0,
    });
  }
}

function mapStoreError(code: CloudflareStoreErrorCode): UsageStateError {
  switch (code) {
    case 'settlement_conflict':
      return new UsageStateError('Reservation was already settled with a different result');
    case 'actual_units_exceed_reserved':
      return new UsageStateError('actualUnits cannot exceed reservedUnits');
    case 'growth_conflict':
      return new UsageStateError('Growth increment was already attempted with different parameters');
    case 'growth_stale_cursor':
      return new UsageStateError('Growth cursor is stale or conflicts with reservation state');
    case 'growth_budget_mismatch':
      return new UsageStateError('Growth budgets must exactly match the reservation budget set');
    case 'growth_not_supported':
      return new UsageStateError('Reservation does not support requested growth/capability');
    case 'vector_dimension_mismatch':
      return new UsageStateError('Vector dimensions and budgets must exactly match the reservation');
    case 'usage_mode_mismatch':
      return new UsageStateError('Usage reservation mode does not match the requested operation');
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

function canonicalizeUsageDimensions(dimensions: readonly UsageDimension[]): UsageDimension[] {
  if (dimensions.length === 0) throw new RangeError('dimensions must contain at least one dimension');
  const normalized = dimensions.map(dimension => {
    if (!dimension.key) throw new RangeError('dimension.key must be non-empty');
    assertNonNegativeInteger(dimension.units, `dimension.units (${dimension.key})`);
    return { key: dimension.key, units: dimension.units, budgets: canonicalizeBudgets(dimension.budgets) };
  });
  normalized.sort((a, b) => a.key.localeCompare(b.key));
  validateVectorTopology(normalized);
  return normalized;
}

function canonicalizeGrowthDimensions(
  dimensions: readonly UsageDimensionGrowth[],
): UsageDimensionGrowth[] {
  if (dimensions.length === 0) throw new RangeError('dimensions must contain at least one dimension');
  const normalized = dimensions.map(dimension => {
    if (!dimension.key) throw new RangeError('dimension.key must be non-empty');
    assertNonNegativeInteger(dimension.additionalUnits, `dimension.additionalUnits (${dimension.key})`);
    return {
      key: dimension.key,
      additionalUnits: dimension.additionalUnits,
      budgets: canonicalizeBudgets(dimension.budgets),
    };
  });
  normalized.sort((a, b) => a.key.localeCompare(b.key));
  validateVectorTopology(normalized);
  if (!normalized.some(dimension => dimension.additionalUnits > 0)) {
    throw new RangeError('vector growth must add units to at least one dimension');
  }
  return normalized;
}

function canonicalizeActualDimensions(
  actuals: readonly UsageDimensionActual[],
): UsageDimensionActual[] {
  if (actuals.length === 0) throw new RangeError('actualByDimension must contain at least one dimension');
  const normalized = actuals.map(actual => {
    if (!actual.key) throw new RangeError('actual dimension key must be non-empty');
    assertNonNegativeInteger(actual.actualUnits, `actualUnits (${actual.key})`);
    return { key: actual.key, actualUnits: actual.actualUnits };
  });
  normalized.sort((a, b) => a.key.localeCompare(b.key));
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1]!.key === normalized[index]!.key) {
      throw new RangeError(`duplicate dimension key: ${normalized[index]!.key}`);
    }
  }
  return normalized;
}

function validateVectorTopology(
  dimensions: readonly { key: string; budgets: readonly Budget[] }[],
): void {
  const dimensionKeys = new Set<string>();
  const budgetKeys = new Set<string>();
  for (const dimension of dimensions) {
    if (dimensionKeys.has(dimension.key)) throw new RangeError(`duplicate dimension key: ${dimension.key}`);
    dimensionKeys.add(dimension.key);
    for (const budget of dimension.budgets) {
      if (budgetKeys.has(budget.key)) {
        throw new RangeError(`budget key cannot appear in multiple vector dimensions: ${budget.key}`);
      }
      budgetKeys.add(budget.key);
    }
  }
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

function newGrowthCursor(): string {
  return `g1.${crypto.randomUUID()}`;
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
        typeof input.initialGrowthCursor === 'string' &&
        input.initialGrowthCursor.length > 0 &&
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
    case 'reserve_vector':
      return (
        isReservationId(input.reservationId) &&
        isPositiveInteger(input.ttlMs) &&
        typeof input.initialGrowthCursor === 'string' &&
        input.initialGrowthCursor.length > 0 &&
        isHashedDimensions(input.dimensions, 'reserve')
      );
    case 'grow':
      return (
        isReservationId(input.reservationId) &&
        typeof input.incrementHash === 'string' &&
        HASH_PATTERN.test(input.incrementHash) &&
        typeof input.expectedGrowthCursor === 'string' &&
        input.expectedGrowthCursor.length > 0 &&
        isPositiveInteger(input.additionalUnits) &&
        Array.isArray(input.budgets) &&
        input.budgets.length > 0 &&
        input.budgets.every(
          budget =>
            isRecord(budget) &&
            typeof budget.id === 'string' &&
            HASH_PATTERN.test(budget.id) &&
            isNonNegativeInteger(budget.limit),
        ) &&
        typeof input.fingerprint === 'string' &&
        HASH_PATTERN.test(input.fingerprint) &&
        typeof input.nextGrowthCursor === 'string' &&
        input.nextGrowthCursor.length > 0
      );
    case 'grow_vector':
      return (
        isReservationId(input.reservationId) &&
        typeof input.incrementHash === 'string' &&
        HASH_PATTERN.test(input.incrementHash) &&
        typeof input.expectedGrowthCursor === 'string' &&
        input.expectedGrowthCursor.length > 0 &&
        isHashedDimensions(input.dimensions, 'growth') &&
        typeof input.fingerprint === 'string' &&
        HASH_PATTERN.test(input.fingerprint) &&
        typeof input.nextGrowthCursor === 'string' &&
        input.nextGrowthCursor.length > 0
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
    case 'settle_vector':
      return (
        isReservationId(input.reservationId) &&
        Array.isArray(input.actualByDimension) &&
        input.actualByDimension.length > 0 &&
        input.actualByDimension.every(
          dimension =>
            isRecord(dimension) &&
            typeof dimension.id === 'string' &&
            HASH_PATTERN.test(dimension.id) &&
            isNonNegativeInteger(dimension.actualUnits),
        ) &&
        typeof input.outcomeHash === 'string' &&
        HASH_PATTERN.test(input.outcomeHash)
      );
    default:
      return false;
  }
}

function isHashedDimensions(value: unknown, mode: 'reserve' | 'growth'): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every(dimension => {
    if (!isRecord(dimension) || typeof dimension.id !== 'string' || !HASH_PATTERN.test(dimension.id)) {
      return false;
    }
    const units = mode === 'reserve' ? dimension.units : dimension.additionalUnits;
    if (!isNonNegativeInteger(units)) return false;
    return (
      Array.isArray(dimension.budgets) &&
      dimension.budgets.length > 0 &&
      dimension.budgets.every(
        budget =>
          isRecord(budget) &&
          typeof budget.id === 'string' &&
          HASH_PATTERN.test(budget.id) &&
          isNonNegativeInteger(budget.limit),
      )
    );
  });
}

function isEnvelopeForRequest(
  value: unknown,
  request: CloudflareHttpRequest,
): value is CloudflareStoreEnvelope<unknown> {
  if (!isRecord(value) || typeof value.ok !== 'boolean' || !isRecoveryReport(value.recovery)) {
    return false;
  }
  if (!value.ok) return isStoreErrorCode(value.error);
  return isSuccessfulReplyForRequest(value.result, request);
}

function isStoreErrorCode(value: unknown): value is CloudflareStoreErrorCode {
  return (
    typeof value === 'string' &&
    [
      'not_found_or_expired',
      'settlement_conflict',
      'actual_units_exceed_reserved',
      'growth_conflict',
      'growth_stale_cursor',
      'growth_budget_mismatch',
      'growth_not_supported',
      'vector_dimension_mismatch',
      'usage_mode_mismatch',
    ].includes(value)
  );
}

function isSuccessfulReplyForRequest(value: unknown, request: CloudflareHttpRequest): boolean {
  switch (request.method) {
    case 'reserve':
      return isReserveReplyForRequest(value, request.input.budgets.map(budget => budget.id));
    case 'reserve_vector':
      return isVectorReserveReplyForRequest(value, request.input.dimensions);
    case 'grow':
      return isGrowReplyForRequest(value, request.input);
    case 'grow_vector':
      return isVectorGrowReplyForRequest(value, request.input.dimensions);
    case 'mark_liable':
    case 'renew':
      return isRecord(value) && isPositiveInteger(value.expiresAt);
    case 'settle':
      return isSettlementReplyForRequest(value, request.input.actualUnits);
    case 'settle_vector':
      return isVectorSettlementReplyForRequest(value, request.input.actualByDimension);
  }
}

function isReserveReplyForRequest(value: unknown, expectedBudgetIds: readonly string[]): boolean {
  if (!isRecord(value) || typeof value.accepted !== 'boolean') return false;
  if (value.accepted) {
    return (
      isPositiveInteger(value.expiresAt) &&
      isExactBudgetBalances(value.remainingByBudget, expectedBudgetIds)
    );
  }
  if (value.reason === 'duplicate_operation') {
    return (
      (value.limitingBudgetId === undefined || isExpectedHash(value.limitingBudgetId, expectedBudgetIds)) &&
      (value.remaining === undefined || isNonNegativeInteger(value.remaining))
    );
  }
  return (
    value.reason === 'quota_exceeded' &&
    isExpectedHash(value.limitingBudgetId, expectedBudgetIds) &&
    isNonNegativeInteger(value.remaining)
  );
}

function isVectorReserveReplyForRequest(
  value: unknown,
  dimensions: readonly CloudflareHashedDimension[],
): boolean {
  if (!isRecord(value) || typeof value.accepted !== 'boolean') return false;
  if (value.accepted) {
    return (
      isPositiveInteger(value.expiresAt) &&
      isExactVectorBalances(value.remainingByBudget, dimensions)
    );
  }
  if (value.reason === 'duplicate_operation') {
    return (
      (value.limitingDimensionId === undefined || isExpectedDimensionId(value.limitingDimensionId, dimensions)) &&
      (value.limitingBudgetId === undefined || isExpectedVectorBudgetId(value.limitingBudgetId, dimensions)) &&
      (value.remaining === undefined || isNonNegativeInteger(value.remaining))
    );
  }
  return (
    value.reason === 'quota_exceeded' &&
    isExpectedVectorPair(value.limitingDimensionId, value.limitingBudgetId, dimensions) &&
    isNonNegativeInteger(value.remaining)
  );
}

function isGrowReplyForRequest(
  value: unknown,
  input: Extract<CloudflareHttpRequest, { method: 'grow' }>['input'],
): boolean {
  if (
    !isRecord(value) ||
    typeof value.accepted !== 'boolean' ||
    typeof value.replayed !== 'boolean' ||
    !isNonEmptyString(value.growthCursor)
  ) {
    return false;
  }
  const expectedBudgetIds = input.budgets.map(budget => budget.id);
  if (!value.accepted) {
    return (
      value.reason === 'quota_exceeded' &&
      isExpectedHash(value.limitingBudgetId, expectedBudgetIds) &&
      isNonNegativeInteger(value.remaining)
    );
  }
  if (
    !isNonNegativeInteger(value.previousReservedUnits) ||
    !isNonNegativeInteger(value.reservedUnits) ||
    value.previousReservedUnits > Number.MAX_SAFE_INTEGER - input.additionalUnits ||
    value.reservedUnits !== value.previousReservedUnits + input.additionalUnits
  ) {
    return false;
  }
  return isExactBudgetBalances(value.remainingByBudget, expectedBudgetIds);
}

function isVectorGrowReplyForRequest(
  value: unknown,
  dimensions: readonly CloudflareVectorGrowthDimension[],
): boolean {
  if (
    !isRecord(value) ||
    typeof value.accepted !== 'boolean' ||
    typeof value.replayed !== 'boolean' ||
    !isNonEmptyString(value.growthCursor)
  ) {
    return false;
  }
  if (!value.accepted) {
    return (
      value.reason === 'quota_exceeded' &&
      isExpectedVectorGrowthPair(value.limitingDimensionId, value.limitingBudgetId, dimensions) &&
      isNonNegativeInteger(value.remaining)
    );
  }
  const expectedIds = dimensions.map(dimension => dimension.id);
  const previous = reservedDimensionMap(value.previousReservedByDimension, expectedIds);
  const current = reservedDimensionMap(value.reservedByDimension, expectedIds);
  if (!previous || !current) return false;
  for (const dimension of dimensions) {
    const before = previous.get(dimension.id);
    const after = current.get(dimension.id);
    if (
      before === undefined ||
      after === undefined ||
      before > Number.MAX_SAFE_INTEGER - dimension.additionalUnits ||
      after !== before + dimension.additionalUnits
    ) {
      return false;
    }
  }
  return isExactVectorGrowthBalances(value.remainingByBudget, dimensions);
}

function isSettlementReplyForRequest(value: unknown, expectedActualUnits: number): boolean {
  if (
    !isRecord(value) ||
    !isNonNegativeInteger(value.reservedUnits) ||
    !isNonNegativeInteger(value.actualUnits) ||
    !isNonNegativeInteger(value.releasedUnits) ||
    typeof value.replayed !== 'boolean'
  ) {
    return false;
  }
  return (
    value.actualUnits === expectedActualUnits &&
    value.reservedUnits >= value.actualUnits &&
    value.releasedUnits === value.reservedUnits - value.actualUnits
  );
}

function isVectorSettlementReplyForRequest(
  value: unknown,
  expectedActuals: readonly CloudflareVectorActualDimension[],
): boolean {
  if (!isRecord(value) || typeof value.replayed !== 'boolean' || !Array.isArray(value.dimensions)) {
    return false;
  }
  if (value.dimensions.length !== expectedActuals.length) return false;
  const expected = new Map(expectedActuals.map(item => [item.id, item.actualUnits] as const));
  const seen = new Set<string>();
  for (const raw of value.dimensions) {
    if (
      !isRecord(raw) ||
      !isExpectedHash(raw.id, expectedActuals.map(item => item.id)) ||
      seen.has(raw.id as string) ||
      !isNonNegativeInteger(raw.reservedUnits) ||
      !isNonNegativeInteger(raw.actualUnits) ||
      !isNonNegativeInteger(raw.releasedUnits)
    ) {
      return false;
    }
    const id = raw.id as string;
    seen.add(id);
    const actual = expected.get(id);
    if (
      actual === undefined ||
      raw.actualUnits !== actual ||
      raw.reservedUnits < raw.actualUnits ||
      raw.releasedUnits !== raw.reservedUnits - raw.actualUnits
    ) {
      return false;
    }
  }
  return seen.size === expected.size;
}

function isExactBudgetBalances(value: unknown, expectedIds: readonly string[]): boolean {
  if (!Array.isArray(value) || value.length !== expectedIds.length) return false;
  const expected = new Set(expectedIds);
  const seen = new Set<string>();
  for (const raw of value) {
    if (
      !isRecord(raw) ||
      typeof raw.id !== 'string' ||
      !expected.has(raw.id) ||
      seen.has(raw.id) ||
      !isNonNegativeInteger(raw.remaining)
    ) {
      return false;
    }
    seen.add(raw.id);
  }
  return seen.size === expected.size;
}

function isExactVectorBalances(
  value: unknown,
  dimensions: readonly CloudflareHashedDimension[],
): boolean {
  return isExactVectorBalancePairs(
    value,
    dimensions.flatMap(dimension =>
      dimension.budgets.map(budget => [dimension.id, budget.id] as const),
    ),
  );
}

function isExactVectorGrowthBalances(
  value: unknown,
  dimensions: readonly CloudflareVectorGrowthDimension[],
): boolean {
  return isExactVectorBalancePairs(
    value,
    dimensions.flatMap(dimension =>
      dimension.budgets.map(budget => [dimension.id, budget.id] as const),
    ),
  );
}

function isExactVectorBalancePairs(
  value: unknown,
  expectedPairs: readonly (readonly [string, string])[],
): boolean {
  if (!Array.isArray(value) || value.length !== expectedPairs.length) return false;
  const expected = new Set(expectedPairs.map(([dimensionId, budgetId]) => `${dimensionId}\u0000${budgetId}`));
  const seen = new Set<string>();
  for (const raw of value) {
    if (
      !isRecord(raw) ||
      typeof raw.dimensionId !== 'string' ||
      typeof raw.budgetId !== 'string' ||
      !isNonNegativeInteger(raw.remaining)
    ) {
      return false;
    }
    const pair = `${raw.dimensionId}\u0000${raw.budgetId}`;
    if (!expected.has(pair) || seen.has(pair)) return false;
    seen.add(pair);
  }
  return seen.size === expected.size;
}

function reservedDimensionMap(
  value: unknown,
  expectedIds: readonly string[],
): Map<string, number> | undefined {
  if (!Array.isArray(value) || value.length !== expectedIds.length) return undefined;
  const expected = new Set(expectedIds);
  const result = new Map<string, number>();
  for (const raw of value) {
    if (
      !isRecord(raw) ||
      typeof raw.id !== 'string' ||
      !expected.has(raw.id) ||
      result.has(raw.id) ||
      !isNonNegativeInteger(raw.reservedUnits)
    ) {
      return undefined;
    }
    result.set(raw.id, raw.reservedUnits);
  }
  return result.size === expected.size ? result : undefined;
}

function isExpectedHash(value: unknown, expectedIds: readonly string[]): value is string {
  return typeof value === 'string' && HASH_PATTERN.test(value) && expectedIds.includes(value);
}

function isExpectedDimensionId(value: unknown, dimensions: readonly CloudflareHashedDimension[]): boolean {
  return typeof value === 'string' && dimensions.some(dimension => dimension.id === value);
}

function isExpectedVectorBudgetId(value: unknown, dimensions: readonly CloudflareHashedDimension[]): boolean {
  return (
    typeof value === 'string' &&
    dimensions.some(dimension => dimension.budgets.some(budget => budget.id === value))
  );
}

function isExpectedVectorPair(
  dimensionId: unknown,
  budgetId: unknown,
  dimensions: readonly CloudflareHashedDimension[],
): boolean {
  if (typeof dimensionId !== 'string' || typeof budgetId !== 'string') return false;
  const dimension = dimensions.find(item => item.id === dimensionId);
  return dimension !== undefined && dimension.budgets.some(budget => budget.id === budgetId);
}

function isExpectedVectorGrowthPair(
  dimensionId: unknown,
  budgetId: unknown,
  dimensions: readonly CloudflareVectorGrowthDimension[],
): boolean {
  if (typeof dimensionId !== 'string' || typeof budgetId !== 'string') return false;
  const dimension = dimensions.find(item => item.id === dimensionId);
  return dimension !== undefined && dimension.budgets.some(budget => budget.id === budgetId);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecoveryReport(value: unknown): value is CloudflareRecoveryReport {
  if (!isRecord(value) || !isRecoverySummary(value.aggregate)) return false;
  if (value.direct === undefined) return true;
  if (
    !isRecord(value.direct) ||
    !isReservationId(value.direct.reservationId) ||
    (value.direct.state !== 'pending' && value.direct.state !== 'liable')
  ) {
    return false;
  }
  if (value.direct.vector === true) {
    return (
      isNonNegativeInteger(value.direct.dimensionCount) &&
      isNonNegativeInteger(value.direct.budgetCount)
    );
  }
  return isNonNegativeInteger(value.direct.reservedUnits);
}

function isRecoverySummary(value: unknown): value is CloudflareRecoverySummary {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.pendingCount) &&
    isNonNegativeInteger(value.pendingUnits) &&
    isNonNegativeInteger(value.liableCount) &&
    isNonNegativeInteger(value.liableUnits) &&
    (value.vectorPendingCount === undefined || isNonNegativeInteger(value.vectorPendingCount)) &&
    (value.vectorLiableCount === undefined || isNonNegativeInteger(value.vectorLiableCount))
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
