import { describe, expect, it } from 'vitest';
import type { UsageEvent, UsageRequest } from './index.js';
import {
  FirestoreUsageStore,
  type FirestoreCollectionReferenceLike,
  type FirestoreDocumentReferenceLike,
  type FirestoreDocumentSnapshotLike,
  type FirestoreLike,
  type FirestoreQueryDocumentSnapshotLike,
  type FirestoreQueryLike,
  type FirestoreQuerySnapshotLike,
  type FirestoreTransactionLike,
} from './firestore.js';

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
    next.predicate = row => typeof row[fieldPath] === 'number' && row[fieldPath] <= value;
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
    const events: UsageEvent[] = [];
    const store = new FirestoreUsageStore(database, {
      cleanupBatchSize: 0,
      expiryGraceMs: 0,
      now: () => now,
      observer: { onEvent: event => events.push(event) },
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

  it('retains full usage after an expired liable reservation', async () => {
    const database = new FakeFirestore();
    let now = 10_000;
    const store = new FirestoreUsageStore(database, {
      cleanupBatchSize: 0,
      expiryGraceMs: 0,
      now: () => now,
    });

    const first = await store.reserve({
      request: request('liable'),
      units: 1,
      budgets: [{ key: 'day:user-a', limit: 1 }],
      ttlMs: 100,
    });
    if (!first.accepted) throw new Error('expected reservation');
    await store.markLiable({ reservationId: first.reservation.id });

    now = 10_101;
    const recovered = await store.recoverExpired(10);
    expect(recovered).toMatchObject({ liableCount: 1, liableUnits: 1 });

    const duplicate = await store.reserve({
      request: request('liable'),
      units: 1,
      budgets: [{ key: 'day:user-a', limit: 1 }],
      ttlMs: 100,
    });
    expect(duplicate).toEqual({ accepted: false, reason: 'duplicate_operation' });

    const another = await store.reserve({
      request: request('another'),
      units: 1,
      budgets: [{ key: 'day:user-a', limit: 1 }],
      ttlMs: 100,
    });
    expect(another).toMatchObject({ accepted: false, reason: 'quota_exceeded' });
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
