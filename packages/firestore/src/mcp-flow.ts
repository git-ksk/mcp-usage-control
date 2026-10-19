import { createHash } from 'node:crypto';
import { UsageStateError, type UsageEventMetadata, type UsageLeaseResumeState } from 'mcp-usage-control';
import type { FirestoreLike, FirestoreDocumentReferenceLike } from './index.js';

/** Structurally compatible with the MCP adapter's trusted flow binding. */
export interface FirestoreMcpUsageFlowBinding {
  principalId: string;
  tenantId?: string;
  tool: string;
  argsHash: string;
}

/** Structurally compatible with the MCP adapter's serializable flow record. */
export interface FirestoreMcpUsageFlowRecord {
  flowId: string;
  binding: FirestoreMcpUsageFlowBinding;
  lease: UsageLeaseResumeState;
  round: number;
  expiresAt: number;
  applicationRequestState?: string;
}

export interface FirestoreMcpUsageFlowStoreOptions {
  /** A private server-only collection, distinct from accounting collections. */
  collectionPath?: string;
  /** Reject claims this many milliseconds BEFORE expiry to allow for transaction completion. Default 1s. */
  expirySafetyMarginMs?: number;
  /** Minimum TTL cleanup retention beyond expiration. Configure Firestore TTL on deleteAt. Default 24h. */
  retentionMs?: number;
}

const FLOW_ID_PATTERN = /^[A-Za-z0-9._~-]{16,128}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const MAX_RECORD_BYTES = 65_536;

interface FlowSnapshot {
  readonly exists: boolean;
  readonly readTime?: { toMillis(): number };
  data(): Record<string, unknown> | undefined;
}
interface FlowTransaction {
  get(reference: FirestoreDocumentReferenceLike): Promise<FlowSnapshot>;
  create(reference: FirestoreDocumentReferenceLike, data: Record<string, unknown>): FlowTransaction;
  delete(reference: FirestoreDocumentReferenceLike): FlowTransaction;
}

/**
 * Firestore transaction-backed, single-claim MCP flow store.
 *
 * Uses transaction snapshot `readTime` from the Firestore backend for expiry
 * checks, rather than trusting unsynchronized application clocks. Fails closed
 * when readTime is absent/invalid. The configurable margin is a conservative
 * guard for transaction completion latency, not a global HA guarantee.
 * Never retries a committed transaction after an ambiguous acknowledgement;
 * consumers must also fail closed on any thrown error.
 */
export class FirestoreMcpUsageFlowStore {
  private readonly collectionPath: string;
  private readonly expirySafetyMarginMs: number;
  private readonly retentionMs: number;

  constructor(private readonly firestore: FirestoreLike, options: FirestoreMcpUsageFlowStoreOptions = {}) {
    this.collectionPath = options.collectionPath ?? 'muc_mcp_flows';
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,100}$/.test(this.collectionPath)) {
      throw new RangeError('MCP flow collectionPath must be a single 1-101 character collection segment');
    }
    this.retentionMs = options.retentionMs ?? 86_400_000;
    if (!Number.isSafeInteger(this.retentionMs) || this.retentionMs < 0 || this.retentionMs > 604_800_000) {
      throw new RangeError('retentionMs must be an integer between 0 and seven days');
    }
    this.expirySafetyMarginMs = options.expirySafetyMarginMs ?? 1_000;
    if (!Number.isSafeInteger(this.expirySafetyMarginMs) || this.expirySafetyMarginMs < 0 || this.expirySafetyMarginMs > 60_000) {
      throw new RangeError('expirySafetyMarginMs must be a safe integer between 0 and 60000');
    }
  }

  async suspend(record: FirestoreMcpUsageFlowRecord): Promise<void> {
    validateFlowRecord(record);
    const payload = JSON.stringify(cloneFlowRecord(record));
    if (Buffer.byteLength(payload, 'utf8') > MAX_RECORD_BYTES) {
      throw new RangeError(`Firestore MCP flow payload exceeds ${MAX_RECORD_BYTES} bytes`);
    }
    const ref = this.doc(record.flowId);
    const digest = bindingDigest(record.binding);
    // `create` is a Firestore precondition: no two concurrent suspends can
    // overwrite the first flow, even across independent server replicas.
    await this.firestore.runTransaction(async (tx: FlowTransaction) => {
      const snapshot = await tx.get(ref);
      const now = trustedReadTime(snapshot);
      if (record.expiresAt <= now + this.expirySafetyMarginMs) {
        throw new UsageStateError('MCP flow expiry is too close to Firestore read time');
      }
      if (snapshot.exists) throw new UsageStateError('MCP usage flow ID already exists');
      const deleteAfter = record.expiresAt + this.retentionMs;
      if (!Number.isSafeInteger(deleteAfter)) throw new UsageStateError('MCP flow cleanup deadline is invalid');
      tx.create(ref, { payload, bindingDigest: digest, expiresAt: record.expiresAt, deleteAt: new Date(deleteAfter) });
    });
  }

  async consume(flowId: string, binding: FirestoreMcpUsageFlowBinding): Promise<FirestoreMcpUsageFlowRecord | undefined> {
    validateFlowId(flowId);
    validateBinding(binding);
    const ref = this.doc(flowId);
    const digest = bindingDigest(binding);
    return this.firestore.runTransaction(async (tx: FlowTransaction) => {
      const snapshot = await tx.get(ref);
      const now = trustedReadTime(snapshot);
      if (!snapshot.exists) return undefined;
      const data = snapshot.data();
      if (!data || typeof data.payload !== 'string' || typeof data.bindingDigest !== 'string' ||
          !Number.isSafeInteger(data.expiresAt) || (data.expiresAt as number) <= 0 ||
          Buffer.byteLength(data.payload, 'utf8') > MAX_RECORD_BYTES) {
        throw new UsageStateError('Firestore MCP flow record is corrupt');
      }
      if (data.bindingDigest !== digest) return undefined;
      // The expiration test happens before the destructive one-winner claim.
      if ((data.expiresAt as number) <= now + this.expirySafetyMarginMs) return undefined;
      let record: FirestoreMcpUsageFlowRecord;
      try {
        record = JSON.parse(data.payload) as FirestoreMcpUsageFlowRecord;
        validateFlowRecord(record);
      } catch {
        throw new UsageStateError('Firestore MCP flow payload is invalid');
      }
      if (record.flowId !== flowId || record.expiresAt !== data.expiresAt ||
          !sameBinding(record.binding, binding)) {
        throw new UsageStateError('Firestore MCP flow payload failed binding integrity check');
      }
      tx.delete(ref);
      return cloneFlowRecord(record);
    });
  }

  private doc(flowId: string): FirestoreDocumentReferenceLike {
    validateFlowId(flowId);
    const collection = this.firestore.collection(this.collectionPath) as {
      doc(documentId: string): FirestoreDocumentReferenceLike;
    };
    return collection.doc(flowId);
  }
}

function trustedReadTime(snapshot: FlowSnapshot): number {
  let now: number;
  try {
    now = snapshot.readTime?.toMillis() ?? NaN;
  } catch {
    throw new UsageStateError('Firestore MCP flow trusted readTime is unavailable');
  }
  if (!Number.isSafeInteger(now) || now <= 0) {
    throw new UsageStateError('Firestore MCP flow trusted readTime is unavailable');
  }
  return now;
}

function bindingDigest(binding: FirestoreMcpUsageFlowBinding): string {
  return createHash('sha256')
    .update(JSON.stringify([binding.principalId, binding.tenantId ?? null, binding.tool, binding.argsHash]))
    .digest('hex');
}

function validateFlowRecord(record: FirestoreMcpUsageFlowRecord): void {
  if (!isRecord(record)) throw new UsageStateError('MCP usage flow record must be an object');
  validateFlowId(record.flowId);
  validateBinding(record.binding);
  if (!Number.isSafeInteger(record.round) || record.round <= 0) {
    throw new UsageStateError('MCP usage flow round must be a positive safe integer');
  }
  if (!Number.isSafeInteger(record.expiresAt) || record.expiresAt <= 0) {
    throw new UsageStateError('MCP usage flow expiry must be a positive safe integer');
  }
  validateLeaseResumeState(record.lease);
  if (record.lease.reservation.expiresAt !== record.expiresAt) {
    throw new UsageStateError('MCP usage flow and lease expiry must match');
  }
  if (
    record.lease.reservation.principalId !== record.binding.principalId ||
    record.lease.reservation.tenantId !== record.binding.tenantId ||
    record.lease.reservation.tool !== record.binding.tool
  ) {
    throw new UsageStateError('MCP usage flow binding must match the resumable lease identity');
  }
  if (
    record.applicationRequestState !== undefined &&
    (typeof record.applicationRequestState !== 'string' ||
      record.applicationRequestState.length === 0 ||
      record.applicationRequestState.length > 16_384)
  ) {
    throw new UsageStateError('Application requestState must be a non-empty bounded string');
  }
}

function validateBinding(binding: FirestoreMcpUsageFlowBinding): void {
  if (!isRecord(binding)) throw new UsageStateError('MCP usage flow binding must be an object');
  if (typeof binding.principalId !== 'string' || binding.principalId.length === 0) {
    throw new UsageStateError('MCP usage flow principalId must be non-empty');
  }
  if (binding.tenantId !== undefined && typeof binding.tenantId !== 'string') {
    throw new UsageStateError('MCP usage flow tenantId must be a string when present');
  }
  if (typeof binding.tool !== 'string' || binding.tool.length === 0) {
    throw new UsageStateError('MCP usage flow tool must be non-empty');
  }
  if (typeof binding.argsHash !== 'string' || !HASH_PATTERN.test(binding.argsHash)) {
    throw new UsageStateError('MCP usage flow argsHash must be SHA-256 hex');
  }
}

function validateLeaseResumeState(state: UsageLeaseResumeState): void {
  if (!isRecord(state)) throw new UsageStateError('MCP usage lease resume state must be an object');
  if (!Number.isSafeInteger(state.ttlMs) || state.ttlMs <= 0) {
    throw new UsageStateError('MCP usage lease ttlMs must be a positive safe integer');
  }
  const reservation = state.reservation;
  if (!isRecord(reservation)) throw new UsageStateError('MCP usage resume reservation must be an object');
  for (const [name, value] of [
    ['id', reservation.id],
    ['operationId', reservation.operationId],
    ['principalId', reservation.principalId],
    ['tool', reservation.tool],
  ] as const) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new UsageStateError(`MCP usage resume reservation ${name} must be non-empty`);
    }
  }
  if (reservation.tenantId !== undefined && typeof reservation.tenantId !== 'string') {
    throw new UsageStateError('MCP usage resume reservation tenantId must be a string when present');
  }
  if (reservation.plan !== undefined && typeof reservation.plan !== 'string') {
    throw new UsageStateError('MCP usage resume reservation plan must be a string when present');
  }
  if (
    !Array.isArray(reservation.budgetKeys) ||
    reservation.budgetKeys.length === 0 ||
    reservation.budgetKeys.some(key => typeof key !== 'string' || key.length === 0)
  ) {
    throw new UsageStateError('MCP usage resume reservation must contain non-empty budget keys');
  }
  if (!Number.isSafeInteger(reservation.reservedUnits) || reservation.reservedUnits < 0) {
    throw new UsageStateError('MCP usage resume reservation reservedUnits must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(reservation.expiresAt) || reservation.expiresAt <= 0) {
    throw new UsageStateError('MCP usage resume reservation expiresAt must be a positive safe integer');
  }
  if (state.metadata !== undefined) validateMetadata(state.metadata);
  if (state.unresolvedGrowth !== undefined) validateUnresolvedGrowth(state.unresolvedGrowth);
}

function validateUnresolvedGrowth(value: unknown): void {
  if (!isRecord(value)) {
    throw new UsageStateError('MCP usage unresolved growth must be an object');
  }
  if (typeof value.incrementId !== 'string' || value.incrementId.length === 0) {
    throw new UsageStateError('MCP usage unresolved growth incrementId must be non-empty');
  }
  if (!Number.isSafeInteger(value.additionalUnits) || (value.additionalUnits as number) <= 0) {
    throw new UsageStateError('MCP usage unresolved growth additionalUnits must be a positive safe integer');
  }
  if (!Array.isArray(value.budgets) || value.budgets.length === 0) {
    throw new UsageStateError('MCP usage unresolved growth must contain budgets');
  }
  let previousKey: string | undefined;
  for (const budget of value.budgets) {
    if (!isRecord(budget) || typeof budget.key !== 'string' || budget.key.length === 0) {
      throw new UsageStateError('MCP usage unresolved growth budget key must be non-empty');
    }
    if (!Number.isSafeInteger(budget.limit) || (budget.limit as number) < 0) {
      throw new UsageStateError('MCP usage unresolved growth budget limit must be a non-negative safe integer');
    }
    if (previousKey !== undefined && previousKey.localeCompare(budget.key) >= 0) {
      throw new UsageStateError('MCP usage unresolved growth budgets must be canonical and unique');
    }
    previousKey = budget.key;
  }
}

function validateMetadata(metadata: UsageEventMetadata): void {
  if (!isRecord(metadata)) throw new UsageStateError('MCP usage resume metadata must be an object');
  for (const value of Object.values(metadata)) {
    if (
      value !== null &&
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean'
    ) {
      throw new UsageStateError('MCP usage resume metadata contains an unsupported value');
    }
  }
}

function validateFlowId(flowId: string): void {
  if (typeof flowId !== 'string' || !FLOW_ID_PATTERN.test(flowId)) {
    throw new UsageStateError('MCP usage flow ID must be 16-128 URL-safe characters');
  }
}

function sameBinding(left: FirestoreMcpUsageFlowBinding, right: FirestoreMcpUsageFlowBinding): boolean {
  return (
    left.principalId === right.principalId &&
    left.tenantId === right.tenantId &&
    left.tool === right.tool &&
    left.argsHash === right.argsHash
  );
}

function cloneFlowRecord(record: FirestoreMcpUsageFlowRecord): FirestoreMcpUsageFlowRecord {
  return {
    flowId: record.flowId,
    binding: { ...record.binding },
    lease: {
      reservation: {
        ...record.lease.reservation,
        budgetKeys: [...record.lease.reservation.budgetKeys],
      },
      ttlMs: record.lease.ttlMs,
      ...(record.lease.metadata === undefined ? {} : { metadata: { ...record.lease.metadata } }),
      ...(record.lease.unresolvedGrowth === undefined
        ? {}
        : {
            unresolvedGrowth: {
              incrementId: record.lease.unresolvedGrowth.incrementId,
              additionalUnits: record.lease.unresolvedGrowth.additionalUnits,
              budgets: record.lease.unresolvedGrowth.budgets.map(budget => ({ ...budget })),
            },
          }),
    },
    round: record.round,
    expiresAt: record.expiresAt,
    ...(record.applicationRequestState === undefined
      ? {}
      : { applicationRequestState: record.applicationRequestState }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
