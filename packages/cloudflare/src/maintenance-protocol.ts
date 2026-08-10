import type { DurableObjectStorage, SqlStorageValue } from 'cloudflare:workers';

const HASH_PATTERN = /^[a-f0-9]{64}$/;
export const MAX_CLOUDFLARE_PRUNE_BUDGETS = 64;

export interface CloudflarePruneBudgetsCommand {
  candidateBudgetIds: readonly string[];
  protectedBudgetIds: readonly string[];
}

export interface CloudflarePruneBudgetsReply {
  prunedIds: string[];
  blockedProtectedIds: string[];
  blockedActiveIds: string[];
  missingIds: string[];
}

type IdRow = Record<string, SqlStorageValue> & { id: string };
type ExistsRow = Record<string, SqlStorageValue> & { found: number };

/**
 * Explicit operator/application-controlled historical budget pruning.
 *
 * Candidates and protected/current budgets are already opaque hashes. The
 * operation is bounded and transactional. It never deletes a budget referenced
 * by a pending/liable reservation, including an expired row that has not yet
 * gone through normal reservation recovery.
 */
export function pruneCloudflareBudgets(
  storage: DurableObjectStorage,
  command: CloudflarePruneBudgetsCommand,
): CloudflarePruneBudgetsReply {
  validateIds(command.candidateBudgetIds, 'candidateBudgetIds', true);
  validateIds(command.protectedBudgetIds, 'protectedBudgetIds', false);

  const protectedIds = new Set(command.protectedBudgetIds);

  return storage.transactionSync(() => {
    const reply: CloudflarePruneBudgetsReply = {
      prunedIds: [],
      blockedProtectedIds: [],
      blockedActiveIds: [],
      missingIds: [],
    };

    for (const budgetId of command.candidateBudgetIds) {
      if (protectedIds.has(budgetId)) {
        reply.blockedProtectedIds.push(budgetId);
        continue;
      }

      const exists = storage.sql
        .exec<IdRow>('SELECT id FROM budgets WHERE id = ?', budgetId)
        .toArray()[0];
      if (!exists) {
        reply.missingIds.push(budgetId);
        continue;
      }

      const activeReference = storage.sql
        .exec<ExistsRow>(
          `SELECT 1 AS found
           FROM reservations
           WHERE state IN ('pending', 'liable')
             AND instr(budget_ids_json, ?) > 0
           LIMIT 1`,
          `\"${budgetId}\"`,
        )
        .toArray()[0];
      if (activeReference) {
        reply.blockedActiveIds.push(budgetId);
        continue;
      }

      storage.sql.exec('DELETE FROM budgets WHERE id = ?', budgetId);
      reply.prunedIds.push(budgetId);
    }

    return reply;
  });
}

function validateIds(ids: readonly string[], name: string, requireOne: boolean): void {
  if (!Array.isArray(ids)) throw new RangeError(`${name} must be an array`);
  if (requireOne && ids.length === 0) throw new RangeError(`${name} must not be empty`);
  if (ids.length > MAX_CLOUDFLARE_PRUNE_BUDGETS) {
    throw new RangeError(`${name} must contain at most ${MAX_CLOUDFLARE_PRUNE_BUDGETS} entries`);
  }
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== 'string' || !HASH_PATTERN.test(id)) {
      throw new RangeError(`${name} entries must be SHA-256 hex digests`);
    }
    if (seen.has(id)) throw new RangeError(`${name} must not contain duplicates`);
    seen.add(id);
  }
}
