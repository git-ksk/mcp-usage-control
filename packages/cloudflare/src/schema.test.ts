import { describe, expect, it } from 'vitest';
import {
  CLOUDFLARE_USAGE_SCHEMA_VERSION,
  initializeCloudflareUsageSchema,
  readCloudflareUsageSchemaVersion,
} from './schema.js';

type SqlValue = ArrayBuffer | string | number | null;
type Row = Record<string, SqlValue>;

const BUDGETS_SQL = `
  CREATE TABLE budgets (
    id TEXT PRIMARY KEY,
    used INTEGER NOT NULL CHECK (used >= 0)
  );
`;

const RESERVATIONS_SQL = `
  CREATE TABLE reservations (
    id TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK (state IN ('pending', 'liable', 'settled')),
    reserved_units INTEGER NOT NULL CHECK (reserved_units >= 0),
    expires_at INTEGER NOT NULL,
    actual_units INTEGER,
    outcome_hash TEXT,
    terminal_reason TEXT,
    tombstone_expires_at INTEGER,
    budget_ids_json TEXT NOT NULL
  );
`;

const BUDGET_COLUMNS: Row[] = [
  { cid: 0, name: 'id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 1 },
  { cid: 1, name: 'used', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
];

const RESERVATION_COLUMNS: Row[] = [
  { cid: 0, name: 'id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 1 },
  { cid: 1, name: 'state', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
  { cid: 2, name: 'reserved_units', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
  { cid: 3, name: 'expires_at', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
  { cid: 4, name: 'actual_units', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 0 },
  { cid: 5, name: 'outcome_hash', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
  { cid: 6, name: 'terminal_reason', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
  { cid: 7, name: 'tombstone_expires_at', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 0 },
  { cid: 8, name: 'budget_ids_json', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
];

const RESERVATION_GROWTH_COLUMNS: Row[] = [
  { cid: 0, name: 'reservation_id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 1 },
  { cid: 1, name: 'growth_cursor', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
  { cid: 2, name: 'last_growth_json', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
];

const RESERVATION_VECTOR_COLUMNS: Row[] = [
  { cid: 0, name: 'reservation_id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 1 },
  { cid: 1, name: 'dimensions_json', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
  { cid: 2, name: 'actual_dimensions_json', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
  { cid: 3, name: 'last_vector_growth_json', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
];

class Cursor<T extends Row> {
  constructor(private readonly rows: T[]) {}
  toArray(): T[] {
    return this.rows.map(row => ({ ...row }));
  }
  one(): T {
    const row = this.rows[0];
    if (!row) throw new Error('no row');
    return { ...row };
  }
  *[Symbol.iterator](): IterableIterator<T> {
    yield* this.toArray();
  }
}

interface TableFixture {
  sql: string;
  columns: Row[];
}

class FakeStorage {
  readonly tables = new Map<string, TableFixture>();
  readonly indexes = new Map<string, string>();
  schemaRows: Row[] = [];
  accountingMutationCount = 0;
  failMetadataInsertOnce = false;

  readonly sql = {
    exec: <T extends Row = Row>(query: string, ...bindings: SqlValue[]): Cursor<T> =>
      this.exec<T>(query, bindings),
  };

  transactionSync<T>(callback: () => T): T {
    const snapshot = this.snapshot();
    try {
      return callback();
    } catch (error) {
      this.restore(snapshot);
      throw error;
    }
  }

  seedLegacyV1(options: { indexes?: boolean; budgetsSql?: string } = {}): void {
    this.tables.set('budgets', {
      sql: options.budgetsSql ?? BUDGETS_SQL,
      columns: BUDGET_COLUMNS.map(row => ({ ...row })),
    });
    this.tables.set('reservations', {
      sql: RESERVATIONS_SQL,
      columns: RESERVATION_COLUMNS.map(row => ({ ...row })),
    });
    if (options.indexes !== false) {
      this.indexes.set(
        'reservations_active_expiry',
        'CREATE INDEX reservations_active_expiry ON reservations(state, expires_at)',
      );
      this.indexes.set(
        'reservations_tombstone_expiry',
        'CREATE INDEX reservations_tombstone_expiry ON reservations(state, tombstone_expires_at)',
      );
    }
  }

  private exec<T extends Row>(query: string, bindings: SqlValue[]): Cursor<T> {
    const normalized = query.trim().replace(/\s+/g, ' ').toLowerCase();

    if (normalized.startsWith('create table if not exists usage_control_schema')) {
      if (!this.tables.has('usage_control_schema')) {
        this.tables.set('usage_control_schema', {
          sql: query,
          columns: [
            { cid: 0, name: 'id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 1 },
            { cid: 1, name: 'version', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
          ],
        });
      }
      return new Cursor<T>([]);
    }

    if (normalized === 'select id, version from usage_control_schema') {
      return new Cursor<T>(this.schemaRows as T[]);
    }

    if (normalized.startsWith('insert into usage_control_schema')) {
      if (this.failMetadataInsertOnce) {
        this.failMetadataInsertOnce = false;
        throw new Error('simulated metadata write interruption');
      }
      this.schemaRows = [{ id: 1, version: Number(bindings[0]) }];
      return new Cursor<T>([]);
    }

    if (normalized.startsWith('update usage_control_schema set version = ? where id = 1')) {
      this.schemaRows = [{ id: 1, version: Number(bindings[0]) }];
      return new Cursor<T>([]);
    }

    if (
      normalized.startsWith("select name, type, sql from sqlite_master where type = 'table' and name in")
    ) {
      const rows = bindings
        .map(name => String(name))
        .flatMap(name => {
          const table = this.tables.get(name);
          return table ? [{ name, type: 'table', sql: table.sql }] : [];
        });
      return new Cursor<T>(rows as unknown as T[]);
    }

    if (normalized.startsWith('create table budgets')) {
      this.tables.set('budgets', {
        sql: query,
        columns: BUDGET_COLUMNS.map(row => ({ ...row })),
      });
      return new Cursor<T>([]);
    }

    if (normalized.startsWith('create table reservations')) {
      this.tables.set('reservations', {
        sql: query,
        columns: RESERVATION_COLUMNS.map(row => ({ ...row })),
      });
      return new Cursor<T>([]);
    }

    if (normalized.startsWith('create table if not exists reservation_growth')) {
      if (!this.tables.has('reservation_growth')) {
        this.tables.set('reservation_growth', {
          sql: query,
          columns: RESERVATION_GROWTH_COLUMNS.map(row => ({ ...row })),
        });
      }
      return new Cursor<T>([]);
    }

    if (normalized.startsWith('create table if not exists reservation_vectors')) {
      if (!this.tables.has('reservation_vectors')) {
        this.tables.set('reservation_vectors', {
          sql: query,
          columns: RESERVATION_VECTOR_COLUMNS.map(row => ({ ...row })),
        });
      }
      return new Cursor<T>([]);
    }

    if (normalized.startsWith('create index if not exists reservations_active_expiry')) {
      if (!this.indexes.has('reservations_active_expiry')) {
        this.indexes.set('reservations_active_expiry', query);
      }
      return new Cursor<T>([]);
    }

    if (normalized.startsWith('create index if not exists reservations_tombstone_expiry')) {
      if (!this.indexes.has('reservations_tombstone_expiry')) {
        this.indexes.set('reservations_tombstone_expiry', query);
      }
      return new Cursor<T>([]);
    }

    const pragma = normalized.match(/^pragma table_info\(([^)]+)\)$/);
    if (pragma) {
      return new Cursor<T>((this.tables.get(pragma[1] ?? '')?.columns ?? []) as T[]);
    }

    if (
      normalized.startsWith("select name, type, sql from sqlite_master where type = 'index' and name = ?")
    ) {
      const name = String(bindings[0]);
      const sql = this.indexes.get(name);
      return new Cursor<T>((sql ? [{ name, type: 'index', sql }] : []) as unknown as T[]);
    }

    if (/^(insert|update|delete)\s+(into\s+)?(budgets|reservations)\b/.test(normalized)) {
      this.accountingMutationCount += 1;
      return new Cursor<T>([]);
    }

    throw new Error(`FakeStorage does not understand SQL: ${query}`);
  }

  private snapshot() {
    return {
      tables: new Map(
        [...this.tables].map(([name, table]) => [
          name,
          { sql: table.sql, columns: table.columns.map(row => ({ ...row })) },
        ]),
      ),
      indexes: new Map(this.indexes),
      schemaRows: this.schemaRows.map(row => ({ ...row })),
      accountingMutationCount: this.accountingMutationCount,
      failMetadataInsertOnce: this.failMetadataInsertOnce,
    };
  }

  private restore(snapshot: ReturnType<FakeStorage['snapshot']>): void {
    this.tables.clear();
    for (const [name, table] of snapshot.tables) this.tables.set(name, table);
    this.indexes.clear();
    for (const [name, sql] of snapshot.indexes) this.indexes.set(name, sql);
    this.schemaRows = snapshot.schemaRows;
    this.accountingMutationCount = snapshot.accountingMutationCount;
    // A simulated external interruption should happen only once, even though
    // the database transaction itself rolls back.
    this.failMetadataInsertOnce = false;
  }
}

function asStorage(fake: FakeStorage): Parameters<typeof initializeCloudflareUsageSchema>[0] {
  return fake as unknown as Parameters<typeof initializeCloudflareUsageSchema>[0];
}

describe('Cloudflare SQLite schema versioning', () => {
  it('creates a fresh v3 database and is safe to run repeatedly', () => {
    const fake = new FakeStorage();
    const storage = asStorage(fake);

    initializeCloudflareUsageSchema(storage);
    initializeCloudflareUsageSchema(storage);

    expect(readCloudflareUsageSchemaVersion(storage)).toBe(CLOUDFLARE_USAGE_SCHEMA_VERSION);
    expect(fake.tables.has('budgets')).toBe(true);
    expect(fake.tables.has('reservations')).toBe(true);
    expect(fake.tables.has('reservation_growth')).toBe(true);
    expect(fake.tables.has('reservation_vectors')).toBe(true);
    expect(fake.indexes.has('reservations_active_expiry')).toBe(true);
    expect(fake.indexes.has('reservations_tombstone_expiry')).toBe(true);
    expect(fake.accountingMutationCount).toBe(0);
  });

  it('adopts and migrates the exact pre-versioning v1 layout without mutating accounting rows', () => {
    const fake = new FakeStorage();
    fake.seedLegacyV1();
    const storage = asStorage(fake);

    initializeCloudflareUsageSchema(storage);

    expect(readCloudflareUsageSchemaVersion(storage)).toBe(CLOUDFLARE_USAGE_SCHEMA_VERSION);
    expect(fake.tables.has('reservation_growth')).toBe(true);
    expect(fake.tables.has('reservation_vectors')).toBe(true);
    expect(fake.accountingMutationCount).toBe(0);
  });

  it('migrates a database explicitly marked v1 through v3 without touching accounting rows', () => {
    const fake = new FakeStorage();
    fake.seedLegacyV1();
    fake.schemaRows = [{ id: 1, version: 1 }];

    initializeCloudflareUsageSchema(asStorage(fake));

    expect(readCloudflareUsageSchemaVersion(asStorage(fake))).toBe(3);
    expect(fake.tables.has('reservation_growth')).toBe(true);
    expect(fake.tables.has('reservation_vectors')).toBe(true);
    expect(fake.accountingMutationCount).toBe(0);
  });

  it('migrates an explicitly marked v2 database to v3 without touching accounting rows', () => {
    const fake = new FakeStorage();
    fake.seedLegacyV1();
    fake.tables.set('reservation_growth', {
      sql: 'CREATE TABLE reservation_growth (reservation_id TEXT PRIMARY KEY, growth_cursor TEXT NOT NULL, last_growth_json TEXT)',
      columns: RESERVATION_GROWTH_COLUMNS.map(row => ({ ...row })),
    });
    fake.schemaRows = [{ id: 1, version: 2 }];

    initializeCloudflareUsageSchema(asStorage(fake));

    expect(readCloudflareUsageSchemaVersion(asStorage(fake))).toBe(3);
    expect(fake.tables.has('reservation_vectors')).toBe(true);
    expect(fake.accountingMutationCount).toBe(0);
  });

  it('repairs missing v1 indexes while preserving the validated tables', () => {
    const fake = new FakeStorage();
    fake.seedLegacyV1({ indexes: false });

    initializeCloudflareUsageSchema(asStorage(fake));

    expect(fake.indexes.has('reservations_active_expiry')).toBe(true);
    expect(fake.indexes.has('reservations_tombstone_expiry')).toBe(true);
    expect(fake.accountingMutationCount).toBe(0);
  });

  it('rolls back an interrupted fresh initialization and succeeds on retry', () => {
    const fake = new FakeStorage();
    fake.failMetadataInsertOnce = true;
    const storage = asStorage(fake);

    expect(() => initializeCloudflareUsageSchema(storage)).toThrow(/interruption/);
    expect(fake.tables.size).toBe(0);
    expect(fake.indexes.size).toBe(0);
    expect(fake.schemaRows).toEqual([]);

    initializeCloudflareUsageSchema(storage);
    expect(readCloudflareUsageSchemaVersion(storage)).toBe(CLOUDFLARE_USAGE_SCHEMA_VERSION);
  });

  it('fails closed on a partial unversioned schema', () => {
    const fake = new FakeStorage();
    fake.tables.set('budgets', {
      sql: BUDGETS_SQL,
      columns: BUDGET_COLUMNS.map(row => ({ ...row })),
    });

    expect(() => initializeCloudflareUsageSchema(asStorage(fake))).toThrow(/expected both/);
    expect(fake.tables.has('usage_control_schema')).toBe(false);
  });

  it('fails closed when legacy constraints do not match v1', () => {
    const fake = new FakeStorage();
    fake.seedLegacyV1({
      budgetsSql: `CREATE TABLE budgets (id TEXT PRIMARY KEY, used INTEGER NOT NULL)`,
    });

    expect(() => initializeCloudflareUsageSchema(asStorage(fake))).toThrow(/constraint/);
    expect(fake.tables.has('usage_control_schema')).toBe(false);
  });

  it('rejects a database marked with a newer schema version', () => {
    const fake = new FakeStorage();
    const storage = asStorage(fake);
    initializeCloudflareUsageSchema(storage);
    fake.schemaRows = [{ id: 1, version: CLOUDFLARE_USAGE_SCHEMA_VERSION + 1 }];

    expect(() => initializeCloudflareUsageSchema(storage)).toThrow(/Unsupported.*version/);
    expect(fake.accountingMutationCount).toBe(0);
  });
});
