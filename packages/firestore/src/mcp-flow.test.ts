import { describe, expect, it } from 'vitest';
import type { Firestore } from '@google-cloud/firestore';
import { assertMcpUsageFlowStoreConformance } from 'mcp-usage-control-mcp/conformance';
import { FirestoreMcpUsageFlowStore, type FirestoreMcpUsageFlowRecord } from './mcp-flow.js';

class FakeFlowFirestore {
  readonly rows = new Map<string, Record<string, unknown>>();
  private last = Promise.resolve();
  readonly clock = { current: Date.now() };
  clockUnavailable = false;
  loseAck = false;

  collection(path: string) {
    return { doc: (id: string) => ({ id: `${path}/${id}` }) };
  }
  async runTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    const previous = this.last;
    let release!: () => void;
    this.last = new Promise<void>(r => { release = r; });
    await previous;
    const pending = new Map<string, Record<string, unknown> | null>();
    const tx = {
      get: async ({ id }: { id: string }) => {
        const row = this.rows.get(id);
        return {
          exists: !!row,
          ...(this.clockUnavailable ? {} : { readTime: { toMillis: () => this.clock.current } }),
          data: () => row ? structuredClone(row) : undefined,
        };
      },
      create: ({ id }: { id: string }, row: Record<string, unknown>) => {
        if (this.rows.has(id)) throw new Error('ALREADY_EXISTS');
        pending.set(id, structuredClone(row));
      },
      delete: ({ id }: { id: string }) => { pending.set(id, null); },
    };
    try {
      const result = await fn(tx);
      for (const [id, row] of pending) {
        if (row) this.rows.set(id, row);
        else this.rows.delete(id);
      }
      if (this.loseAck) throw new Error('UNAVAILABLE: lost commit acknowledgement');
      return result;
    } finally {
      release();
    }
  }
}

function record(id = 'flow-test-00000001'): FirestoreMcpUsageFlowRecord {
  const expiresAt = Date.now() + 60_000;
  return {
    flowId: id,
    binding: { principalId: 'alice', tenantId: 'tenant-a', tool: 'read', argsHash: 'a'.repeat(64) },
    round: 1,
    expiresAt,
    lease: {
      reservation: {
        id: 'reservation-0000001', operationId: 'operation-000001', principalId: 'alice',
        tenantId: 'tenant-a', tool: 'read', budgetKeys: ['daily:tenant-a'], reservedUnits: 1, expiresAt,
      },
      ttlMs: 60_000,
    },
    applicationRequestState: 'private-app-state',
  };
}

// Compile-time check: no consumer-side cast is required for the official Admin SDK.
function assertOfficialFirestoreTypeCompatibility(db: Firestore): void {
  new FirestoreMcpUsageFlowStore(db);
}
void assertOfficialFirestoreTypeCompatibility;

describe('Firestore MCP flow store isolated transactional contract', () => {
  it('passes the portable five-case one-time flow-store contract with 16 contenders', async () => {
    const database = new FakeFlowFirestore();
    const report = await assertMcpUsageFlowStoreConformance({
      createStore(scenario) {
        return new FirestoreMcpUsageFlowStore(database as any, {
          collectionPath: `contract_${scenario.replaceAll('-', '_')}`,
        });
      },
      waitForFlowExpiry(ms) { database.clock.current += ms + 2_000; },
      flowTtlMs: 2_000,
      concurrency: 16,
    });
    expect(report.passed).toBe(true);
  });

  it('survives corrupt payload without consuming and never exposes another tenant flow', async () => {
    const db = new FakeFlowFirestore();
    const store = new FirestoreMcpUsageFlowStore(db as any);
    const original = record();
    await store.suspend(original);
    expect(await store.consume(original.flowId, { ...original.binding, tenantId: 'malicious' })).toBeUndefined();
    const key = `muc_mcp_flows/${original.flowId}`;
    const row = db.rows.get(key)!;
    db.rows.set(key, { ...row, payload: '{invalid' });
    await expect(store.consume(original.flowId, original.binding)).rejects.toThrow(/invalid/);
    expect(db.rows.has(key)).toBe(true);
  });

  it('fails closed when backend read time is unavailable', async () => {
    const db = new FakeFlowFirestore();
    db.clockUnavailable = true;
    const store = new FirestoreMcpUsageFlowStore(db as any);
    await expect(store.suspend(record())).rejects.toThrow(/readTime/);
    expect(db.rows.size).toBe(0);
  });

  it('never retries consumed flow after committed-but-lost ACK', async () => {
    const db = new FakeFlowFirestore();
    const store = new FirestoreMcpUsageFlowStore(db as any);
    const original = record();
    await store.suspend(original);
    db.loseAck = true;
    await expect(store.consume(original.flowId, original.binding)).rejects.toThrow(/acknowledgement/);
    db.loseAck = false;
    expect(await store.consume(original.flowId, original.binding)).toBeUndefined();
  });

  it('rejects short-lived / already expiring records with a safety margin', async () => {
    const db = new FakeFlowFirestore();
    const store = new FirestoreMcpUsageFlowStore(db as any);
    const original = record();
    original.expiresAt = db.clock.current + 200;
    original.lease.reservation.expiresAt = original.expiresAt;
    await expect(store.suspend(original)).rejects.toThrow(/expiry/);
    expect(db.rows.size).toBe(0);
  });
});
