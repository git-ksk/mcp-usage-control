import { describe, expect, it } from 'vitest';
import type { UsageRequest } from 'mcp-usage-control';
import {
  runProgressiveUsageStoreConformance,
  runVectorUsageStoreConformance,
} from 'mcp-usage-control/conformance';
import type { Firestore } from '@google-cloud/firestore';
import {
  FirestoreUsageStore,
  type FirestoreRecoveryEvent,
  type FirestoreCollectionReferenceLike,
  type FirestoreDocumentReferenceLike,
  type FirestoreDocumentSnapshotLike,
  type FirestoreLike,
  type FirestoreQueryDocumentSnapshotLike,
  type FirestoreQueryLike,
  type FirestoreQuerySnapshotLike,
  type FirestoreTransactionLike,
} from './index.js';

class FakeDocumentReference implements FirestoreDocumentReferenceLike {
  constructor(
    readonly collectionPath: string,
    readonly id: string,
  ) {}
}

class FakeSnapshot implements FirestoreDocumentSnapshotLike {
  constructor(private readonly value: Record<string, unknown> | undefined) {}
  get exists(): boolean {
    return this.value !== undefined;
  }
  data(): Record<string, unknown> | undefined {
    return this.value === undefined ? undefined : structuredClone(this.value);
  }
}

class FakeQuerySnapshot extends FakeSnapshot implements FirestoreQueryDocumentSnapshotLike {
  constructor(
    readonly ref: FakeDocumentReference,
    value: Record<string, unknown>,
  ) {
    super(value);
  }
}

class FakeQuery implements FirestoreQueryLike {
  private predicate: ((value: Record<string, unknown>) => boolean) | undefined;
  private max = Number.POSITIVE_INFINITY;

  constructor(
    protected readonly database: FakeFirestore,
    protected readonly collectionPath: string,
  ) {}

  where(fieldPath: string, opStr: string, value: unknown): FirestoreQueryLike {
    if (opStr !== '<=' || typeof value !== 'number') throw new Error('unsupported fake query');
    const next = new FakeQuery(this.database, this.collectionPath);
    next.predicate = row => {
      const fieldValue = row[fieldPath];
      return typeof fieldValue === 'number' && fieldValue <= value;
    };
    next.max = this.max;
    return next;
  }

  limit(limit: number): FirestoreQueryLike {
    const next = new FakeQuery(this.database, this.collectionPath);
    next.predicate = this.predicate;
    next.max = limit;
    return next;
  }

  async get(): Promise<FirestoreQuerySnapshotLike> {
    const rows = this.database.rows(this.collectionPath);
    const docs = [...rows.entries()]
      .filter(([, value]) => this.predicate?.(value) ?? true)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, this.max)
      .map(([id, value]) => new FakeQuerySnapshot(new FakeDocumentReference(this.collectionPath, id), value));
    return { docs };
  }
}

class FakeCollection extends FakeQuery implements FirestoreCollectionReferenceLike {
  doc(documentPath: string): FirestoreDocumentReferenceLike {
    return new FakeDocumentReference(this.collectionPath, documentPath);
  }
}

class FakeTransaction implements FirestoreTransactionLike {
  private readonly writes = new Map<string, Record<string, unknown> | null>();

  constructor(private readonly database: FakeFirestore) {}

  async get(reference: FirestoreDocumentReferenceLike): Promise<FirestoreDocumentSnapshotLike> {
    const ref = reference as FakeDocumentReference;
    return new FakeSnapshot(this.database.read(ref));
  }

  async getAll(
    ...references: readonly FirestoreDocumentReferenceLike[]
  ): Promise<FirestoreDocumentSnapshotLike[]> {
    return references.map(reference => {
      const ref = reference as FakeDocumentReference;
      return new FakeSnapshot(this.database.read(ref));
    });
  }

  set(
    reference: FirestoreDocumentReferenceLike,
    data: Record<string, unknown>,
  ): FirestoreTransactionLike {
    const ref = reference as FakeDocumentReference;
    this.writes.set(this.database.key(ref), structuredClone(data));
    return this;
  }

  delete(reference: FirestoreDocumentReferenceLike): FirestoreTransactionLike {
    const ref = reference as FakeDocumentReference;
    this.writes.set(this.database.key(ref), null);
    return this;
  }

  commit(): void {
    for (const [key, value] of this.writes) this.database.writeKey(key, value);
  }
}

class FakeFirestore implements FirestoreLike {
  private readonly data = new Map<string, Record<string, unknown>>();
  private tail: Promise<void> = Promise.resolve();

  collection(collectionPath: string): FirestoreCollectionReferenceLike {
    return new FakeCollection(this, collectionPath);
  }

  async runTransaction<T>(
    updateFunction: (transaction: FirestoreTransactionLike) => Promise<T>,
  ): Promise<T> {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>(resolve => {
      release = resolve;
    });
    await previous;
    try {
      const transaction = new FakeTransaction(this);
      const result = await updateFunction(transaction);
      transaction.commit();
      return result;
    } finally {
      release();
    }
  }

  key(reference: FakeDocumentReference): string {
    return `${reference.collectionPath}/${reference.id}`;
  }

  read(reference: FakeDocumentReference): Record<string, unknown> | undefined {
    const value = this.data.get(this.key(reference));
    return value === undefined ? undefined : structuredClone(value);
  }

  writeKey(key: string, value: Record<string, unknown> | null): void {
    if (value === null) this.data.delete(key);
    else this.data.set(key, structuredClone(value));
  }

  rows(collectionPath: string): Map<string, Record<string, unknown>> {
    const prefix = `${collectionPath}/`;
    const result = new Map<string, Record<string, unknown>>();
    for (const [key, value] of this.data) {
      if (!key.startsWith(prefix)) continue;
      result.set(key.slice(prefix.length), structuredClone(value));
    }
    return result;
  }
}

function request(operationId: string, principalId = 'user-a'): UsageRequest {
  return {
    operationId,
    principal: { id: principalId, tenantId: 'tenant-a', plan: 'free' },
    tool: 'search',
    args: {},
  };
}

// Compile-time contract: the official server Firestore client must be accepted
// directly by the adapter constructor without a consumer-side cast.
function assertServerClientTypeCompatibility(firestore: Firestore): void {
  new FirestoreUsageStore(firestore);
}
void assertServerClientTypeCompatibility;

describe('FirestoreUsageStore', () => {
  it('atomically enforces user and shared tenant budgets', async () => {
    const database = new FakeFirestore();
    const store = new FirestoreUsageStore(database, { cleanupBatchSize: 0, expiryGraceMs: 0 });

    const first = await store.reserve({
      request: request('op-a', 'user-a'),
      units: 1,
      budgets: [
        { key: 'day:user-a', limit: 1 },
        { key: 'month:tenant-a', limit: 1 },
      ],
      ttlMs: 60_000,
    });
    expect(first.accepted).toBe(true);

    const denied = await store.reserve({
      request: request('op-b', 'user-b'),
      units: 1,
      budgets: [
        { key: 'day:user-b', limit: 1 },
        { key: 'month:tenant-a', limit: 1 },
      ],
      ttlMs: 60_000,
    });
    expect(denied).toMatchObject({
      accepted: false,
      reason: 'quota_exceeded',
      limitingBudgetKey: 'month:tenant-a',
      remaining: 0,
    });

    if (!first.accepted) throw new Error('expected first reservation');
    await store.settle({ reservationId: first.reservation.id, actualUnits: 0, outcome: 'no_cost' });

    const retry = await store.reserve({
      request: request('op-b-retry', 'user-b'),
      units: 1,
      budgets: [
        { key: 'day:user-b', limit: 1 },
        { key: 'month:tenant-a', limit: 1 },
      ],
      ttlMs: 60_000,
    });
    expect(retry.accepted).toBe(true);
  });

  it('reconciles scalar operation state read-only and validates the original quote shape', async () => {
    const database = new FakeFirestore();
    let now = 1_000;
    const store = new FirestoreUsageStore(database, {
      cleanupBatchSize: 0,
      expiryGraceMs: 0,
      now: () => now,
    });
    const req = request('reconcile-op');
    const input = {
      request: req,
      units: 1,
      budgets: [{ key: 'day:user-a', limit: 3 }],
    };

    expect(await store.reconcileOperation(input)).toMatchObject({ status: 'absent' });
    const reserved = await store.reserve({ ...input, ttlMs: 100 });
    expect(reserved.accepted).toBe(true);
    if (!reserved.accepted) return;

    expect(await store.reconcileOperation(input)).toMatchObject({
      status: 'active',
      state: 'pending',
    });
    await store.markLiable({ reservationId: reserved.reservation.id });
    expect(await store.reconcileOperation(input)).toMatchObject({
      status: 'active',
      state: 'liable',
    });

    await store.settle({ reservationId: reserved.reservation.id, actualUnits: 1, outcome: 'completed' });
    expect(await store.reconcileOperation(input)).toMatchObject({
      status: 'settled',
      reservedUnits: 1,
      actualUnits: 1,
    });

    await expect(
      store.reconcileOperation({
        ...input,
        units: 2,
        budgets: [{ key: 'day:user-a', limit: 3 }],
      }),
    ).rejects.toThrow(/does not match retained reservation state/);

    now += 86_400_001;
    expect(await store.reconcileOperation(input)).toMatchObject({ status: 'absent' });
  });

  it('reports expired active state without performing recovery writes', async () => {
    const database = new FakeFirestore();
    let now = 10_000;
    const store = new FirestoreUsageStore(database, {
      cleanupBatchSize: 0,
      expiryGraceMs: 0,
      now: () => now,
    });
    const req = request('reconcile-expired');
    const input = {
      request: req,
      units: 1,
      budgets: [{ key: 'reconcile:expiry', limit: 1 }],
    };
    const reserved = await store.reserve({ ...input, ttlMs: 50 });
    expect(reserved.accepted).toBe(true);
    now += 51;

    expect(await store.reconcileOperation(input)).toMatchObject({
      status: 'expired',
      state: 'pending',
    });
    expect(database.rows('muc_reservations')).toHaveLength(1);
  });

  it('serializes parallel reservations against a shared tenant budget', async () => {
    const database = new FakeFirestore();
    const store = new FirestoreUsageStore(database, { cleanupBatchSize: 0, expiryGraceMs: 0 });

    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        store.reserve({
          request: request(`parallel-${index}`, `user-${index}`),
          units: 1,
          budgets: [{ key: 'month:tenant-a', limit: 1 }],
          ttlMs: 60_000,
        }),
      ),
    );

    expect(results.filter(result => result.accepted)).toHaveLength(1);
    expect(results.filter(result => !result.accepted)).toHaveLength(11);
  });

  it('releases expired pending reservations and allows operation ID reuse', async () => {
    const database = new FakeFirestore();
    let now = 1_000;
    const events: FirestoreRecoveryEvent[] = [];
    const store = new FirestoreUsageStore(database, {
      cleanupBatchSize: 0,
      expiryGraceMs: 0,
      now: () => now,
      observer: {
        onEvent(event) {
          events.push(event);
        },
      },
    });

    const first = await store.reserve({
      request: request('reusable'),
      units: 1,
      budgets: [{ key: 'day:user-a', limit: 1 }],
      ttlMs: 100,
    });
    expect(first.accepted).toBe(true);

    now = 1_101;
    const recovered = await store.recoverExpired(10);
    expect(recovered).toMatchObject({ pendingCount: 1, pendingUnits: 1 });

    const second = await store.reserve({
      request: request('reusable'),
      units: 1,
      budgets: [{ key: 'day:user-a', limit: 1 }],
      ttlMs: 100,
    });
    expect(second.accepted).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'reservation.recovered',
        store: 'firestore',
        recovery: 'pending_released',
      }),
    );
  });

  it('preserves expired-liable reconciliation after recovery without using tombstone expiry', async () => {
    const database = new FakeFirestore();
    let now = 10_000;
    const store = new FirestoreUsageStore(database, {
      cleanupBatchSize: 0,
      expiryGraceMs: 0,
      now: () => now,
    });
    const req = request('liable');
    const input = {
      request: req,
      units: 1,
      budgets: [{ key: 'day:user-a', limit: 1 }],
    };

    const first = await store.reserve({ ...input, ttlMs: 100 });
    if (!first.accepted) throw new Error('expected reservation');
    const originalLeaseExpiry = first.reservation.expiresAt;
    await store.markLiable({ reservationId: first.reservation.id });

    now = 10_101;
    await expect(store.reconcileOperation(input)).resolves.toEqual({
      status: 'expired',
      state: 'liable',
      reservationId: first.reservation.id,
      expiredAt: originalLeaseExpiry,
    });

    const recovered = await store.recoverExpired(10);
    expect(recovered).toMatchObject({ liableCount: 1, liableUnits: 1 });
    const recoveredDocument = database.read(
      new FakeDocumentReference('muc_reservations', first.reservation.id),
    );
    expect(recoveredDocument).toMatchObject({
      state: 'settled',
      leaseExpiresAtMs: originalLeaseExpiry,
    });
    expect(recoveredDocument?.expiresAtMs).not.toBe(originalLeaseExpiry);

    await expect(store.reconcileOperation(input)).resolves.toEqual({
      status: 'expired',
      state: 'liable',
      reservationId: first.reservation.id,
      expiredAt: originalLeaseExpiry,
    });
    // Reconciliation remains read-only after recovery.
    await expect(store.reconcileOperation(input)).resolves.toEqual({
      status: 'expired',
      state: 'liable',
      reservationId: first.reservation.id,
      expiredAt: originalLeaseExpiry,
    });

    const duplicate = await store.reserve({ ...input, ttlMs: 100 });
    expect(duplicate).toEqual({ accepted: false, reason: 'duplicate_operation' });

    const another = await store.reserve({
      request: request('another'),
      units: 1,
      budgets: [{ key: 'day:user-a', limit: 1 }],
      ttlMs: 100,
    });
    expect(another).toMatchObject({ accepted: false, reason: 'quota_exceeded' });
  });

  it('fails closed for a legacy recovered-liable tombstone missing original lease expiry', async () => {
    const database = new FakeFirestore();
    let now = 20_000;
    const store = new FirestoreUsageStore(database, {
      cleanupBatchSize: 0,
      expiryGraceMs: 0,
      now: () => now,
    });
    const input = {
      request: request('legacy-liable'),
      units: 1,
      budgets: [{ key: 'legacy-liable-budget', limit: 1 }],
    };
    const first = await store.reserve({ ...input, ttlMs: 100 });
    if (!first.accepted) throw new Error('expected reservation');
    await store.markLiable({ reservationId: first.reservation.id });
    now = 20_101;
    await store.recoverExpired(10);

    const key = `muc_reservations/${first.reservation.id}`;
    const recovered = database.read(
      new FakeDocumentReference('muc_reservations', first.reservation.id),
    );
    if (!recovered) throw new Error('expected recovered tombstone');
    delete recovered.leaseExpiresAtMs;
    database.writeKey(key, recovered);

    await expect(store.reconcileOperation(input)).rejects.toThrow(
      /missing its original lease expiry/,
    );
  });

  it('keeps settlement replay idempotent and rejects conflicting replay', async () => {
    const database = new FakeFirestore();
    const store = new FirestoreUsageStore(database, { cleanupBatchSize: 0, expiryGraceMs: 0 });
    const reserved = await store.reserve({
      request: request('settle'),
      units: 3,
      budgets: [{ key: 'month:user-a', limit: 10 }],
      ttlMs: 60_000,
    });
    if (!reserved.accepted) throw new Error('expected reservation');

    await expect(
      store.settle({ reservationId: reserved.reservation.id, actualUnits: 2, outcome: 'success' }),
    ).resolves.toMatchObject({ reservedUnits: 3, actualUnits: 2, releasedUnits: 1 });
    await expect(
      store.settle({ reservationId: reserved.reservation.id, actualUnits: 2, outcome: 'success' }),
    ).resolves.toMatchObject({ reservedUnits: 3, actualUnits: 2, releasedUnits: 1 });
    await expect(
      store.settle({ reservationId: reserved.reservation.id, actualUnits: 1, outcome: 'success' }),
    ).rejects.toThrow('different result');
  });

  it('stores hashed document IDs instead of raw user or budget identifiers', async () => {
    const database = new FakeFirestore();
    const store = new FirestoreUsageStore(database, { cleanupBatchSize: 0, expiryGraceMs: 0 });
    await store.reserve({
      request: request('private-operation', 'private-user'),
      units: 1,
      budgets: [{ key: 'private-budget-key', limit: 10 }],
      ttlMs: 60_000,
    });

    const reservationIds = [...database.rows('muc_reservations').keys()];
    const budgetIds = [...database.rows('muc_budgets').keys()];
    expect(reservationIds).toHaveLength(1);
    expect(reservationIds[0]).toMatch(/^fs1\.[a-f0-9]{64}$/);
    expect(budgetIds).toHaveLength(1);
    expect(budgetIds[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify([...database.rows('muc_reservations').values()])).not.toContain('private-user');
    expect(JSON.stringify([...database.rows('muc_budgets').values()])).not.toContain('private-budget-key');
  });
});


describe('FirestoreUsageStore progressive conformance', () => {
  it('passes the portable growth contract on transactional Firestore semantics', async () => {
    const clocks = new Map<string, { now: number }>();
    const report = await runProgressiveUsageStoreConformance({
      createStore(scenario) {
        const clock = { now: 1_000 };
        clocks.set(scenario, clock);
        return new FirestoreUsageStore(new FakeFirestore(), {
          cleanupBatchSize: 16,
          cleanupIntervalMs: 0,
          expiryGraceMs: 0,
          now: () => clock.now,
        });
      },
      waitForLeaseExpiry(ttlMs, scenario) {
        const clock = clocks.get(scenario);
        if (!clock) throw new Error(`missing clock for ${scenario}`);
        clock.now += ttlMs + 1;
      },
    });
    expect(report.cases.filter(result => !result.passed)).toEqual([]);
    expect(report.passed).toBe(true);
  });
});


describe('FirestoreUsageStore vector conformance', () => {
  it('passes the portable atomic vector contract on transactional Firestore semantics', async () => {
    const clocks = new Map<string, { now: number }>();
    const report = await runVectorUsageStoreConformance({
      createStore(scenario) {
        const clock = { now: 1_000 };
        clocks.set(scenario, clock);
        return new FirestoreUsageStore(new FakeFirestore(), {
          cleanupBatchSize: 16,
          cleanupIntervalMs: 0,
          expiryGraceMs: 0,
          now: () => clock.now,
        });
      },
      waitForLeaseExpiry(ttlMs, scenario) {
        const clock = clocks.get(scenario);
        if (!clock) throw new Error(`missing clock for ${scenario}`);
        clock.now += ttlMs + 1;
      },
      concurrency: 8,
    });
    expect(report.cases.filter(result => !result.passed)).toEqual([]);
    expect(report.passed).toBe(true);
  });
});
