import {
  DurableObject,
  type DurableObjectState,
  type SqlStorageValue,
} from 'cloudflare:workers';
import type {
  CloudflareDirectRecovery,
  CloudflareGrowCommand,
  CloudflareGrowReply,
  CloudflareMarkLiableCommand,
  CloudflareRecoveryReport,
  CloudflareRecoverySummary,
  CloudflareRenewCommand,
  CloudflareReserveCommand,
  CloudflareReserveReply,
  CloudflareSettlementReply,
  CloudflareSettleCommand,
  CloudflareVectorActualDimension,
  CloudflareVectorGrowCommand,
  CloudflareVectorGrowReply,
  CloudflareVectorReserveCommand,
  CloudflareVectorReserveReply,
  CloudflareVectorSettleCommand,
  CloudflareVectorSettlementReply,
  CloudflareStoreEnvelope,
  CloudflareStoreErrorCode,
} from './index.js';

const RESERVATION_ID_PATTERN = /^cf1\.[a-f0-9]{64}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const LEASE_EXPIRED_REASON = 'lease_expired_after_execution_started';

type ReservationRow = Record<string, SqlStorageValue> & {
  id: string;
  state: string;
  reserved_units: number;
  expires_at: number;
  actual_units: number | null;
  outcome_hash: string | null;
  terminal_reason: string | null;
  tombstone_expires_at: number | null;
  budget_ids_json: string;
};

type StateRow = Record<string, SqlStorageValue> & {
  state: string;
  expires_at: number;
  reserved_units: number;
  actual_units: number | null;
  outcome_hash: string | null;
  terminal_reason: string | null;
  budget_ids_json: string;
};

type UsedRow = Record<string, SqlStorageValue> & { used: number };

type GrowthRow = Record<string, SqlStorageValue> & {
  growth_cursor: string;
  last_growth_json: string | null;
};

type VectorRow = Record<string, SqlStorageValue> & {
  dimensions_json: string;
  actual_dimensions_json: string | null;
  last_vector_growth_json: string | null;
};

interface StoredVectorDimension {
  id: string;
  reservedUnits: number;
  budgetIds: string[];
}

interface StoredVectorGrowthReplay {
  incrementHash: string;
  expectedGrowthCursor: string;
  fingerprint: string;
  nextGrowthCursor: string;
  accepted: boolean;
  previousReservedByDimension?: Array<{ id: string; reservedUnits: number }>;
  reservedByDimension?: Array<{ id: string; reservedUnits: number }>;
  remainingByBudget?: Array<{ dimensionId: string; budgetId: string; remaining: number }>;
  limitingDimensionId?: string;
  limitingBudgetId?: string;
  remaining?: number;
}

interface StoredGrowthReplay {
  incrementHash: string;
  expectedGrowthCursor: string;
  fingerprint: string;
  nextGrowthCursor: string;
  accepted: boolean;
  previousReservedUnits?: number;
  reservedUnits?: number;
  remainingByBudget?: Array<{ id: string; remaining: number }>;
  limitingBudgetId?: string;
  remaining?: number;
}

/**
 * SQLite-backed Durable Object implementing one atomic usage-control domain.
 * Export this class from a Worker and declare it with storage = "sqlite".
 */
export class UsageControlDurableObject extends DurableObject<unknown> {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.ensureSchema();
  }

  async reserve(
    command: CloudflareReserveCommand,
  ): Promise<CloudflareStoreEnvelope<CloudflareReserveReply>> {
    validateReserveCommand(command);
    const now = Date.now();

    return this.ctx.storage.transactionSync(() => {
      const recovery = this.recoverExpiredBatch(
        now,
        command.cleanupBatchSize,
        command.idempotencyTtlMs,
      );

      const existing = this.ctx.storage.sql
        .exec('SELECT id FROM reservations WHERE id = ?', command.reservationId)
        .toArray();
      if (existing.length > 0) {
        return ok<CloudflareReserveReply>(
          { accepted: false, reason: 'duplicate_operation' },
          recovery,
        );
      }

      const balances = command.budgets.map(budget => {
        const row = this.ctx.storage.sql
          .exec<UsedRow>('SELECT used FROM budgets WHERE id = ?', budget.id)
          .toArray()[0];
        const used = row ? integer(row.used, 'used') : 0;
        return {
          id: budget.id,
          used,
          remaining: Math.max(0, budget.limit - used),
        };
      });

      const limiting = balances.find(balance => command.units > balance.remaining);
      if (limiting) {
        return ok<CloudflareReserveReply>(
          {
            accepted: false,
            reason: 'quota_exceeded',
            limitingBudgetId: limiting.id,
            remaining: limiting.remaining,
          },
          recovery,
        );
      }

      for (const budget of command.budgets) {
        this.ctx.storage.sql.exec(
          `INSERT INTO budgets (id, used) VALUES (?, ?)
           ON CONFLICT(id) DO UPDATE SET used = budgets.used + excluded.used`,
          budget.id,
          command.units,
        );
      }

      const expiresAt = safeAdd(now, command.ttlMs, 'expiresAt');
      this.ctx.storage.sql.exec(
        'DELETE FROM reservation_growth WHERE reservation_id = ?',
        command.reservationId,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO reservations (
          id, state, reserved_units, expires_at, actual_units, outcome_hash,
          terminal_reason, tombstone_expires_at, budget_ids_json
        ) VALUES (?, 'pending', ?, ?, NULL, NULL, NULL, NULL, ?)`,
        command.reservationId,
        command.units,
        expiresAt,
        JSON.stringify(command.budgets.map(budget => budget.id)),
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO reservation_growth (reservation_id, growth_cursor, last_growth_json)
         VALUES (?, ?, NULL)`,
        command.reservationId,
        command.initialGrowthCursor,
      );

      return ok<CloudflareReserveReply>(
        {
          accepted: true,
          expiresAt,
          remainingByBudget: balances.map(balance => ({
            id: balance.id,
            remaining: balance.remaining - command.units,
          })),
        },
        recovery,
      );
    });
  }

  async reserveVector(
    command: CloudflareVectorReserveCommand,
  ): Promise<CloudflareStoreEnvelope<CloudflareVectorReserveReply>> {
    validateVectorReserveCommand(command);
    const now = Date.now();

    return this.ctx.storage.transactionSync(() => {
      const recovery = this.recoverExpiredBatch(
        now,
        command.cleanupBatchSize,
        command.idempotencyTtlMs,
      );
      const existing = this.ctx.storage.sql
        .exec('SELECT id FROM reservations WHERE id = ?', command.reservationId)
        .toArray();
      if (existing.length > 0) {
        return ok<CloudflareVectorReserveReply>(
          { accepted: false, reason: 'duplicate_operation' },
          recovery,
        );
      }

      const balances: Array<{
        dimensionId: string;
        budgetId: string;
        remaining: number;
      }> = [];
      let limiting:
        | { dimensionId: string; budgetId: string; remaining: number }
        | undefined;
      for (const dimension of command.dimensions) {
        for (const budget of dimension.budgets) {
          const row = this.ctx.storage.sql
            .exec<UsedRow>('SELECT used FROM budgets WHERE id = ?', budget.id)
            .toArray()[0];
          const used = row ? integer(row.used, 'used') : 0;
          const remaining = Math.max(0, budget.limit - used);
          balances.push({ dimensionId: dimension.id, budgetId: budget.id, remaining });
          if (!limiting && dimension.units > remaining) {
            limiting = { dimensionId: dimension.id, budgetId: budget.id, remaining };
          }
        }
      }
      if (limiting) {
        return ok<CloudflareVectorReserveReply>(
          {
            accepted: false,
            reason: 'quota_exceeded',
            limitingDimensionId: limiting.dimensionId,
            limitingBudgetId: limiting.budgetId,
            remaining: limiting.remaining,
          },
          recovery,
        );
      }

      for (const dimension of command.dimensions) {
        for (const budget of dimension.budgets) {
          this.ctx.storage.sql.exec(
            `INSERT INTO budgets (id, used) VALUES (?, ?)
             ON CONFLICT(id) DO UPDATE SET used = budgets.used + excluded.used`,
            budget.id,
            dimension.units,
          );
        }
      }
      const expiresAt = safeAdd(now, command.ttlMs, 'expiresAt');
      this.ctx.storage.sql.exec(
        `INSERT INTO reservations (
          id, state, reserved_units, expires_at, actual_units, outcome_hash,
          terminal_reason, tombstone_expires_at, budget_ids_json
        ) VALUES (?, 'pending', 0, ?, NULL, NULL, NULL, NULL, '[]')`,
        command.reservationId,
        expiresAt,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO reservation_growth (reservation_id, growth_cursor, last_growth_json)
         VALUES (?, ?, NULL)`,
        command.reservationId,
        command.initialGrowthCursor,
      );
      const dimensions: StoredVectorDimension[] = command.dimensions.map(dimension => ({
        id: dimension.id,
        reservedUnits: dimension.units,
        budgetIds: dimension.budgets.map(budget => budget.id),
      }));
      this.ctx.storage.sql.exec(
        `INSERT INTO reservation_vectors (
           reservation_id, dimensions_json, actual_dimensions_json, last_vector_growth_json
         ) VALUES (?, ?, NULL, NULL)`,
        command.reservationId,
        JSON.stringify(dimensions),
      );
      const unitsByDimension = new Map(
        command.dimensions.map(dimension => [dimension.id, dimension.units] as const),
      );
      return ok<CloudflareVectorReserveReply>(
        {
          accepted: true,
          expiresAt,
          remainingByBudget: balances.map(balance => ({
            ...balance,
            remaining: balance.remaining - (unitsByDimension.get(balance.dimensionId) ?? 0),
          })),
        },
        recovery,
      );
    });
  }

  async grow(
    command: CloudflareGrowCommand,
  ): Promise<CloudflareStoreEnvelope<CloudflareGrowReply>> {
    validateGrowCommand(command);
    const now = Date.now();

    return this.ctx.storage.transactionSync(() => {
      const direct = this.recoverSpecific(command.reservationId, now, command.idempotencyTtlMs);
      const recovery = reportWithDirect(direct);
      if (direct) return fail('not_found_or_expired', recovery);

      const row = this.ctx.storage.sql
        .exec<StateRow>(
          `SELECT state, expires_at, reserved_units, actual_units, outcome_hash,
                  terminal_reason, budget_ids_json
           FROM reservations WHERE id = ?`,
          command.reservationId,
        )
        .toArray()[0];
      if (!row || (row.state !== 'pending' && row.state !== 'liable')) {
        return fail('not_found_or_expired', recovery);
      }
      if (this.readVectorRow(command.reservationId)) {
        return fail('usage_mode_mismatch', recovery);
      }

      const growthRow = this.ctx.storage.sql
        .exec<GrowthRow>(
          `SELECT growth_cursor, last_growth_json
           FROM reservation_growth WHERE reservation_id = ?`,
          command.reservationId,
        )
        .toArray()[0];
      if (!growthRow) return fail('growth_not_supported', recovery);
      const currentCursor = nonEmptyString(growthRow.growth_cursor, 'growth cursor');
      const lastGrowth = parseStoredGrowth(growthRow.last_growth_json);

      if (lastGrowth?.incrementHash === command.incrementHash) {
        if (
          lastGrowth.expectedGrowthCursor !== command.expectedGrowthCursor ||
          lastGrowth.fingerprint !== command.fingerprint
        ) {
          return fail('growth_conflict', recovery);
        }
        return ok(growthReplyFromStored(lastGrowth, true), recovery);
      }

      if (currentCursor !== command.expectedGrowthCursor) {
        return fail('growth_stale_cursor', recovery);
      }

      const storedBudgetIds = parseBudgetIds(row.budget_ids_json);
      const commandBudgetIds = command.budgets.map(budget => budget.id);
      if (!sameStrings(storedBudgetIds, commandBudgetIds)) {
        return fail('growth_budget_mismatch', recovery);
      }

      const balances = command.budgets.map(budget => {
        const usedRow = this.ctx.storage.sql
          .exec<UsedRow>('SELECT used FROM budgets WHERE id = ?', budget.id)
          .toArray()[0];
        const used = usedRow ? integer(usedRow.used, 'used') : 0;
        return { id: budget.id, remaining: Math.max(0, budget.limit - used) };
      });
      const limiting = balances.find(balance => command.additionalUnits > balance.remaining);

      if (limiting) {
        const stored: StoredGrowthReplay = {
          incrementHash: command.incrementHash,
          expectedGrowthCursor: command.expectedGrowthCursor,
          fingerprint: command.fingerprint,
          nextGrowthCursor: command.nextGrowthCursor,
          accepted: false,
          limitingBudgetId: limiting.id,
          remaining: limiting.remaining,
        };
        this.ctx.storage.sql.exec(
          `UPDATE reservation_growth
           SET growth_cursor = ?, last_growth_json = ?
           WHERE reservation_id = ?`,
          command.nextGrowthCursor,
          JSON.stringify(stored),
          command.reservationId,
        );
        return ok(growthReplyFromStored(stored, false), recovery);
      }

      const previousReservedUnits = integer(row.reserved_units, 'reservedUnits');
      const reservedUnits = safeAdd(previousReservedUnits, command.additionalUnits, 'reservedUnits');
      for (const budget of command.budgets) {
        this.ctx.storage.sql.exec(
          'UPDATE budgets SET used = used + ? WHERE id = ?',
          command.additionalUnits,
          budget.id,
        );
      }
      this.ctx.storage.sql.exec(
        `UPDATE reservations SET reserved_units = ? WHERE id = ? AND state IN ('pending', 'liable')`,
        reservedUnits,
        command.reservationId,
      );
      const stored: StoredGrowthReplay = {
        incrementHash: command.incrementHash,
        expectedGrowthCursor: command.expectedGrowthCursor,
        fingerprint: command.fingerprint,
        nextGrowthCursor: command.nextGrowthCursor,
        accepted: true,
        previousReservedUnits,
        reservedUnits,
        remainingByBudget: balances.map(balance => ({
          id: balance.id,
          remaining: balance.remaining - command.additionalUnits,
        })),
      };
      this.ctx.storage.sql.exec(
        `UPDATE reservation_growth
         SET growth_cursor = ?, last_growth_json = ?
         WHERE reservation_id = ?`,
        command.nextGrowthCursor,
        JSON.stringify(stored),
        command.reservationId,
      );
      return ok(growthReplyFromStored(stored, false), recovery);
    });
  }

  async growVector(
    command: CloudflareVectorGrowCommand,
  ): Promise<CloudflareStoreEnvelope<CloudflareVectorGrowReply>> {
    validateVectorGrowCommand(command);
    const now = Date.now();

    return this.ctx.storage.transactionSync(() => {
      const direct = this.recoverSpecific(command.reservationId, now, command.idempotencyTtlMs);
      const recovery = reportWithDirect(direct);
      if (direct) return fail('not_found_or_expired', recovery);

      const row = this.ctx.storage.sql
        .exec<StateRow>(
          `SELECT state, expires_at, reserved_units, actual_units, outcome_hash,
                  terminal_reason, budget_ids_json
           FROM reservations WHERE id = ?`,
          command.reservationId,
        )
        .toArray()[0];
      if (!row || (row.state !== 'pending' && row.state !== 'liable')) {
        return fail('not_found_or_expired', recovery);
      }
      const vectorRow = this.readVectorRow(command.reservationId);
      if (!vectorRow) return fail('usage_mode_mismatch', recovery);
      const dimensions = parseStoredVectorDimensions(vectorRow.dimensions_json);

      const growthRow = this.ctx.storage.sql
        .exec<GrowthRow>(
          `SELECT growth_cursor, last_growth_json
           FROM reservation_growth WHERE reservation_id = ?`,
          command.reservationId,
        )
        .toArray()[0];
      if (!growthRow) return fail('growth_not_supported', recovery);
      const currentCursor = nonEmptyString(growthRow.growth_cursor, 'growth cursor');
      const lastGrowth = parseStoredVectorGrowth(vectorRow.last_vector_growth_json);

      if (lastGrowth?.incrementHash === command.incrementHash) {
        if (
          lastGrowth.expectedGrowthCursor !== command.expectedGrowthCursor ||
          lastGrowth.fingerprint !== command.fingerprint
        ) {
          return fail('growth_conflict', recovery);
        }
        return ok(vectorGrowthReplyFromStored(lastGrowth, true), recovery);
      }
      if (currentCursor !== command.expectedGrowthCursor) {
        return fail('growth_stale_cursor', recovery);
      }
      if (!sameVectorGrowthTopology(dimensions, command.dimensions)) {
        return fail('vector_dimension_mismatch', recovery);
      }

      const balances: Array<{
        dimensionId: string;
        budgetId: string;
        remaining: number;
      }> = [];
      let limiting:
        | { dimensionId: string; budgetId: string; remaining: number }
        | undefined;
      for (const dimension of command.dimensions) {
        for (const budget of dimension.budgets) {
          const usedRow = this.ctx.storage.sql
            .exec<UsedRow>('SELECT used FROM budgets WHERE id = ?', budget.id)
            .toArray()[0];
          const used = usedRow ? integer(usedRow.used, 'used') : 0;
          const remaining = Math.max(0, budget.limit - used);
          balances.push({ dimensionId: dimension.id, budgetId: budget.id, remaining });
          if (!limiting && dimension.additionalUnits > remaining) {
            limiting = { dimensionId: dimension.id, budgetId: budget.id, remaining };
          }
        }
      }

      if (limiting) {
        const stored: StoredVectorGrowthReplay = {
          incrementHash: command.incrementHash,
          expectedGrowthCursor: command.expectedGrowthCursor,
          fingerprint: command.fingerprint,
          nextGrowthCursor: command.nextGrowthCursor,
          accepted: false,
          limitingDimensionId: limiting.dimensionId,
          limitingBudgetId: limiting.budgetId,
          remaining: limiting.remaining,
        };
        this.ctx.storage.sql.exec(
          `UPDATE reservation_growth SET growth_cursor = ? WHERE reservation_id = ?`,
          command.nextGrowthCursor,
          command.reservationId,
        );
        this.ctx.storage.sql.exec(
          `UPDATE reservation_vectors SET last_vector_growth_json = ? WHERE reservation_id = ?`,
          JSON.stringify(stored),
          command.reservationId,
        );
        return ok(vectorGrowthReplyFromStored(stored, false), recovery);
      }

      const previousReservedByDimension = dimensions.map(dimension => ({
        id: dimension.id,
        reservedUnits: dimension.reservedUnits,
      }));
      const commandById = new Map(command.dimensions.map(dimension => [dimension.id, dimension] as const));
      const nextDimensions = dimensions.map(dimension => {
        const growth = commandById.get(dimension.id)!;
        for (const budget of growth.budgets) {
          if (growth.additionalUnits > 0) {
            this.ctx.storage.sql.exec(
              'UPDATE budgets SET used = used + ? WHERE id = ?',
              growth.additionalUnits,
              budget.id,
            );
          }
        }
        return {
          ...dimension,
          reservedUnits: safeAdd(
            dimension.reservedUnits,
            growth.additionalUnits,
            'vector reservedUnits',
          ),
        };
      });
      const reservedByDimension = nextDimensions.map(dimension => ({
        id: dimension.id,
        reservedUnits: dimension.reservedUnits,
      }));
      const stored: StoredVectorGrowthReplay = {
        incrementHash: command.incrementHash,
        expectedGrowthCursor: command.expectedGrowthCursor,
        fingerprint: command.fingerprint,
        nextGrowthCursor: command.nextGrowthCursor,
        accepted: true,
        previousReservedByDimension,
        reservedByDimension,
        remainingByBudget: balances.map(balance => ({
          ...balance,
          remaining:
            balance.remaining - (commandById.get(balance.dimensionId)?.additionalUnits ?? 0),
        })),
      };
      this.ctx.storage.sql.exec(
        `UPDATE reservation_growth SET growth_cursor = ? WHERE reservation_id = ?`,
        command.nextGrowthCursor,
        command.reservationId,
      );
      this.ctx.storage.sql.exec(
        `UPDATE reservation_vectors
         SET dimensions_json = ?, last_vector_growth_json = ?
         WHERE reservation_id = ?`,
        JSON.stringify(nextDimensions),
        JSON.stringify(stored),
        command.reservationId,
      );
      return ok(vectorGrowthReplyFromStored(stored, false), recovery);
    });
  }

  async markLiable(
    command: CloudflareMarkLiableCommand,
  ): Promise<CloudflareStoreEnvelope<{ expiresAt: number }>> {
    validateReservationId(command.reservationId);
    assertPositiveInteger(command.idempotencyTtlMs, 'idempotencyTtlMs');
    const now = Date.now();

    return this.ctx.storage.transactionSync(() => {
      const direct = this.recoverSpecific(command.reservationId, now, command.idempotencyTtlMs);
      const recovery = reportWithDirect(direct);
      if (direct) return fail('not_found_or_expired', recovery);

      const row = this.ctx.storage.sql
        .exec<StateRow>(
          `SELECT state, expires_at, reserved_units, actual_units, outcome_hash,
                  terminal_reason, budget_ids_json
           FROM reservations WHERE id = ?`,
          command.reservationId,
        )
        .toArray()[0];
      if (!row || row.state === 'settled') return fail('not_found_or_expired', recovery);

      const expiresAt = integer(row.expires_at, 'expiresAt');
      if (row.state === 'pending') {
        this.ctx.storage.sql.exec(
          `UPDATE reservations SET state = 'liable' WHERE id = ? AND state = 'pending'`,
          command.reservationId,
        );
      } else if (row.state !== 'liable') {
        return fail('not_found_or_expired', recovery);
      }

      return ok({ expiresAt }, recovery);
    });
  }

  async renew(
    command: CloudflareRenewCommand,
  ): Promise<CloudflareStoreEnvelope<{ expiresAt: number }>> {
    validateReservationId(command.reservationId);
    assertPositiveInteger(command.ttlMs, 'ttlMs');
    assertPositiveInteger(command.idempotencyTtlMs, 'idempotencyTtlMs');
    const now = Date.now();

    return this.ctx.storage.transactionSync(() => {
      const direct = this.recoverSpecific(command.reservationId, now, command.idempotencyTtlMs);
      const recovery = reportWithDirect(direct);
      if (direct) return fail('not_found_or_expired', recovery);

      const row = this.ctx.storage.sql
        .exec<StateRow>(
          `SELECT state, expires_at, reserved_units, actual_units, outcome_hash,
                  terminal_reason, budget_ids_json
           FROM reservations WHERE id = ?`,
          command.reservationId,
        )
        .toArray()[0];
      if (!row || (row.state !== 'pending' && row.state !== 'liable')) {
        return fail('not_found_or_expired', recovery);
      }

      const expiresAt = safeAdd(now, command.ttlMs, 'expiresAt');
      this.ctx.storage.sql.exec(
        `UPDATE reservations SET expires_at = ? WHERE id = ? AND state IN ('pending', 'liable')`,
        expiresAt,
        command.reservationId,
      );
      return ok({ expiresAt }, recovery);
    });
  }

  async settle(
    command: CloudflareSettleCommand,
  ): Promise<CloudflareStoreEnvelope<CloudflareSettlementReply>> {
    validateReservationId(command.reservationId);
    assertNonNegativeInteger(command.actualUnits, 'actualUnits');
    validateHash(command.outcomeHash, 'outcomeHash');
    assertPositiveInteger(command.idempotencyTtlMs, 'idempotencyTtlMs');
    const now = Date.now();

    return this.ctx.storage.transactionSync(() => {
      const direct = this.recoverSpecific(command.reservationId, now, command.idempotencyTtlMs);
      const recovery = reportWithDirect(direct);
      if (direct) return fail('not_found_or_expired', recovery);

      const row = this.ctx.storage.sql
        .exec<StateRow>(
          `SELECT state, expires_at, reserved_units, actual_units, outcome_hash,
                  terminal_reason, budget_ids_json
           FROM reservations WHERE id = ?`,
          command.reservationId,
        )
        .toArray()[0];
      if (!row) return fail('not_found_or_expired', recovery);
      if (this.readVectorRow(command.reservationId)) {
        return fail('usage_mode_mismatch', recovery);
      }

      const reservedUnits = integer(row.reserved_units, 'reservedUnits');
      if (row.state === 'settled') {
        if (row.terminal_reason === LEASE_EXPIRED_REASON) {
          return fail('not_found_or_expired', recovery);
        }
        const actualUnits = nullableInteger(row.actual_units, 'actualUnits');
        if (actualUnits === command.actualUnits && row.outcome_hash === command.outcomeHash) {
          return ok(
            {
              reservedUnits,
              actualUnits,
              releasedUnits: reservedUnits - actualUnits,
              replayed: true,
            },
            recovery,
          );
        }
        return fail('settlement_conflict', recovery);
      }

      if (row.state !== 'pending' && row.state !== 'liable') {
        return fail('not_found_or_expired', recovery);
      }
      if (command.actualUnits > reservedUnits) {
        return fail('actual_units_exceed_reserved', recovery);
      }

      const releasedUnits = reservedUnits - command.actualUnits;
      if (releasedUnits > 0) {
        for (const budgetId of parseBudgetIds(row.budget_ids_json)) {
          this.ctx.storage.sql.exec(
            'UPDATE budgets SET used = MAX(0, used - ?) WHERE id = ?',
            releasedUnits,
            budgetId,
          );
        }
      }

      const tombstoneExpiresAt = safeAdd(now, command.idempotencyTtlMs, 'tombstoneExpiresAt');
      this.ctx.storage.sql.exec(
        `UPDATE reservations
         SET state = 'settled', actual_units = ?, outcome_hash = ?, terminal_reason = NULL,
             tombstone_expires_at = ?
         WHERE id = ?`,
        command.actualUnits,
        command.outcomeHash,
        tombstoneExpiresAt,
        command.reservationId,
      );

      return ok(
        {
          reservedUnits,
          actualUnits: command.actualUnits,
          releasedUnits,
          replayed: false,
        },
        recovery,
      );
    });
  }

  async settleVector(
    command: CloudflareVectorSettleCommand,
  ): Promise<CloudflareStoreEnvelope<CloudflareVectorSettlementReply>> {
    validateVectorSettleCommand(command);
    const now = Date.now();

    return this.ctx.storage.transactionSync(() => {
      const direct = this.recoverSpecific(command.reservationId, now, command.idempotencyTtlMs);
      const recovery = reportWithDirect(direct);
      if (direct) return fail('not_found_or_expired', recovery);

      const row = this.ctx.storage.sql
        .exec<StateRow>(
          `SELECT state, expires_at, reserved_units, actual_units, outcome_hash,
                  terminal_reason, budget_ids_json
           FROM reservations WHERE id = ?`,
          command.reservationId,
        )
        .toArray()[0];
      if (!row) return fail('not_found_or_expired', recovery);
      const vectorRow = this.readVectorRow(command.reservationId);
      if (!vectorRow) return fail('usage_mode_mismatch', recovery);
      const dimensions = parseStoredVectorDimensions(vectorRow.dimensions_json);
      if (!sameVectorActualTopology(dimensions, command.actualByDimension)) {
        return fail('vector_dimension_mismatch', recovery);
      }

      const settlementReply = (replayed: boolean): CloudflareVectorSettlementReply => ({
        dimensions: dimensions.map((dimension, index) => {
          const actualUnits = command.actualByDimension[index]!.actualUnits;
          return {
            id: dimension.id,
            reservedUnits: dimension.reservedUnits,
            actualUnits,
            releasedUnits: dimension.reservedUnits - actualUnits,
          };
        }),
        replayed,
      });

      if (row.state === 'settled') {
        if (row.terminal_reason === LEASE_EXPIRED_REASON) {
          return fail('not_found_or_expired', recovery);
        }
        const storedActual = parseStoredVectorActuals(vectorRow.actual_dimensions_json);
        if (
          row.outcome_hash === command.outcomeHash &&
          sameVectorActuals(storedActual, command.actualByDimension)
        ) {
          return ok(settlementReply(true), recovery);
        }
        return fail('settlement_conflict', recovery);
      }
      if (row.state !== 'pending' && row.state !== 'liable') {
        return fail('not_found_or_expired', recovery);
      }

      for (let index = 0; index < dimensions.length; index += 1) {
        if (command.actualByDimension[index]!.actualUnits > dimensions[index]!.reservedUnits) {
          return fail('actual_units_exceed_reserved', recovery);
        }
      }
      for (let index = 0; index < dimensions.length; index += 1) {
        const dimension = dimensions[index]!;
        const actual = command.actualByDimension[index]!;
        const released = dimension.reservedUnits - actual.actualUnits;
        if (released > 0) {
          for (const budgetId of dimension.budgetIds) {
            this.ctx.storage.sql.exec(
              'UPDATE budgets SET used = MAX(0, used - ?) WHERE id = ?',
              released,
              budgetId,
            );
          }
        }
      }
      const tombstoneExpiresAt = safeAdd(now, command.idempotencyTtlMs, 'tombstoneExpiresAt');
      this.ctx.storage.sql.exec(
        `UPDATE reservations
         SET state = 'settled', actual_units = NULL, outcome_hash = ?, terminal_reason = NULL,
             tombstone_expires_at = ?
         WHERE id = ?`,
        command.outcomeHash,
        tombstoneExpiresAt,
        command.reservationId,
      );
      this.ctx.storage.sql.exec(
        `UPDATE reservation_vectors SET actual_dimensions_json = ? WHERE reservation_id = ?`,
        JSON.stringify(command.actualByDimension),
        command.reservationId,
      );
      return ok(settlementReply(false), recovery);
    });
  }

  private ensureSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS budgets (
        id TEXT PRIMARY KEY,
        used INTEGER NOT NULL CHECK (used >= 0)
      );
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS reservations (
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
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS reservation_growth (
        reservation_id TEXT PRIMARY KEY,
        growth_cursor TEXT NOT NULL,
        last_growth_json TEXT
      );
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS reservation_vectors (
        reservation_id TEXT PRIMARY KEY,
        dimensions_json TEXT NOT NULL,
        actual_dimensions_json TEXT,
        last_vector_growth_json TEXT
      );
    `);
    this.ctx.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS reservations_active_expiry
       ON reservations(state, expires_at)`,
    );
    this.ctx.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS reservations_tombstone_expiry
       ON reservations(state, tombstone_expires_at)`,
    );
  }

  private readVectorRow(reservationId: string): VectorRow | undefined {
    return this.ctx.storage.sql
      .exec<VectorRow>(
        `SELECT dimensions_json, actual_dimensions_json, last_vector_growth_json
         FROM reservation_vectors WHERE reservation_id = ?`,
        reservationId,
      )
      .toArray()[0];
  }

  private recoverExpiredBatch(
    now: number,
    cleanupBatchSize: number,
    idempotencyTtlMs: number,
  ): CloudflareRecoveryReport {
    const aggregate = emptySummary();
    const rows = this.ctx.storage.sql
      .exec<ReservationRow>(
        `SELECT id, state, reserved_units, expires_at, actual_units, outcome_hash,
                terminal_reason, tombstone_expires_at, budget_ids_json
         FROM reservations
         WHERE state IN ('pending', 'liable') AND expires_at <= ?
         ORDER BY expires_at, id
         LIMIT ?`,
        now,
        cleanupBatchSize,
      )
      .toArray();

    for (const row of rows) {
      const recovered = this.recoverRow(row, now, idempotencyTtlMs);
      if ('vector' in recovered) {
        if (recovered.state === 'pending') {
          aggregate.vectorPendingCount = safeAdd(
            aggregate.vectorPendingCount ?? 0,
            1,
            'vectorPendingCount',
          );
        } else {
          aggregate.vectorLiableCount = safeAdd(
            aggregate.vectorLiableCount ?? 0,
            1,
            'vectorLiableCount',
          );
        }
      } else if (recovered.state === 'pending') {
        aggregate.pendingCount = safeAdd(aggregate.pendingCount, 1, 'pendingCount');
        aggregate.pendingUnits = safeAdd(
          aggregate.pendingUnits,
          recovered.reservedUnits,
          'pendingUnits',
        );
      } else {
        aggregate.liableCount = safeAdd(aggregate.liableCount, 1, 'liableCount');
        aggregate.liableUnits = safeAdd(
          aggregate.liableUnits,
          recovered.reservedUnits,
          'liableUnits',
        );
      }
    }

    this.ctx.storage.sql.exec(
      `DELETE FROM reservation_vectors
       WHERE reservation_id IN (
         SELECT id FROM reservations
         WHERE state = 'settled' AND tombstone_expires_at IS NOT NULL
           AND tombstone_expires_at <= ?
         ORDER BY tombstone_expires_at, id
         LIMIT ?
       )`,
      now,
      cleanupBatchSize,
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM reservation_growth
       WHERE reservation_id IN (
         SELECT id FROM reservations
         WHERE state = 'settled' AND tombstone_expires_at IS NOT NULL
           AND tombstone_expires_at <= ?
         ORDER BY tombstone_expires_at, id
         LIMIT ?
       )`,
      now,
      cleanupBatchSize,
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM reservations
       WHERE id IN (
         SELECT id FROM reservations
         WHERE state = 'settled' AND tombstone_expires_at IS NOT NULL
           AND tombstone_expires_at <= ?
         ORDER BY tombstone_expires_at, id
         LIMIT ?
       )`,
      now,
      cleanupBatchSize,
    );

    return { aggregate };
  }

  private recoverSpecific(
    reservationId: string,
    now: number,
    idempotencyTtlMs: number,
  ): CloudflareDirectRecovery | undefined {
    const row = this.ctx.storage.sql
      .exec<ReservationRow>(
        `SELECT id, state, reserved_units, expires_at, actual_units, outcome_hash,
                terminal_reason, tombstone_expires_at, budget_ids_json
         FROM reservations
         WHERE id = ? AND state IN ('pending', 'liable')`,
        reservationId,
      )
      .toArray()[0];
    if (!row || integer(row.expires_at, 'expiresAt') > now) return undefined;
    return this.recoverRow(row, now, idempotencyTtlMs);
  }

  private recoverRow(
    row: ReservationRow,
    now: number,
    idempotencyTtlMs: number,
  ): CloudflareDirectRecovery {
    const reservationId = String(row.id);
    validateReservationId(reservationId);
    const vectorRow = this.readVectorRow(reservationId);

    if (vectorRow) {
      const dimensions = parseStoredVectorDimensions(vectorRow.dimensions_json);
      const dimensionCount = dimensions.length;
      const budgetCount = dimensions.reduce((count, dimension) => count + dimension.budgetIds.length, 0);
      if (row.state === 'pending') {
        for (const dimension of dimensions) {
          for (const budgetId of dimension.budgetIds) {
            this.ctx.storage.sql.exec(
              'UPDATE budgets SET used = MAX(0, used - ?) WHERE id = ?',
              dimension.reservedUnits,
              budgetId,
            );
          }
        }
        this.ctx.storage.sql.exec(
          'DELETE FROM reservation_growth WHERE reservation_id = ?',
          reservationId,
        );
        this.ctx.storage.sql.exec(
          'DELETE FROM reservation_vectors WHERE reservation_id = ?',
          reservationId,
        );
        this.ctx.storage.sql.exec('DELETE FROM reservations WHERE id = ?', reservationId);
        return {
          reservationId,
          state: 'pending',
          vector: true,
          dimensionCount,
          budgetCount,
        };
      }
      if (row.state !== 'liable') throw new Error('Invalid active vector reservation state');
      const tombstoneExpiresAt = safeAdd(now, idempotencyTtlMs, 'tombstoneExpiresAt');
      const actuals = dimensions.map(dimension => ({
        id: dimension.id,
        actualUnits: dimension.reservedUnits,
      }));
      this.ctx.storage.sql.exec(
        `UPDATE reservations
         SET state = 'settled', actual_units = NULL, outcome_hash = NULL,
             terminal_reason = ?, tombstone_expires_at = ?
         WHERE id = ?`,
        LEASE_EXPIRED_REASON,
        tombstoneExpiresAt,
        reservationId,
      );
      this.ctx.storage.sql.exec(
        'UPDATE reservation_vectors SET actual_dimensions_json = ? WHERE reservation_id = ?',
        JSON.stringify(actuals),
        reservationId,
      );
      return {
        reservationId,
        state: 'liable',
        vector: true,
        dimensionCount,
        budgetCount,
      };
    }

    const reservedUnits = integer(row.reserved_units, 'reservedUnits');
    const budgetIds = parseBudgetIds(row.budget_ids_json);
    if (row.state === 'pending') {
      for (const budgetId of budgetIds) {
        this.ctx.storage.sql.exec(
          'UPDATE budgets SET used = MAX(0, used - ?) WHERE id = ?',
          reservedUnits,
          budgetId,
        );
      }
      this.ctx.storage.sql.exec(
        'DELETE FROM reservation_growth WHERE reservation_id = ?',
        reservationId,
      );
      this.ctx.storage.sql.exec('DELETE FROM reservations WHERE id = ?', reservationId);
      return { reservationId, state: 'pending', reservedUnits };
    }

    if (row.state !== 'liable') throw new Error('Invalid active reservation state');
    const tombstoneExpiresAt = safeAdd(now, idempotencyTtlMs, 'tombstoneExpiresAt');
    this.ctx.storage.sql.exec(
      `UPDATE reservations
       SET state = 'settled', actual_units = reserved_units, outcome_hash = NULL,
           terminal_reason = ?, tombstone_expires_at = ?
       WHERE id = ?`,
      LEASE_EXPIRED_REASON,
      tombstoneExpiresAt,
      reservationId,
    );
    return { reservationId, state: 'liable', reservedUnits };
  }
}

function validateVectorReserveCommand(command: CloudflareVectorReserveCommand): void {
  validateReservationId(command.reservationId);
  assertPositiveInteger(command.ttlMs, 'ttlMs');
  assertPositiveInteger(command.cleanupBatchSize, 'cleanupBatchSize');
  assertPositiveInteger(command.idempotencyTtlMs, 'idempotencyTtlMs');
  nonEmptyString(command.initialGrowthCursor, 'initialGrowthCursor');
  validateHashedDimensions(command.dimensions, 'reserve');
}

function validateVectorGrowCommand(command: CloudflareVectorGrowCommand): void {
  validateReservationId(command.reservationId);
  validateHash(command.incrementHash, 'incrementHash');
  nonEmptyString(command.expectedGrowthCursor, 'expectedGrowthCursor');
  validateHash(command.fingerprint, 'fingerprint');
  nonEmptyString(command.nextGrowthCursor, 'nextGrowthCursor');
  assertPositiveInteger(command.idempotencyTtlMs, 'idempotencyTtlMs');
  validateHashedDimensions(command.dimensions, 'growth');
  if (!command.dimensions.some(dimension => dimension.additionalUnits > 0)) {
    throw new RangeError('vector growth must add units to at least one dimension');
  }
}

function validateVectorSettleCommand(command: CloudflareVectorSettleCommand): void {
  validateReservationId(command.reservationId);
  validateHash(command.outcomeHash, 'outcomeHash');
  assertPositiveInteger(command.idempotencyTtlMs, 'idempotencyTtlMs');
  if (!Array.isArray(command.actualByDimension) || command.actualByDimension.length === 0) {
    throw new RangeError('actualByDimension must contain at least one dimension');
  }
  const seen = new Set<string>();
  for (const dimension of command.actualByDimension) {
    validateHash(dimension.id, 'dimension.id');
    assertNonNegativeInteger(dimension.actualUnits, 'actualUnits');
    if (seen.has(dimension.id)) throw new RangeError('duplicate dimension id');
    seen.add(dimension.id);
  }
}

function validateHashedDimensions(
  dimensions: readonly (
    | CloudflareVectorReserveCommand['dimensions'][number]
    | CloudflareVectorGrowCommand['dimensions'][number]
  )[],
  mode: 'reserve' | 'growth',
): void {
  if (!Array.isArray(dimensions) || dimensions.length === 0) {
    throw new RangeError('dimensions must contain at least one dimension');
  }
  const dimensionIds = new Set<string>();
  const budgetIds = new Set<string>();
  for (const dimension of dimensions) {
    validateHash(dimension.id, 'dimension.id');
    if (dimensionIds.has(dimension.id)) throw new RangeError('duplicate dimension id');
    dimensionIds.add(dimension.id);
    const units = mode === 'reserve' ? ('units' in dimension ? dimension.units : -1) : ('additionalUnits' in dimension ? dimension.additionalUnits : -1);
    assertNonNegativeInteger(units, mode === 'reserve' ? 'dimension.units' : 'dimension.additionalUnits');
    if (!Array.isArray(dimension.budgets) || dimension.budgets.length === 0) {
      throw new RangeError('dimension budgets must contain at least one budget');
    }
    for (const budget of dimension.budgets) {
      validateHash(budget.id, 'budget.id');
      assertNonNegativeInteger(budget.limit, 'budget.limit');
      if (budgetIds.has(budget.id)) throw new RangeError('budget id cannot appear in multiple vector dimensions');
      budgetIds.add(budget.id);
    }
  }
}

function parseStoredVectorDimensions(raw: SqlStorageValue): StoredVectorDimension[] {
  if (typeof raw !== 'string') throw new Error('Invalid stored vector dimensions');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Invalid stored vector dimensions');
  }
  if (!Array.isArray(value) || value.length === 0) throw new Error('Invalid stored vector dimensions');
  const dimensionIds = new Set<string>();
  const budgetIds = new Set<string>();
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('Invalid stored vector dimension');
    }
    const data = item as Record<string, unknown>;
    if (typeof data.id !== 'string' || !HASH_PATTERN.test(data.id)) {
      throw new Error('Invalid stored vector dimension id');
    }
    if (dimensionIds.has(data.id)) throw new Error('Duplicate stored vector dimension id');
    dimensionIds.add(data.id);
    if (
      !Array.isArray(data.budgetIds) ||
      data.budgetIds.length === 0 ||
      !data.budgetIds.every(id => typeof id === 'string' && HASH_PATTERN.test(id))
    ) {
      throw new Error('Invalid stored vector budget ids');
    }
    for (const id of data.budgetIds as string[]) {
      if (budgetIds.has(id)) throw new Error('Stored budget appeared in multiple vector dimensions');
      budgetIds.add(id);
    }
    return {
      id: data.id,
      reservedUnits: storedNonNegativeInteger(data.reservedUnits, 'vector reservedUnits'),
      budgetIds: [...(data.budgetIds as string[])],
    };
  });
}

function parseStoredVectorActuals(
  raw: SqlStorageValue,
): Array<{ id: string; actualUnits: number }> | undefined {
  if (raw === null) return undefined;
  if (typeof raw !== 'string') throw new Error('Invalid stored vector actuals');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Invalid stored vector actuals');
  }
  if (!Array.isArray(value) || value.length === 0) throw new Error('Invalid stored vector actuals');
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('Invalid stored vector actual');
    }
    const data = item as Record<string, unknown>;
    if (typeof data.id !== 'string' || !HASH_PATTERN.test(data.id)) {
      throw new Error('Invalid stored vector actual dimension id');
    }
    return { id: data.id, actualUnits: storedNonNegativeInteger(data.actualUnits, 'vector actualUnits') };
  });
}

function parseStoredVectorGrowth(raw: SqlStorageValue): StoredVectorGrowthReplay | undefined {
  if (raw === null) return undefined;
  if (typeof raw !== 'string') throw new Error('Invalid stored vector growth replay');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Invalid stored vector growth replay');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid stored vector growth replay');
  }
  const data = value as Record<string, unknown>;
  if (typeof data.incrementHash !== 'string' || !HASH_PATTERN.test(data.incrementHash)) {
    throw new Error('Invalid stored vector growth increment');
  }
  if (typeof data.fingerprint !== 'string' || !HASH_PATTERN.test(data.fingerprint)) {
    throw new Error('Invalid stored vector growth fingerprint');
  }
  const result: StoredVectorGrowthReplay = {
    incrementHash: data.incrementHash,
    expectedGrowthCursor: nonEmptyString(data.expectedGrowthCursor as SqlStorageValue, 'vector growth prior cursor'),
    fingerprint: data.fingerprint,
    nextGrowthCursor: nonEmptyString(data.nextGrowthCursor as SqlStorageValue, 'vector growth next cursor'),
    accepted: data.accepted === true,
  };
  if (typeof data.accepted !== 'boolean') throw new Error('Invalid stored vector growth accepted state');
  if (data.accepted) {
    result.previousReservedByDimension = parseStoredReservedVector(data.previousReservedByDimension);
    result.reservedByDimension = parseStoredReservedVector(data.reservedByDimension);
    if (!Array.isArray(data.remainingByBudget)) throw new Error('Invalid stored vector growth balances');
    result.remainingByBudget = data.remainingByBudget.map(item => parseStoredVectorBalance(item));
  } else {
    if (typeof data.limitingDimensionId !== 'string' || !HASH_PATTERN.test(data.limitingDimensionId)) {
      throw new Error('Invalid stored vector growth limiting dimension');
    }
    if (typeof data.limitingBudgetId !== 'string' || !HASH_PATTERN.test(data.limitingBudgetId)) {
      throw new Error('Invalid stored vector growth limiting budget');
    }
    result.limitingDimensionId = data.limitingDimensionId;
    result.limitingBudgetId = data.limitingBudgetId;
    result.remaining = storedNonNegativeInteger(data.remaining, 'vector growth remaining');
  }
  return result;
}

function parseStoredReservedVector(value: unknown): Array<{ id: string; reservedUnits: number }> {
  if (!Array.isArray(value) || value.length === 0) throw new Error('Invalid stored vector reserved values');
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid stored vector reserved value');
    const data = item as Record<string, unknown>;
    if (typeof data.id !== 'string' || !HASH_PATTERN.test(data.id)) throw new Error('Invalid stored vector dimension id');
    return { id: data.id, reservedUnits: storedNonNegativeInteger(data.reservedUnits, 'vector reservedUnits') };
  });
}

function parseStoredVectorBalance(value: unknown): { dimensionId: string; budgetId: string; remaining: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid stored vector balance');
  const data = value as Record<string, unknown>;
  if (typeof data.dimensionId !== 'string' || !HASH_PATTERN.test(data.dimensionId)) throw new Error('Invalid stored vector balance dimension');
  if (typeof data.budgetId !== 'string' || !HASH_PATTERN.test(data.budgetId)) throw new Error('Invalid stored vector balance budget');
  return {
    dimensionId: data.dimensionId,
    budgetId: data.budgetId,
    remaining: storedNonNegativeInteger(data.remaining, 'vector balance remaining'),
  };
}

function vectorGrowthReplyFromStored(
  growth: StoredVectorGrowthReplay,
  replayed: boolean,
): CloudflareVectorGrowReply {
  if (growth.accepted) {
    if (!growth.previousReservedByDimension || !growth.reservedByDimension || !growth.remainingByBudget) {
      throw new Error('Incomplete stored accepted vector growth replay');
    }
    return {
      accepted: true,
      replayed,
      previousReservedByDimension: growth.previousReservedByDimension.map(item => ({ ...item })),
      reservedByDimension: growth.reservedByDimension.map(item => ({ ...item })),
      growthCursor: growth.nextGrowthCursor,
      remainingByBudget: growth.remainingByBudget.map(item => ({ ...item })),
    };
  }
  if (!growth.limitingDimensionId || !growth.limitingBudgetId || growth.remaining === undefined) {
    throw new Error('Incomplete stored denied vector growth replay');
  }
  return {
    accepted: false,
    reason: 'quota_exceeded',
    replayed,
    growthCursor: growth.nextGrowthCursor,
    limitingDimensionId: growth.limitingDimensionId,
    limitingBudgetId: growth.limitingBudgetId,
    remaining: growth.remaining,
  };
}

function sameVectorGrowthTopology(
  stored: readonly StoredVectorDimension[],
  current: readonly CloudflareVectorGrowCommand['dimensions'][number][],
): boolean {
  return (
    stored.length === current.length &&
    stored.every((dimension, index) => {
      const candidate = current[index];
      return !!candidate && dimension.id === candidate.id && sameStrings(dimension.budgetIds, candidate.budgets.map(budget => budget.id));
    })
  );
}

function sameVectorActualTopology(
  stored: readonly StoredVectorDimension[],
  current: readonly CloudflareVectorActualDimension[],
): boolean {
  return stored.length === current.length && stored.every((dimension, index) => dimension.id === current[index]?.id);
}

function sameVectorActuals(
  stored: readonly { id: string; actualUnits: number }[] | undefined,
  current: readonly CloudflareVectorActualDimension[],
): boolean {
  return !!stored && stored.length === current.length && stored.every((value, index) => value.id === current[index]?.id && value.actualUnits === current[index]?.actualUnits);
}

function validateReserveCommand(command: CloudflareReserveCommand): void {
  validateReservationId(command.reservationId);
  assertNonNegativeInteger(command.units, 'units');
  assertPositiveInteger(command.ttlMs, 'ttlMs');
  assertPositiveInteger(command.cleanupBatchSize, 'cleanupBatchSize');
  assertPositiveInteger(command.idempotencyTtlMs, 'idempotencyTtlMs');
  nonEmptyString(command.initialGrowthCursor, 'initialGrowthCursor');
  if (!Array.isArray(command.budgets) || command.budgets.length === 0) {
    throw new RangeError('budgets must contain at least one budget');
  }
  const seen = new Set<string>();
  for (const budget of command.budgets) {
    validateHash(budget.id, 'budget.id');
    assertNonNegativeInteger(budget.limit, 'budget.limit');
    if (seen.has(budget.id)) throw new RangeError('duplicate budget id');
    seen.add(budget.id);
  }
}

function validateGrowCommand(command: CloudflareGrowCommand): void {
  validateReservationId(command.reservationId);
  validateHash(command.incrementHash, 'incrementHash');
  nonEmptyString(command.expectedGrowthCursor, 'expectedGrowthCursor');
  assertPositiveInteger(command.additionalUnits, 'additionalUnits');
  validateHash(command.fingerprint, 'fingerprint');
  nonEmptyString(command.nextGrowthCursor, 'nextGrowthCursor');
  assertPositiveInteger(command.idempotencyTtlMs, 'idempotencyTtlMs');
  if (!Array.isArray(command.budgets) || command.budgets.length === 0) {
    throw new RangeError('budgets must contain at least one budget');
  }
  const seen = new Set<string>();
  for (const budget of command.budgets) {
    validateHash(budget.id, 'budget.id');
    assertNonNegativeInteger(budget.limit, 'budget.limit');
    if (seen.has(budget.id)) throw new RangeError('duplicate budget id');
    seen.add(budget.id);
  }
}

function nonEmptyString(value: SqlStorageValue | string, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid ${name}`);
  return value;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function parseStoredGrowth(raw: SqlStorageValue): StoredGrowthReplay | undefined {
  if (raw === null) return undefined;
  if (typeof raw !== 'string') throw new Error('Invalid stored growth replay');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Invalid stored growth replay');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid stored growth replay');
  }
  const data = value as Record<string, unknown>;
  for (const field of ['incrementHash', 'fingerprint'] as const) {
    if (typeof data[field] !== 'string' || !HASH_PATTERN.test(data[field])) {
      throw new Error(`Invalid stored growth ${field}`);
    }
  }
  const expectedGrowthCursor = nonEmptyString(data.expectedGrowthCursor as SqlStorageValue, 'growth prior cursor');
  const nextGrowthCursor = nonEmptyString(data.nextGrowthCursor as SqlStorageValue, 'growth next cursor');
  if (typeof data.accepted !== 'boolean') throw new Error('Invalid stored growth accepted state');
  const result: StoredGrowthReplay = {
    incrementHash: data.incrementHash as string,
    expectedGrowthCursor,
    fingerprint: data.fingerprint as string,
    nextGrowthCursor,
    accepted: data.accepted,
  };
  if (data.accepted) {
    result.previousReservedUnits = storedNonNegativeInteger(data.previousReservedUnits, 'growth previousReservedUnits');
    result.reservedUnits = storedNonNegativeInteger(data.reservedUnits, 'growth reservedUnits');
    if (!Array.isArray(data.remainingByBudget) || data.remainingByBudget.length === 0) {
      throw new Error('Invalid stored growth balances');
    }
    result.remainingByBudget = data.remainingByBudget.map(entry => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error('Invalid stored growth balance');
      }
      const balance = entry as Record<string, unknown>;
      if (typeof balance.id !== 'string' || !HASH_PATTERN.test(balance.id)) {
        throw new Error('Invalid stored growth budget id');
      }
      return {
        id: balance.id,
        remaining: storedNonNegativeInteger(balance.remaining, 'growth remaining'),
      };
    });
  } else {
    if (typeof data.limitingBudgetId !== 'string' || !HASH_PATTERN.test(data.limitingBudgetId)) {
      throw new Error('Invalid stored growth limiting budget id');
    }
    result.limitingBudgetId = data.limitingBudgetId;
    result.remaining = storedNonNegativeInteger(data.remaining, 'growth remaining');
  }
  return result;
}

function growthReplyFromStored(
  growth: StoredGrowthReplay,
  replayed: boolean,
): CloudflareGrowReply {
  if (growth.accepted) {
    if (
      growth.previousReservedUnits === undefined ||
      growth.reservedUnits === undefined ||
      growth.remainingByBudget === undefined
    ) {
      throw new Error('Incomplete stored accepted growth replay');
    }
    return {
      accepted: true,
      replayed,
      previousReservedUnits: growth.previousReservedUnits,
      reservedUnits: growth.reservedUnits,
      growthCursor: growth.nextGrowthCursor,
      remainingByBudget: growth.remainingByBudget.map(balance => ({ ...balance })),
    };
  }
  if (growth.limitingBudgetId === undefined || growth.remaining === undefined) {
    throw new Error('Incomplete stored denied growth replay');
  }
  return {
    accepted: false,
    reason: 'quota_exceeded',
    replayed,
    growthCursor: growth.nextGrowthCursor,
    limitingBudgetId: growth.limitingBudgetId,
    remaining: growth.remaining,
  };
}

function storedNonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid stored ${name}`);
  }
  return value;
}

function validateReservationId(value: string): void {
  if (!RESERVATION_ID_PATTERN.test(value)) throw new RangeError('invalid reservationId');
}

function validateHash(value: string, name: string): void {
  if (!HASH_PATTERN.test(value)) throw new RangeError(`${name} must be a SHA-256 hex digest`);
}

function parseBudgetIds(raw: SqlStorageValue): string[] {
  if (typeof raw !== 'string') throw new Error('Invalid stored budget list');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Invalid stored budget list');
  }
  if (!Array.isArray(value) || value.length === 0 || !value.every(id => typeof id === 'string' && HASH_PATTERN.test(id))) {
    throw new Error('Invalid stored budget list');
  }
  return value;
}

function integer(value: SqlStorageValue, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`Invalid stored ${name}`);
  }
  return value;
}

function nullableInteger(value: SqlStorageValue, name: string): number {
  if (value === null) throw new Error(`Invalid stored ${name}`);
  return integer(value, name);
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function safeAdd(left: number, right: number, name: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) throw new RangeError(`${name} overflowed`);
  return result;
}

function emptySummary(): CloudflareRecoverySummary {
  return {
    pendingCount: 0,
    pendingUnits: 0,
    liableCount: 0,
    liableUnits: 0,
    vectorPendingCount: 0,
    vectorLiableCount: 0,
  };
}

function reportWithDirect(direct?: CloudflareDirectRecovery): CloudflareRecoveryReport {
  return direct ? { aggregate: emptySummary(), direct } : { aggregate: emptySummary() };
}

function ok<T>(result: T, recovery: CloudflareRecoveryReport): CloudflareStoreEnvelope<T> {
  return { ok: true, result, recovery };
}

function fail<T = never>(
  error: CloudflareStoreErrorCode,
  recovery: CloudflareRecoveryReport,
): CloudflareStoreEnvelope<T> {
  return { ok: false, error, recovery };
}
