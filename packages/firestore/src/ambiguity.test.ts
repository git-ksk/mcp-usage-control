import { describe, expect, it } from 'vitest';
import type { UsageRequest } from 'mcp-usage-control';
import {
  FirestoreUsageStore,
  type FirestoreCollectionReferenceLike,
  type FirestoreDocumentReferenceLike,
  type FirestoreDocumentSnapshotLike,
  type FirestoreLike,
  type FirestoreQueryLike,
  type FirestoreQuerySnapshotLike,
  type FirestoreTransactionLike,
} from './index.js';

class TestDocumentReference implements FirestoreDocumentReferenceLike {
  constructor(
    readonly collectionPath: string,
    readonly id: string,
  ) {}
}

class TestSnapshot implements FirestoreDocumentSnapshotLike {
  constructor(private readonly value: Record<string, unknown> | undefined) {}

  get exists(): boolean {
    return this.value !== undefined;
  }

  data(): Record<string, unknown> | undefined {
    return this.value === undefined ? undefined : structuredClone(this.value);
  }
}

class EmptyQuery implements FirestoreQueryLike {
  where(): FirestoreQueryLike {
    return this;
  }

  limit(): FirestoreQueryLike {
    return this;
  }

  async get(): Promise<FirestoreQuerySnapshotLike> {
    return { docs: [] };
  }
}

class TestCollection extends EmptyQuery implements FirestoreCollectionReferenceLike {
  constructor(private readonly collectionPath: string) {
    super();
  }

  doc(documentPath: string): FirestoreDocumentReferenceLike {
    return new TestDocumentReference(this.collectionPath, documentPath);
  }
}

class TestTransaction implements FirestoreTransactionLike {
  private readonly writes = new Map<string, Record<string, unknown> | null>();

  constructor(private readonly database: AmbiguousAckFirestore) {}

  async get(reference: FirestoreDocumentReferenceLike): Promise<FirestoreDocumentSnapshotLike> {
    return new TestSnapshot(this.database.read(reference as TestDocumentReference));
  }

  async getAll(
    ...references: readonly FirestoreDocumentReferenceLike[]
  ): Promise<FirestoreDocumentSnapshotLike[]> {
    return references.map(
      reference => new TestSnapshot(this.database.read(reference as TestDocumentReference)),
    );
  }

  set(
    reference: FirestoreDocumentReferenceLike,
    data: Record<string, unknown>,
  ): FirestoreTransactionLike {
    this.writes.set(this.database.key(reference as TestDocumentReference), structuredClone(data));
    return this;
  }

  delete(reference: FirestoreDocumentReferenceLike): FirestoreTransactionLike {
    this.writes.set(this.database.key(reference as TestDocumentReference), null);
    return this;
  }

  commit(): void {
    for (const [key, value] of this.writes) this.database.writeKey(key, value);
  }
}

/**
 * Test double for the important Firestore ambiguity boundary: the transaction
 * commits durably, but the caller receives an error instead of the result.
 */
class AmbiguousAckFirestore implements FirestoreLike {
  private readonly data = new Map<string, Record<string, unknown>>();
  private failAfterCommit = false;

  collection(collectionPath: string): FirestoreCollectionReferenceLike {
    return new TestCollection(collectionPath);
  }

  async runTransaction<T>(
    updateFunction: (transaction: FirestoreTransactionLike) => Promise<T>,
  ): Promise<T> {
    const transaction = new TestTransaction(this);
    const result = await updateFunction(transaction);
    transaction.commit();

    if (this.failAfterCommit) {
      this.failAfterCommit = false;
      throw new Error('simulated ambiguous acknowledgement after commit');
    }

    return result;
  }

  failNextAcknowledgement(): void {
    this.failAfterCommit = true;
  }

  key(reference: TestDocumentReference): string {
    return `${reference.collectionPath}/${reference.id}`;
  }

  read(reference: TestDocumentReference): Record<string, unknown> | undefined {
    const value = this.data.get(this.key(reference));
    return value === undefined ? undefined : structuredClone(value);
  }

  writeKey(key: string, value: Record<string, unknown> | null): void {
    if (value === null) this.data.delete(key);
    else this.data.set(key, structuredClone(value));
  }

  document(collectionPath: string, id: string): Record<string, unknown> | undefined {
    return this.read(new TestDocumentReference(collectionPath, id));
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

function createStore(database: AmbiguousAckFirestore, now: () => number = Date.now) {
  return new FirestoreUsageStore(database, {
    cleanupBatchSize: 0,
    expiryGraceMs: 0,
    now,
  });
}

describe('FirestoreUsageStore ambiguous commit acknowledgements', () => {
  it('fails closed after a reserve commit loses its acknowledgement', async () => {
    const database = new AmbiguousAckFirestore();
    const store = createStore(database);

    database.failNextAcknowledgement();
    await expect(
      store.reserve({
        request: request('lost-reserve-ack'),
        units: 1,
        budgets: [{ key: 'day:user-a', limit: 1 }],
        ttlMs: 60_000,
      }),
    ).rejects.toThrow('simulated ambiguous acknowledgement after commit');

    await expect(
      store.reserve({
        request: request('lost-reserve-ack'),
        units: 1,
        budgets: [{ key: 'day:user-a', limit: 1 }],
        ttlMs: 60_000,
      }),
    ).resolves.toEqual({ accepted: false, reason: 'duplicate_operation' });

    await expect(
      store.reserve({
        request: request('different-operation'),
        units: 1,
        budgets: [{ key: 'day:user-a', limit: 1 }],
        ttlMs: 60_000,
      }),
    ).resolves.toMatchObject({ accepted: false, reason: 'quota_exceeded' });
  });

  it('allows markLiable to be retried after a committed transition loses its acknowledgement', async () => {
    const database = new AmbiguousAckFirestore();
    const store = createStore(database);
    const reserved = await store.reserve({
      request: request('lost-liable-ack'),
      units: 1,
      budgets: [{ key: 'day:user-a', limit: 2 }],
      ttlMs: 60_000,
    });
    if (!reserved.accepted) throw new Error('expected reservation');

    database.failNextAcknowledgement();
    await expect(
      store.markLiable({ reservationId: reserved.reservation.id }),
    ).rejects.toThrow('simulated ambiguous acknowledgement after commit');

    expect(database.document('muc_reservations', reserved.reservation.id)).toMatchObject({
      state: 'liable',
    });

    await expect(
      store.markLiable({ reservationId: reserved.reservation.id }),
    ).resolves.toMatchObject({ reservationId: reserved.reservation.id });
  });

  it('keeps a committed renewal and permits a conservative retry', async () => {
    const database = new AmbiguousAckFirestore();
    let now = 1_000;
    const store = createStore(database, () => now);
    const reserved = await store.reserve({
      request: request('lost-renew-ack'),
      units: 1,
      budgets: [{ key: 'day:user-a', limit: 2 }],
      ttlMs: 100,
    });
    if (!reserved.accepted) throw new Error('expected reservation');

    now = 1_050;
    database.failNextAcknowledgement();
    await expect(
      store.renew({ reservationId: reserved.reservation.id, ttlMs: 1_000 }),
    ).rejects.toThrow('simulated ambiguous acknowledgement after commit');

    expect(database.document('muc_reservations', reserved.reservation.id)).toMatchObject({
      expiresAtMs: 2_050,
    });

    now = 1_200;
    await expect(
      store.renew({ reservationId: reserved.reservation.id, ttlMs: 1_000 }),
    ).resolves.toEqual({ reservationId: reserved.reservation.id, expiresAt: 2_200 });
  });

  it('reconciles a lost settlement acknowledgement only through identical replay', async () => {
    const database = new AmbiguousAckFirestore();
    const store = createStore(database);
    const reserved = await store.reserve({
      request: request('lost-settle-ack'),
      units: 3,
      budgets: [{ key: 'month:user-a', limit: 10 }],
      ttlMs: 60_000,
    });
    if (!reserved.accepted) throw new Error('expected reservation');

    database.failNextAcknowledgement();
    await expect(
      store.settle({ reservationId: reserved.reservation.id, actualUnits: 2, outcome: 'success' }),
    ).rejects.toThrow('simulated ambiguous acknowledgement after commit');

    expect(database.document('muc_reservations', reserved.reservation.id)).toMatchObject({
      state: 'settled',
      actualUnits: 2,
    });

    await expect(
      store.settle({ reservationId: reserved.reservation.id, actualUnits: 2, outcome: 'success' }),
    ).resolves.toMatchObject({
      reservationId: reserved.reservation.id,
      reservedUnits: 3,
      actualUnits: 2,
      releasedUnits: 1,
    });

    await expect(
      store.settle({ reservationId: reserved.reservation.id, actualUnits: 1, outcome: 'success' }),
    ).rejects.toThrow('different result');
  });
});
