import { UsageStateError, type UsageEventMetadata, type UsageLeaseResumeState } from 'mcp-usage-control';
import type { McpUsageFlowBinding, McpUsageFlowRecord } from 'mcp-usage-control-mcp';

const FLOW_ID_PATTERN = /^[A-Za-z0-9._~-]{16,128}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

export function validateFlowRecord(record: McpUsageFlowRecord): void {
  if (!isRecord(record)) throw new UsageStateError('MCP usage flow record must be an object');
  validateFlowId(record.flowId);
  validateBinding(record.binding);
  if (!Number.isSafeInteger(record.round) || record.round <= 0) {
    throw new UsageStateError('MCP usage flow round must be a positive safe integer');
  }
  if (!Number.isSafeInteger(record.expiresAt) || record.expiresAt <= 0) {
    throw new UsageStateError('MCP usage flow expiry must be a positive safe integer');
  }
  validateLeaseResumeState(record.lease);
  if (record.lease.reservation.expiresAt !== record.expiresAt) {
    throw new UsageStateError('MCP usage flow and lease expiry must match');
  }
  if (
    record.lease.reservation.principalId !== record.binding.principalId ||
    record.lease.reservation.tenantId !== record.binding.tenantId ||
    record.lease.reservation.tool !== record.binding.tool
  ) {
    throw new UsageStateError('MCP usage flow binding must match the resumable lease identity');
  }
  if (
    record.applicationRequestState !== undefined &&
    (typeof record.applicationRequestState !== 'string' ||
      record.applicationRequestState.length === 0 ||
      record.applicationRequestState.length > 16_384)
  ) {
    throw new UsageStateError('Application requestState must be a non-empty bounded string');
  }
}

export function validateBinding(binding: McpUsageFlowBinding): void {
  if (!isRecord(binding)) throw new UsageStateError('MCP usage flow binding must be an object');
  if (typeof binding.principalId !== 'string' || binding.principalId.length === 0) {
    throw new UsageStateError('MCP usage flow principalId must be non-empty');
  }
  if (binding.tenantId !== undefined && typeof binding.tenantId !== 'string') {
    throw new UsageStateError('MCP usage flow tenantId must be a string when present');
  }
  if (typeof binding.tool !== 'string' || binding.tool.length === 0) {
    throw new UsageStateError('MCP usage flow tool must be non-empty');
  }
  if (typeof binding.argsHash !== 'string' || !HASH_PATTERN.test(binding.argsHash)) {
    throw new UsageStateError('MCP usage flow argsHash must be SHA-256 hex');
  }
}

function validateLeaseResumeState(state: UsageLeaseResumeState): void {
  if (!isRecord(state)) throw new UsageStateError('MCP usage lease resume state must be an object');
  if (!Number.isSafeInteger(state.ttlMs) || state.ttlMs <= 0) {
    throw new UsageStateError('MCP usage lease ttlMs must be a positive safe integer');
  }
  const reservation = state.reservation;
  if (!isRecord(reservation)) throw new UsageStateError('MCP usage resume reservation must be an object');
  for (const [name, value] of [
    ['id', reservation.id],
    ['operationId', reservation.operationId],
    ['principalId', reservation.principalId],
    ['tool', reservation.tool],
  ] as const) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new UsageStateError(`MCP usage resume reservation ${name} must be non-empty`);
    }
  }
  if (reservation.tenantId !== undefined && typeof reservation.tenantId !== 'string') {
    throw new UsageStateError('MCP usage resume reservation tenantId must be a string when present');
  }
  if (reservation.plan !== undefined && typeof reservation.plan !== 'string') {
    throw new UsageStateError('MCP usage resume reservation plan must be a string when present');
  }
  if (
    !Array.isArray(reservation.budgetKeys) ||
    reservation.budgetKeys.length === 0 ||
    reservation.budgetKeys.some(key => typeof key !== 'string' || key.length === 0)
  ) {
    throw new UsageStateError('MCP usage resume reservation must contain non-empty budget keys');
  }
  if (!Number.isSafeInteger(reservation.reservedUnits) || reservation.reservedUnits < 0) {
    throw new UsageStateError('MCP usage resume reservation reservedUnits must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(reservation.expiresAt) || reservation.expiresAt <= 0) {
    throw new UsageStateError('MCP usage resume reservation expiresAt must be a positive safe integer');
  }
  if (state.metadata !== undefined) validateMetadata(state.metadata);
  if (state.unresolvedGrowth !== undefined) validateUnresolvedGrowth(state.unresolvedGrowth);
}

function validateUnresolvedGrowth(value: unknown): void {
  if (!isRecord(value)) {
    throw new UsageStateError('MCP usage unresolved growth must be an object');
  }
  if (typeof value.incrementId !== 'string' || value.incrementId.length === 0) {
    throw new UsageStateError('MCP usage unresolved growth incrementId must be non-empty');
  }
  if (!Number.isSafeInteger(value.additionalUnits) || (value.additionalUnits as number) <= 0) {
    throw new UsageStateError('MCP usage unresolved growth additionalUnits must be a positive safe integer');
  }
  if (!Array.isArray(value.budgets) || value.budgets.length === 0) {
    throw new UsageStateError('MCP usage unresolved growth must contain budgets');
  }
  let previousKey: string | undefined;
  for (const budget of value.budgets) {
    if (!isRecord(budget) || typeof budget.key !== 'string' || budget.key.length === 0) {
      throw new UsageStateError('MCP usage unresolved growth budget key must be non-empty');
    }
    if (!Number.isSafeInteger(budget.limit) || (budget.limit as number) < 0) {
      throw new UsageStateError('MCP usage unresolved growth budget limit must be a non-negative safe integer');
    }
    if (previousKey !== undefined && previousKey.localeCompare(budget.key) >= 0) {
      throw new UsageStateError('MCP usage unresolved growth budgets must be canonical and unique');
    }
    previousKey = budget.key;
  }
}

function validateMetadata(metadata: UsageEventMetadata): void {
  if (!isRecord(metadata)) throw new UsageStateError('MCP usage resume metadata must be an object');
  for (const value of Object.values(metadata)) {
    if (
      value !== null &&
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean'
    ) {
      throw new UsageStateError('MCP usage resume metadata contains an unsupported value');
    }
  }
}

export function validateFlowId(flowId: string): void {
  if (typeof flowId !== 'string' || !FLOW_ID_PATTERN.test(flowId)) {
    throw new UsageStateError('MCP usage flow ID must be 16-128 URL-safe characters');
  }
}

export function sameBinding(left: McpUsageFlowBinding, right: McpUsageFlowBinding): boolean {
  return (
    left.principalId === right.principalId &&
    left.tenantId === right.tenantId &&
    left.tool === right.tool &&
    left.argsHash === right.argsHash
  );
}

export function cloneFlowRecord(record: McpUsageFlowRecord): McpUsageFlowRecord {
  return {
    flowId: record.flowId,
    binding: { ...record.binding },
    lease: {
      reservation: {
        ...record.lease.reservation,
        budgetKeys: [...record.lease.reservation.budgetKeys],
      },
      ttlMs: record.lease.ttlMs,
      ...(record.lease.metadata === undefined ? {} : { metadata: { ...record.lease.metadata } }),
      ...(record.lease.unresolvedGrowth === undefined
        ? {}
        : {
            unresolvedGrowth: {
              incrementId: record.lease.unresolvedGrowth.incrementId,
              additionalUnits: record.lease.unresolvedGrowth.additionalUnits,
              budgets: record.lease.unresolvedGrowth.budgets.map(budget => ({ ...budget })),
            },
          }),
    },
    round: record.round,
    expiresAt: record.expiresAt,
    ...(record.applicationRequestState === undefined
      ? {}
      : { applicationRequestState: record.applicationRequestState }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function digestFlowBinding(binding: McpUsageFlowBinding): Promise<string> {
  validateBinding(binding);
  const bytes = new TextEncoder().encode(JSON.stringify([
    binding.principalId, binding.tenantId ?? null, binding.tool, binding.argsHash,
  ]));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
