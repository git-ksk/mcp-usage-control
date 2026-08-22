import { UsageStateError, type UsageEventMetadata, type UsageLeaseResumeState } from 'mcp-usage-control';

export interface RedisMcpFlowEvalClient {
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown>;
}

/** Structurally compatible with mcp-usage-control-mcp's McpUsageFlowBinding. */
export interface RedisMcpUsageFlowBinding {
  principalId: string;
  tenantId?: string;
  tool: string;
  argsHash: string;
}

/** Structurally compatible with mcp-usage-control-mcp's McpUsageFlowRecord. */
export interface RedisMcpUsageFlowRecord {
  flowId: string;
  binding: RedisMcpUsageFlowBinding;
  lease: UsageLeaseResumeState;
  round: number;
  expiresAt: number;
  applicationRequestState?: string;
}

export interface RedisMcpUsageFlowCodec {
  /** Encode trusted server-side flow state. May encrypt the payload before Redis storage. */
  encode(record: RedisMcpUsageFlowRecord): string | Promise<string>;
  /** Decode a payload previously produced by encode(). */
  decode(payload: string): RedisMcpUsageFlowRecord | Promise<RedisMcpUsageFlowRecord>;
}

export interface RedisMcpUsageFlowStoreOptions {
  /** Redis key prefix. Defaults to `muc`. Braces are rejected to preserve the per-flow Cluster hash tag. */
  prefix?: string;
  /** Optional payload codec. Defaults to JSON. Binding comparison is stored separately as a SHA-256 digest. */
  codec?: RedisMcpUsageFlowCodec;
}

const FLOW_ID_PATTERN = /^[A-Za-z0-9._~-]{16,128}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const MAX_RECORD_BYTES = 65_536;

const SUSPEND_FLOW_SCRIPT = `
local t = redis.call('TIME')
local now_ms = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local expires_at = tonumber(ARGV[3])
if not expires_at or expires_at <= now_ms then
  return {'expired'}
end

local record_exists = redis.call('EXISTS', KEYS[1])
local binding_exists = redis.call('EXISTS', KEYS[2])
if record_exists ~= binding_exists then
  return {'corrupt'}
end
if record_exists == 1 then
  return {'duplicate'}
end

redis.call('SET', KEYS[1], ARGV[1], 'PXAT', ARGV[3])
redis.call('SET', KEYS[2], ARGV[2], 'PXAT', ARGV[3])
return {'ok'}
`;

const CONSUME_FLOW_SCRIPT = `
local payload = redis.call('GET', KEYS[1])
local stored_binding = redis.call('GET', KEYS[2])

if not payload and not stored_binding then
  return {'missing'}
end
if not payload or not stored_binding then
  return {'corrupt'}
end
if stored_binding ~= ARGV[1] then
  return {'mismatch'}
end

redis.call('DEL', KEYS[1], KEYS[2])
return {'ok', payload}
`;

const JSON_CODEC: RedisMcpUsageFlowCodec = {
  encode(record) {
    return JSON.stringify(record);
  },
  decode(payload) {
    return JSON.parse(payload) as RedisMcpUsageFlowRecord;
  },
};

/**
 * Shared/durable Redis implementation of the MCP multi-round flow-store contract.
 *
 * Each flow gets its own Redis Cluster hash tag, so its record + binding are
 * atomically manipulated in one slot while unrelated flows can distribute
 * across slots. `consume()` compares a SHA-256 digest of the trusted binding and
 * deletes a matching flow in one Lua invocation. Mismatches never delete the
 * legitimate flow.
 *
 * Redis key expiry uses Redis server time through PXAT. Lost consume
 * acknowledgements are deliberately not retried by this class: the token may
 * already have been consumed. The caller must fail closed instead of re-entering
 * application work blindly.
 */
export class RedisMcpUsageFlowStore {
  private readonly prefix: string;
  private readonly codec: RedisMcpUsageFlowCodec;

  constructor(
    private readonly client: RedisMcpFlowEvalClient,
    options: RedisMcpUsageFlowStoreOptions = {},
  ) {
    this.prefix = options.prefix ?? 'muc';
    if (this.prefix.length === 0 || this.prefix.length > 64 || /[{}]/.test(this.prefix)) {
      throw new RangeError('prefix must be 1-64 characters and must not contain Redis hash-tag braces');
    }
    this.codec = options.codec ?? JSON_CODEC;
  }

  async suspend(record: RedisMcpUsageFlowRecord): Promise<void> {
    validateFlowRecord(record);
    const payload = await this.codec.encode(cloneFlowRecord(record));
    if (typeof payload !== 'string') throw new UsageStateError('Redis MCP flow codec must encode to a string');
    if (new TextEncoder().encode(payload).byteLength > MAX_RECORD_BYTES) {
      throw new RangeError(`Redis MCP flow payload exceeds ${MAX_RECORD_BYTES} bytes`);
    }

    const bindingDigest = await digestBinding(record.binding);
    const reply = parseReply(
      await this.client.eval(SUSPEND_FLOW_SCRIPT, {
        keys: this.keys(record.flowId),
        arguments: [payload, bindingDigest, String(record.expiresAt)],
      }),
    );

    switch (reply[0]) {
      case 'ok':
        return;
      case 'expired':
        throw new UsageStateError('MCP usage flow expiry is not in the future according to Redis');
      case 'duplicate':
        throw new UsageStateError('MCP usage flow ID already exists');
      case 'corrupt':
        throw new UsageStateError('Redis MCP flow storage is inconsistent');
      default:
        throw new UsageStateError('Redis MCP flow suspend returned an invalid reply');
    }
  }

  async consume(
    flowId: string,
    binding: RedisMcpUsageFlowBinding,
  ): Promise<RedisMcpUsageFlowRecord | undefined> {
    validateFlowId(flowId);
    validateBinding(binding);
    const bindingDigest = await digestBinding(binding);
    const reply = parseReply(
      await this.client.eval(CONSUME_FLOW_SCRIPT, {
        keys: this.keys(flowId),
        arguments: [bindingDigest],
      }),
    );

    switch (reply[0]) {
      case 'missing':
      case 'mismatch':
        return undefined;
      case 'corrupt':
        throw new UsageStateError('Redis MCP flow storage is inconsistent');
      case 'ok': {
        if (reply.length !== 2) throw new UsageStateError('Redis MCP flow consume returned an invalid reply');
        let decoded: RedisMcpUsageFlowRecord;
        try {
          decoded = await this.codec.decode(reply[1]!);
        } catch {
          throw new UsageStateError('Redis MCP flow payload could not be decoded');
        }
        validateFlowRecord(decoded);
        if (decoded.flowId !== flowId || !sameBinding(decoded.binding, binding)) {
          throw new UsageStateError('Redis MCP flow payload failed its trusted binding check');
        }
        return cloneFlowRecord(decoded);
      }
      default:
        throw new UsageStateError('Redis MCP flow consume returned an invalid reply');
    }
  }

  private keys(flowId: string): [string, string] {
    validateFlowId(flowId);
    const tag = `mcp-flow:${flowId}`;
    return [
      `${this.prefix}:{${tag}}:record`,
      `${this.prefix}:{${tag}}:binding`,
    ];
  }
}

async function digestBinding(binding: RedisMcpUsageFlowBinding): Promise<string> {
  validateBinding(binding);
  const encoded = new TextEncoder().encode(
    JSON.stringify([binding.principalId, binding.tenantId ?? null, binding.tool, binding.argsHash]),
  );
  const hash = await globalThis.crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

function validateFlowRecord(record: RedisMcpUsageFlowRecord): void {
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

function validateBinding(binding: RedisMcpUsageFlowBinding): void {
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

function validateFlowId(flowId: string): void {
  if (typeof flowId !== 'string' || !FLOW_ID_PATTERN.test(flowId)) {
    throw new UsageStateError('MCP usage flow ID must be 16-128 URL-safe characters');
  }
}

function sameBinding(left: RedisMcpUsageFlowBinding, right: RedisMcpUsageFlowBinding): boolean {
  return (
    left.principalId === right.principalId &&
    left.tenantId === right.tenantId &&
    left.tool === right.tool &&
    left.argsHash === right.argsHash
  );
}

function cloneFlowRecord(record: RedisMcpUsageFlowRecord): RedisMcpUsageFlowRecord {
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

function parseReply(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new UsageStateError('Redis MCP flow script returned an invalid reply');
  }
  return value.map(item => {
    if (typeof item === 'string') return item;
    if (typeof item === 'number') return String(item);
    if (item instanceof Uint8Array) return new TextDecoder().decode(item);
    throw new UsageStateError('Redis MCP flow script returned an invalid reply item');
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
