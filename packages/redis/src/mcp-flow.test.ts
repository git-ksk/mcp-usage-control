import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from 'redis';
import {
  RedisMcpUsageFlowStore,
  type RedisMcpFlowEvalClient,
  type RedisMcpUsageFlowBinding,
  type RedisMcpUsageFlowCodec,
  type RedisMcpUsageFlowRecord,
} from './mcp-flow.js';

const redisUrl = process.env.REDIS_URL;
let client: ReturnType<typeof createClient> | undefined;

const binding: RedisMcpUsageFlowBinding = {
  principalId: 'user-1',
  tenantId: 'tenant-1',
  tool: 'confirm-write',
  argsHash: 'a'.repeat(64),
};

function record(
  flowId: string,
  expiresAt = Date.now() + 5_000,
  currentBinding: RedisMcpUsageFlowBinding = binding,
): RedisMcpUsageFlowRecord {
  return {
    flowId,
    binding: { ...currentBinding },
    lease: {
      reservation: {
        id: `reservation:${flowId}`,
        operationId: `operation:${flowId}`,
        principalId: currentBinding.principalId,
        ...(currentBinding.tenantId === undefined ? {} : { tenantId: currentBinding.tenantId }),
        plan: 'free',
        tool: currentBinding.tool,
        budgetKeys: ['budget:user-1:monthly'],
        reservedUnits: 1,
        expiresAt,
      },
      ttlMs: 1_000,
      metadata: { environment: 'test' },
    },
    round: 1,
    expiresAt,
    applicationRequestState: 'awaiting-confirmation',
  };
}

beforeAll(async () => {
  if (!redisUrl) return;
  client = createClient({ url: redisUrl });
  await client.connect();
  await client.flushDb();
});

afterAll(async () => {
  if (client) await client.quit();
});

describe('RedisMcpUsageFlowStore validation', () => {
  it('fails closed when Redis is unavailable', async () => {
    const unavailable: RedisMcpFlowEvalClient = {
      async eval() {
        throw new Error('redis unavailable');
      },
    };
    const store = new RedisMcpUsageFlowStore(unavailable);
    await expect(store.suspend(record('flow-000000000001'))).rejects.toThrow('redis unavailable');
    await expect(store.consume('flow-000000000001', binding)).rejects.toThrow('redis unavailable');
  });

  it('rejects invalid prefixes before constructing Redis keys', () => {
    const fake: RedisMcpFlowEvalClient = { eval: async () => ['ok'] };
    expect(() => new RedisMcpUsageFlowStore(fake, { prefix: 'bad{tag}' })).toThrow(/prefix/);
  });

  it('supports an opaque application codec without changing binding semantics', async () => {
    let storedPayload = '';
    const memory = new Map<string, string>();
    const fake: RedisMcpFlowEvalClient = {
      async eval(_script, options) {
        const [recordKey, bindingKey] = options.keys;
        if (options.arguments.length === 3) {
          storedPayload = options.arguments[0]!;
          memory.set(recordKey!, options.arguments[0]!);
          memory.set(bindingKey!, options.arguments[1]!);
          return ['ok'];
        }
        const payload = memory.get(recordKey!);
        const storedBinding = memory.get(bindingKey!);
        if (!payload && !storedBinding) return ['missing'];
        if (storedBinding !== options.arguments[0]) return ['mismatch'];
        memory.delete(recordKey!);
        memory.delete(bindingKey!);
        return ['ok', payload!];
      },
    };
    const codec: RedisMcpUsageFlowCodec = {
      encode(value) {
        return `opaque:${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
      },
      decode(payload) {
        return JSON.parse(
          Buffer.from(payload.slice('opaque:'.length), 'base64url').toString('utf8'),
        ) as RedisMcpUsageFlowRecord;
      },
    };
    const store = new RedisMcpUsageFlowStore(fake, { codec });
    const value = record('flow-000000000002');
    await store.suspend(value);
    expect(storedPayload.startsWith('opaque:')).toBe(true);
    expect(storedPayload).not.toContain('user-1');
    await expect(store.consume(value.flowId, binding)).resolves.toEqual(value);
  });
});

describe.skipIf(!redisUrl)('RedisMcpUsageFlowStore integration', () => {
  function store(prefix: string): RedisMcpUsageFlowStore {
    if (!client) throw new Error('redis client unavailable');
    return new RedisMcpUsageFlowStore(client as unknown as RedisMcpFlowEvalClient, { prefix });
  }

  it('shares a suspended flow across store instances and consumes it once', async () => {
    const writer = store('flow-shared');
    const reader = store('flow-shared');
    const value = record('flow-000000000003');
    await writer.suspend(value);

    await expect(reader.consume(value.flowId, binding)).resolves.toEqual(value);
    await expect(writer.consume(value.flowId, binding)).resolves.toBeUndefined();
  });

  it('permits exactly one consumer under parallel contention', async () => {
    const target = store('flow-contention');
    const value = record('flow-000000000004');
    await target.suspend(value);

    const results = await Promise.all(
      Array.from({ length: 100 }, () => target.consume(value.flowId, binding)),
    );
    expect(results.filter(result => result !== undefined)).toHaveLength(1);
    expect(results.filter(result => result === undefined)).toHaveLength(99);
  });

  it('does not let a mismatched caller consume the legitimate flow', async () => {
    const target = store('flow-binding');
    const value = record('flow-000000000005');
    await target.suspend(value);

    await expect(
      target.consume(value.flowId, { ...binding, principalId: 'attacker' }),
    ).resolves.toBeUndefined();
    await expect(target.consume(value.flowId, binding)).resolves.toEqual(value);
  });

  it('rejects duplicate live flow IDs but allows reuse after Redis expiry', async () => {
    const target = store('flow-expiry');
    const flowId = 'flow-000000000006';
    const live = record(flowId, Date.now() + 500);
    await target.suspend(live);
    await expect(target.suspend(record(flowId, live.expiresAt))).rejects.toThrow(/already exists/);

    await new Promise(resolve => setTimeout(resolve, 700));
    await expect(target.consume(flowId, binding)).resolves.toBeUndefined();
    const reused = record(flowId, Date.now() + 2_000);
    await expect(target.suspend(reused)).resolves.toBeUndefined();
    await expect(target.consume(flowId, binding)).resolves.toEqual(reused);
  });

  it('retains a committed suspend when its acknowledgement is lost', async () => {
    if (!client) throw new Error('redis client unavailable');
    let calls = 0;
    const loseReply: RedisMcpFlowEvalClient = {
      async eval(script, options) {
        calls += 1;
        await (client as unknown as RedisMcpFlowEvalClient).eval(script, options);
        throw new Error('simulated lost suspend ACK');
      },
    };
    const ambiguous = new RedisMcpUsageFlowStore(loseReply, { prefix: 'flow-lost-suspend' });
    const verifier = store('flow-lost-suspend');
    const value = record('flow-000000000007');

    await expect(ambiguous.suspend(value)).rejects.toThrow(/lost suspend ACK/);
    expect(calls).toBe(1);
    await expect(verifier.consume(value.flowId, binding)).resolves.toEqual(value);
  });

  it('does not make a consumed token reusable when the consume ACK is lost', async () => {
    if (!client) throw new Error('redis client unavailable');
    const base = store('flow-lost-consume');
    const value = record('flow-000000000008');
    await base.suspend(value);

    let calls = 0;
    const loseReply: RedisMcpFlowEvalClient = {
      async eval(script, options) {
        calls += 1;
        await (client as unknown as RedisMcpFlowEvalClient).eval(script, options);
        throw new Error('simulated lost consume ACK');
      },
    };
    const ambiguous = new RedisMcpUsageFlowStore(loseReply, { prefix: 'flow-lost-consume' });
    await expect(ambiguous.consume(value.flowId, binding)).rejects.toThrow(/lost consume ACK/);
    expect(calls).toBe(1);
    await expect(base.consume(value.flowId, binding)).resolves.toBeUndefined();
  });
});
