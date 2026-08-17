import type { DurableObjectState, SqlStorageValue } from 'cloudflare:workers';

export const CLOUDFLARE_USAGE_SCHEMA_VERSION = 2;

const SCHEMA_TABLE = 'usage_control_schema';
const BUDGETS_TABLE = 'budgets';
const RESERVATIONS_TABLE = 'reservations';
const RESERVATION_GROWTH_TABLE = 'reservation_growth';

const ACTIVE_EXPIRY_INDEX = 'reservations_active_expiry';
const TOMBSTONE_EXPIRY_INDEX = 'reservations_tombstone_expiry';

type DurableObjectStorage = DurableObjectState['storage'];

type SchemaVersionRow = Record<string, SqlStorageValue> & {
  id: number;
  version: number;
};

type SchemaObjectRow = Record<string, SqlStorageValue> & {
  name: string;
  type: string;
  sql: string | null;
};

type TableInfoRow = Record<string, SqlStorageValue> & {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: SqlStorageValue;
  pk: number;
};

interface ExpectedColumn {
  name: string;
  type: string;
  notNull: boolean;
  primaryKey: number;
}

const BUDGET_COLUMNS: readonly ExpectedColumn[] = [
  { name: 'id', type: 'TEXT', notNull: false, primaryKey: 1 },
  { name: 'used', type: 'INTEGER', notNull: true, primaryKey: 0 },
];

const RESERVATION_COLUMNS: readonly ExpectedColumn[] = [
  { name: 'id', type: 'TEXT', notNull: false, primaryKey: 1 },
  { name: 'state', type: 'TEXT', notNull: true, primaryKey: 0 },
  { name: 'reserved_units', type: 'INTEGER', notNull: true, primaryKey: 0 },
  { name: 'expires_at', type: 'INTEGER', notNull: true, primaryKey: 0 },
  { name: 'actual_units', type: 'INTEGER', notNull: false, primaryKey: 0 },
  { name: 'outcome_hash', type: 'TEXT', notNull: false, primaryKey: 0 },
  { name: 'terminal_reason', type: 'TEXT', notNull: false, primaryKey: 0 },
  { name: 'tombstone_expires_at', type: 'INTEGER', notNull: false, primaryKey: 0 },
  { name: 'budget_ids_json', type: 'TEXT', notNull: true, primaryKey: 0 },
];

const RESERVATION_GROWTH_COLUMNS: readonly ExpectedColumn[] = [
  { name: 'reservation_id', type: 'TEXT', notNull: false, primaryKey: 1 },
  { name: 'growth_cursor', type: 'TEXT', notNull: true, primaryKey: 0 },
  { name: 'last_growth_json', type: 'TEXT', notNull: false, primaryKey: 0 },
];

/**
 * Initializes or validates the Cloudflare SQLite schema as one synchronous
 * transaction. The first versioned release adopts the exact pre-versioning
 * schema as v1 without rewriting accounting rows.
 */
export function initializeCloudflareUsageSchema(storage: DurableObjectStorage): void {
  storage.transactionSync(() => {
    createSchemaTable(storage);
    const version = readSchemaVersion(storage);

    if (version === undefined) {
      adoptOrCreateV1(storage);
      migrateV1ToV2(storage);
      storage.sql.exec(
        `INSERT INTO ${SCHEMA_TABLE} (id, version) VALUES (1, ?)`,
        CLOUDFLARE_USAGE_SCHEMA_VERSION,
      );
      validateV2(storage);
      return;
    }

    if (version > CLOUDFLARE_USAGE_SCHEMA_VERSION) {
      throw new Error(
        `Unsupported Cloudflare usage schema version ${version}; ` +
          `runtime supports up to ${CLOUDFLARE_USAGE_SCHEMA_VERSION}`,
      );
    }

    if (version === 1) {
      validateV1(storage, { allowMissingIndexes: false });
      migrateV1ToV2(storage);
      storage.sql.exec(`UPDATE ${SCHEMA_TABLE} SET version = ? WHERE id = 1`, 2);
      validateV2(storage);
      return;
    }

    if (version < CLOUDFLARE_USAGE_SCHEMA_VERSION) {
      throw new Error(
        `Unsupported older Cloudflare usage schema version ${version}; ` +
          'no migration step is registered',
      );
    }

    validateV2(storage);
  });
}

export function readCloudflareUsageSchemaVersion(
  storage: DurableObjectStorage,
): number | undefined {
  return readSchemaVersion(storage);
}

function createSchemaTable(storage: DurableObjectStorage): void {
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA_TABLE} (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL CHECK (version >= 1)
    );
  `);
}

function readSchemaVersion(storage: DurableObjectStorage): number | undefined {
  const rows = storage.sql
    .exec<SchemaVersionRow>(`SELECT id, version FROM ${SCHEMA_TABLE}`)
    .toArray();
  if (rows.length === 0) return undefined;
  if (rows.length !== 1) throw new Error('Invalid Cloudflare usage schema metadata');

  const row = rows[0];
  if (!row || integer(row.id, 'schema id') !== 1) {
    throw new Error('Invalid Cloudflare usage schema metadata');
  }
  const version = integer(row.version, 'schema version');
  if (version < 1) throw new Error('Invalid Cloudflare usage schema version');
  return version;
}

function adoptOrCreateV1(storage: DurableObjectStorage): void {
  const objects = applicationTables(storage);
  const hasBudgets = objects.has(BUDGETS_TABLE);
  const hasReservations = objects.has(RESERVATIONS_TABLE);

  if (!hasBudgets && !hasReservations) {
    createV1Tables(storage);
    createV1Indexes(storage);
    validateV1(storage, { allowMissingIndexes: false });
    return;
  }

  if (!hasBudgets || !hasReservations) {
    throw new Error(
      'Incompatible unversioned Cloudflare usage schema: expected both budgets and reservations tables',
    );
  }

  // This is the exact schema shipped before explicit versioning. Validate it
  // before adding the v1 marker so unknown/partial layouts never get adopted.
  validateV1(storage, { allowMissingIndexes: true });
  createV1Indexes(storage);
  validateV1(storage, { allowMissingIndexes: false });
}

function createV1Tables(storage: DurableObjectStorage): void {
  storage.sql.exec(`
    CREATE TABLE ${BUDGETS_TABLE} (
      id TEXT PRIMARY KEY,
      used INTEGER NOT NULL CHECK (used >= 0)
    );
  `);
  storage.sql.exec(`
    CREATE TABLE ${RESERVATIONS_TABLE} (
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
  `);
}

function createV1Indexes(storage: DurableObjectStorage): void {
  storage.sql.exec(
    `CREATE INDEX IF NOT EXISTS ${ACTIVE_EXPIRY_INDEX}
     ON ${RESERVATIONS_TABLE}(state, expires_at)`,
  );
  storage.sql.exec(
    `CREATE INDEX IF NOT EXISTS ${TOMBSTONE_EXPIRY_INDEX}
     ON ${RESERVATIONS_TABLE}(state, tombstone_expires_at)`,
  );
}

function migrateV1ToV2(storage: DurableObjectStorage): void {
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS ${RESERVATION_GROWTH_TABLE} (
      reservation_id TEXT PRIMARY KEY,
      growth_cursor TEXT NOT NULL,
      last_growth_json TEXT
    );
  `);
}

function validateV2(storage: DurableObjectStorage): void {
  validateV1(storage, { allowMissingIndexes: false });
  const objects = applicationTables(storage);
  if (!objects.has(RESERVATION_GROWTH_TABLE)) {
    throw new Error('Cloudflare usage schema v2 is missing reservation_growth');
  }
  validateColumns(storage, RESERVATION_GROWTH_TABLE, RESERVATION_GROWTH_COLUMNS);
}

function validateV1(
  storage: DurableObjectStorage,
  options: { allowMissingIndexes: boolean },
): void {
  const objects = applicationTables(storage);
  if (!objects.has(BUDGETS_TABLE) || !objects.has(RESERVATIONS_TABLE)) {
    throw new Error('Cloudflare usage schema v1 is missing required tables');
  }

  validateColumns(storage, BUDGETS_TABLE, BUDGET_COLUMNS);
  validateColumns(storage, RESERVATIONS_TABLE, RESERVATION_COLUMNS);

  const budgetsSql = objectSql(objects, BUDGETS_TABLE);
  requireSqlFragment(budgetsSql, 'check(used>=0)', BUDGETS_TABLE);

  const reservationsSql = objectSql(objects, RESERVATIONS_TABLE);
  requireSqlFragment(
    reservationsSql,
    "check(statein('pending','liable','settled'))",
    RESERVATIONS_TABLE,
  );
  requireSqlFragment(
    reservationsSql,
    'check(reserved_units>=0)',
    RESERVATIONS_TABLE,
  );

  validateIndex(
    storage,
    ACTIVE_EXPIRY_INDEX,
    'onreservations(state,expires_at)',
    options.allowMissingIndexes,
  );
  validateIndex(
    storage,
    TOMBSTONE_EXPIRY_INDEX,
    'onreservations(state,tombstone_expires_at)',
    options.allowMissingIndexes,
  );
}

function applicationTables(storage: DurableObjectStorage): Map<string, SchemaObjectRow> {
  const rows = storage.sql
    .exec<SchemaObjectRow>(
      `SELECT name, type, sql FROM sqlite_master
       WHERE type = 'table' AND name IN (?, ?, ?)`,
      BUDGETS_TABLE,
      RESERVATIONS_TABLE,
      RESERVATION_GROWTH_TABLE,
    )
    .toArray();
  return new Map(rows.map(row => [String(row.name), row]));
}

function validateColumns(
  storage: DurableObjectStorage,
  tableName: string,
  expected: readonly ExpectedColumn[],
): void {
  const rows = storage.sql
    .exec<TableInfoRow>(`PRAGMA table_info(${tableName})`)
    .toArray();
  if (rows.length !== expected.length) {
    throw new Error(`Incompatible Cloudflare usage schema for ${tableName}: column count differs`);
  }

  for (let index = 0; index < expected.length; index += 1) {
    const row = rows[index];
    const column = expected[index];
    if (!row || !column) throw new Error(`Invalid schema metadata for ${tableName}`);

    const name = String(row.name);
    const type = String(row.type).toUpperCase();
    const notNull = integer(row.notnull, `${tableName}.${name}.notnull`) === 1;
    const primaryKey = integer(row.pk, `${tableName}.${name}.pk`);

    if (
      name !== column.name ||
      type !== column.type ||
      notNull !== column.notNull ||
      primaryKey !== column.primaryKey
    ) {
      throw new Error(
        `Incompatible Cloudflare usage schema for ${tableName}.${column.name}`,
      );
    }
  }
}

function validateIndex(
  storage: DurableObjectStorage,
  name: string,
  requiredSqlFragment: string,
  allowMissing: boolean,
): void {
  const rows = storage.sql
    .exec<SchemaObjectRow>(
      `SELECT name, type, sql FROM sqlite_master WHERE type = 'index' AND name = ?`,
      name,
    )
    .toArray();
  if (rows.length === 0) {
    if (allowMissing) return;
    throw new Error(`Cloudflare usage schema v1 is missing index ${name}`);
  }
  if (rows.length !== 1) throw new Error(`Invalid Cloudflare usage index metadata: ${name}`);
  const sql = rows[0]?.sql;
  if (typeof sql !== 'string' || !compactSql(sql).includes(requiredSqlFragment)) {
    throw new Error(`Incompatible Cloudflare usage index ${name}`);
  }
}

function objectSql(objects: Map<string, SchemaObjectRow>, name: string): string {
  const sql = objects.get(name)?.sql;
  if (typeof sql !== 'string') throw new Error(`Missing SQL definition for ${name}`);
  return compactSql(sql);
}

function requireSqlFragment(sql: string, fragment: string, objectName: string): void {
  if (!sql.includes(fragment)) {
    throw new Error(`Incompatible Cloudflare usage schema constraint for ${objectName}`);
  }
}

function compactSql(sql: string): string {
  return sql.toLowerCase().replace(/\s+/g, '');
}

function integer(value: SqlStorageValue, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}
