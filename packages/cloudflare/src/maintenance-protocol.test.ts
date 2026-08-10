import { describe, expect, it } from 'vitest';
import type { DurableObjectStorage, SqlStorageValue } from 'cloudflare:workers';
import {
  MAX_CLOUDFLARE_PRUNE_BUDGETS,
  pruneCloudflareBudgets,
} from './maintenance-protocol.js';

type Row = Record<string, SqlStorageValue>;

const historical = 'a'.repeat(64);
const current = 'b'.repeat(64);
const active = 'c'.repeat(64);
const missing = 'd'.repeat(64);

class FakeStorage {
  readonly budgets = new Set([historical, current, active]);
  readonly activeBudgetIds = new Set([active]);
  readonly deletes: string[] = [];

  readonly sql = {
    exec: <T extends Row = Row>(query: string, ...bindings: SqlStorageValue[]) => {
      const normalized = query.trim().replace(/\s+/g, ' ').toLowerCase();
      let rows: Row[] = [];

      if (normalized.startsWith('select id from budgets where id = ?')) {
        const id = String(bindings[0]);
        if (this.budgets.has(id)) rows = [{ id }];
      } else if (normalized.startsWith('select 1 as found from reservations')) {
        const quoted = String(bindings[0]);
        const id = quoted.slice(1, -1);
        if (this.activeBudgetIds.has(id)) rows = [{ found: 1 }];
      } else if (normalized.startsWith('delete from budgets where id = ?')) {
        const id = String(bindings[0]);
        this.budgets.delete(id);
        this.deletes.push(id);
      } else {
        throw new Error(`unexpected SQL: ${query}`);
      }

      return {
        toArray: () => rows.map(row => ({ ...row })) as unknown as T[],
        one: () => {
          const row = rows[0];
          if (!row) throw new Error('no row');
          return { ...row } as unknown as T;
        },
        *[Symbol.iterator]() {
          for (const row of rows) yield { ...row } as unknown as T;
        },
      };
    },
  };

  transactionSync<T>(callback: () => T): T {
    const budgets = new Set(this.budgets);
    const deletes = [...this.deletes];
    try {
      return callback();
    } catch (error) {
      this.budgets.clear();
      for (const id of budgets) this.budgets.add(id);
      this.deletes.splice(0, this.deletes.length, ...deletes);
      throw error;
    }
  }
}

function asStorage(fake: FakeStorage): DurableObjectStorage {
  return fake as unknown as DurableObjectStorage;
}

describe('Cloudflare historical budget pruning', () => {
  it('prunes only explicitly selected historical rows', () => {
    const fake = new FakeStorage();
    const result = pruneCloudflareBudgets(asStorage(fake), {
      candidateBudgetIds: [historical, current, active, missing],
      protectedBudgetIds: [current],
    });

    expect(result).toEqual({
      prunedIds: [historical],
      blockedProtectedIds: [current],
      blockedActiveIds: [active],
      missingIds: [missing],
    });
    expect(fake.deletes).toEqual([historical]);
    expect(fake.budgets.has(current)).toBe(true);
    expect(fake.budgets.has(active)).toBe(true);
  });

  it('never deletes an active reservation budget even when it is not protected explicitly', () => {
    const fake = new FakeStorage();
    const result = pruneCloudflareBudgets(asStorage(fake), {
      candidateBudgetIds: [active],
      protectedBudgetIds: [],
    });

    expect(result.blockedActiveIds).toEqual([active]);
    expect(fake.deletes).toEqual([]);
  });

  it('requires incremental batches no larger than the hard bound', () => {
    const fake = new FakeStorage();
    const tooMany = Array.from(
      { length: MAX_CLOUDFLARE_PRUNE_BUDGETS + 1 },
      (_, index) => index.toString(16).padStart(64, '0'),
    );

    expect(() =>
      pruneCloudflareBudgets(asStorage(fake), {
        candidateBudgetIds: tooMany,
        protectedBudgetIds: [],
      }),
    ).toThrow(/at most/);
    expect(fake.deletes).toEqual([]);
  });
});
