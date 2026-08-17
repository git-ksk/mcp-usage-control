import { describe, expect, it } from 'vitest';
import type { UsageRequest } from 'mcp-usage-control';
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
} from './index.js';

class SkewDocumentReference implements FirestoreDocumentReferenceLike {
  constructor(
    readonly collectionPath: string,
    readonly id: string,
  ) {}
}

class SkewSnapshot implements FirestoreDocumentSnapshotLike {
  constructor(private readonly value: Record<string, unknown> | undefined) {}

  get exists(): boolean {
    return this.value !== undefined;
  }

  data(): Record<string, unknown> | undefined {
    return this.value === undefined ? undefined : structuredClone(this.value);
  }
}

class SkewQuerySnapshot extends SkewSnapshot implements FirestoreQueryDocumentSnapshotLike {
  constructor(
    readonly ref: SkewDocumentReference,
    value: Record<string, unknown>,
  ) {
    super(value);
  }
}

class SkewQuery implements FirestoreQueryLike {
  private predicate: ((value: Record<string, unknown>) => boolean) | undefined;
  private maximum = Number.POSITIVE_INFINITY;

  constructor(
    protected readonly database: SharedFirestore,
    protected readonly collectionPath: string,
  ) {}

  where(fieldPath: string, opStr: string, value: unknown): FirestoreQueryLike {
    if (opStr !== '<=' || typeof value !== 'number') throw new Error('unsupported fake query');
    const next = new SkewQuery(this.database, this.collectionPath);
    next.predicate = row => {
      const fieldValue = row[fieldPath];
      return typeof fieldValue === 'number' && fieldValue <= value;
    };
    next.maximum = this.maximum;
    return next;
  }

  limit(limit: number): FirestoreQueryLike {
    const next = new SkewQuery(this.database, this.collectionPath);
    next.predicate = this.predicate;
    next.maximum = limit;
    return next;
  }

  async get(): Promise<FirestoreQuerySnapshotLike> {
    const docs = [...this.database.rows(this.collectionPath).entries()]
      .filter(([, value]) => this.predicate?.(value) ?? true)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, this.maximum)
      .map(
        ([id, value]) =>
          new SkewQuerySnapshot(new SkewDocumentReference(this.collectionPath, id), value),
      );
    return { docs };
  }
}

class SkewCollection extends SkewQuery implements FirestoreCollectionReferenceLike {
  doc(documentPath: string): FirestoreDocumentReferenceLike {
    return new SkewDocumentReference(this.collectionPath, documentPath);
  }
}

class SkewTransaction implements FirestoreTransactionLike {
  private readonly writes = new Map<string, Record<string, unknown> | null>();

  constructor(private readonly database: SharedFirestore) {}

  async get(reference: FirestoreDocumentReferenceLike): Promise<FirestoreDocumentSnapshotLike> {
    return new SkewSnapshot(this.database.read(reference as SkewDocumentReference));
  }

  async getAll(
    ...references: readonly FirestoreDocumentReferenceLike[]
  ): Promise<FirestoreDocumentSnapshotLike[]> {
    return references.map(
      reference => new SkewSnapshot(this.database.read(reference as SkewDocumentReference)),
    );
  }

  set(
    reference: FirestoreDocumentReferenceLike,
    data: Record<string, unknown>,
  ): FirestoreTransactionLike {
    this.writes.set(this.database.key(reference as SkewDocumentReference), structuredClone(data));
    return this;
  }

  delete(reference: FirestoreDocumentReferenceLike): FirestoreTransactionLike {
    this.writes.set(this.database.key(reference as SkewDocumentReference), null);
    return this;
  }

  commit(): void {
    for (const [key, value] of this.writes) this.database.writeKey(key, value);
  }
}

class SharedFirestore implements FirestoreLike {
  private readonly data = new Map<string, Record<string, unknown>>();
  private tail: Promise<void> = Promise.resolve();

  collection(collectionPath: string): FirestoreCollectionReferenceLike {
    return new SkewCollection(this, collectionPath);
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
      const transaction = new SkewTransaction(this);
      const result = await updateFunction(transaction);
      transaction.commit();
      return result;
    } finally {
      release();
    }
  }

  key(reference: SkewDocumentReference): string {
    return `${reference.collectionPath}/${reference.id}`;
  }

  read(reference: SkewDocumentReference): Record<string, unknown> | undefined {
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
      if (key.startsWith(prefix)) result.set(key.slice(prefix.length), structuredClone(value));
    }
    return result;
  }
}

function request(operationId: string): UsageRequest {
  return {
    operationId,
    principal: { id: 'user-a', tenantId: 'tenant-a', plan: 'free' },
    tool: 'search',
    args: {},
  };
}

function storeAt(
  database: SharedFirestore,
  clock: () => number,
  expiryGraceMs: number,
): FirestoreUsageStore {
  return new FirestoreUsageStore(database, {
    cleanupBatchSize: 0,
    expiryGraceMs,
    now: clock,
  });
}

describe('FirestoreUsageStore cross-instance clock skew', () => {
  it('does not reclaim a pending reservation while recovery clock lead stays inside grace', async () => {
    const database = new SharedFirestore();
    let realNow = 10_000;
    const producer = storeAt(database, () => realNow, 500);
    const recovery = storeAt(database, () => realNow + 400, 500);

    const reserved = await producer.reserve({
      request: request('bounded-fast-recovery'),
      units: 1,
      budgets: [{ key: 'day:user-a', limit: 1 }],
      ttlMs: 1_000,
    });
    expect(reserved).toMatchObject({ accepted: true });

    realNow = 10_999;
    await expect(recovery.recoverExpired(10)).resolves.toMatchObject({ pendingCount: 0 });

    await expect(
      recovery.reserve({
        request: request('still-blocked'),
        units: 1,
        budgets: [{ key: 'day:user-a', limit: 1 }],
        ttlMs: 1_000,
      }),
    ).resolves.toMatchObject({ accepted: false, reason: 'quota_exceeded' });

    realNow = 11_100;
    await expect(recovery.recoverExpired(10)).resolves.toMatchObject({
      pendingCount: 1,
      pendingUnits: 1,
    });
  });

  it('applies the same skew grace to growth and releases the full grown pending total on expiry', async () => {
    const database = new SharedFirestore();
    let realNow = 15_000;
    const producer = storeAt(database, () => realNow, 500);
    const recovery = storeAt(database, () => realNow + 400, 500);

    const reserved = await producer.reserve({
      request: request('growth-skew'),
      units: 1,
      budgets: [{ key: 'day:user-a', limit: 3 }],
      ttlMs: 1_000,
    });
    if (!reserved.accepted || !reserved.reservation.growthCursor) {
      throw new Error('expected growable reservation');
    }

    realNow = 15_999;
    const growth = await recovery.growReservation({
      reservationId: reserved.reservation.id,
      incrementId: 'growth-inside-grace',
      expectedGrowthCursor: reserved.reservation.growthCursor,
      additionalUnits: 1,
      budgets: [{ key: 'day:user-a', limit: 3 }],
    });
    expect(growth).toMatchObject({ accepted: true, reservedUnits: 2 });
    if (!growth.accepted) throw new Error('expected growth');

    realNow = 16_100;
    await expect(
      recovery.growReservation({
        reservationId: reserved.reservation.id,
        incrementId: 'growth-after-grace',
        expectedGrowthCursor: growth.growthCursor,
        additionalUnits: 1,
        budgets: [{ key: 'day:user-a', limit: 3 }],
      }),
    ).rejects.toThrow(/expired|not found|active/i);

    await expect(
      recovery.reserve({
        request: request('after-grown-pending-expiry'),
        units: 3,
        budgets: [{ key: 'day:user-a', limit: 3 }],
        ttlMs: 1_000,
      }),
    ).resolves.toMatchObject({ accepted: true });
  });

  it('uses grace to absorb a slow renewing host without premature pending release', async () => {
    const database = new SharedFirestore();
    let realNow = 20_000;
    const producer = storeAt(database, () => realNow, 300);
    const slowRenewer = storeAt(database, () => realNow - 300, 300);
    const recovery = storeAt(database, () => realNow, 300);

    const reserved = await producer.reserve({
      request: request('slow-renewer'),
      units: 1,
      budgets: [{ key: 'day:user-a', limit: 1 }],
      ttlMs: 1_000,
    });
    if (!reserved.accepted) throw new Error('expected reservation');
    expect(reserved.reservation.expiresAt).toBe(21_000);

    realNow = 20_100;
    await expect(
      slowRenewer.renew({ reservationId: reserved.reservation.id, ttlMs: 1_000 }),
    ).resolves.toEqual({
      reservationId: reserved.reservation.id,
      expiresAt: 20_800,
    });

    // The renewing host is 300 ms slow. With a matching 300 ms grace, the
    // recovery host cannot reclaim until a full 1,000 ms of real time has
    // elapsed since the renewal, even though the stored timestamp moved back.
    realNow = 21_099;
    await expect(recovery.recoverExpired(10)).resolves.toMatchObject({ pendingCount: 0 });

    realNow = 21_100;
    await expect(recovery.recoverExpired(10)).resolves.toMatchObject({
      pendingCount: 1,
      pendingUnits: 1,
    });
  });

  it('retains the full charge when a liable lease expires across skewed instances', async () => {
    const database = new SharedFirestore();
    let realNow = 30_000;
    const producer = storeAt(database, () => realNow, 500);
    const recovery = storeAt(database, () => realNow + 400, 500);

    const reserved = await producer.reserve({
      request: request('liable-skew'),
      units: 1,
      budgets: [{ key: 'day:user-a', limit: 1 }],
      ttlMs: 1_000,
    });
    if (!reserved.accepted) throw new Error('expected reservation');
    await producer.markLiable({ reservationId: reserved.reservation.id });

    realNow = 30_999;
    await expect(recovery.recoverExpired(10)).resolves.toMatchObject({ liableCount: 0 });

    realNow = 31_100;
    await expect(recovery.recoverExpired(10)).resolves.toMatchObject({
      liableCount: 1,
      liableUnits: 1,
    });

    await expect(
      recovery.reserve({
        request: request('after-liable-expiry'),
        units: 1,
        budgets: [{ key: 'day:user-a', limit: 1 }],
        ttlMs: 1_000,
      }),
    ).resolves.toMatchObject({ accepted: false, reason: 'quota_exceeded' });
  });
});
