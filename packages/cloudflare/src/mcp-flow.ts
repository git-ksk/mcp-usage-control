import { UsageStateError } from 'mcp-usage-control';
import type { McpUsageFlowBinding, McpUsageFlowRecord } from 'mcp-usage-control-mcp';
import { cloneFlowRecord, digestFlowBinding, sameBinding, validateBinding, validateFlowId, validateFlowRecord } from './mcp-flow-validation.js';

export const MAX_MCP_FLOW_RECORD_BYTES = 65_536;
export const MAX_MCP_FLOW_RETENTION_MS = 604_800_000;

/** Same-worker Durable Object RPC only; no network gateway or bearer-token auth is provided here. */
export interface CloudflareMcpFlowStub {
  suspendFlow(input: CloudflareMcpFlowSuspend): Promise<'ok'>;
  consumeFlow(input: CloudflareMcpFlowConsume): Promise<string | undefined>;
}

export interface CloudflareMcpFlowNamespace {
  getByName?(name: string): CloudflareMcpFlowStub;
  idFromName?(name: string): unknown;
  get?(id: unknown): CloudflareMcpFlowStub;
}

/** Internal server-authorized command; never accept these fields from an MCP client. */
export interface CloudflareMcpFlowSuspend {
  flowId: string;
  payload: string;
  bindingDigest: string;
  expiresAt: number;
  retentionMs: number;
}

export interface CloudflareMcpFlowConsume {
  flowId: string;
  bindingDigest: string;
  binding: McpUsageFlowBinding;
}

export interface CloudflareMcpUsageFlowStoreOptions {
  /** Distinct namespace/domain for the Flow DO class, never the accounting DO. */
  namespace: CloudflareMcpFlowNamespace;
  /** Prevent collisions if multiple independent applications share one Flow DO namespace. */
  domainPrefix?: string;
  /** Keep consumed/expired tombstones after expiry, default 24h. */
  retentionMs?: number;
}

/**
 * Opt-in, direct same-Worker FlowStore backed by one SQLite DO per flow ID.
 * DO-host Date.now() is the expiry authority; application host clocks are not.
 * Any RPC/ACK error is propagated: the caller MUST fail closed and never blindly
 * retry business work or create another usage reservation.
 */
export class CloudflareMcpUsageFlowStore {
  private readonly namespace: CloudflareMcpFlowNamespace;
  private readonly domainPrefix: string;
  private readonly retentionMs: number;

  constructor(options: CloudflareMcpUsageFlowStoreOptions) {
    this.namespace = options.namespace;
    this.domainPrefix = options.domainPrefix ?? 'muc-flow-v1';
    if (!/^[A-Za-z0-9._~-]{1,80}$/.test(this.domainPrefix)) {
      throw new RangeError('MCP Flow DO domainPrefix must be 1-80 URL-safe characters');
    }
    this.retentionMs = options.retentionMs ?? 86_400_000;
    if (!Number.isSafeInteger(this.retentionMs) || this.retentionMs < 0 || this.retentionMs > MAX_MCP_FLOW_RETENTION_MS) {
      throw new RangeError('MCP Flow DO retentionMs must be a safe integer from 0 to 7 days');
    }
  }

  async suspend(record: McpUsageFlowRecord): Promise<void> {
    validateFlowRecord(record);
    const payload = JSON.stringify(cloneFlowRecord(record));
    if (new TextEncoder().encode(payload).byteLength > MAX_MCP_FLOW_RECORD_BYTES) {
      throw new RangeError(`Cloudflare MCP flow payload exceeds ${MAX_MCP_FLOW_RECORD_BYTES} bytes`);
    }
    const bindingDigest = await digestFlowBinding(record.binding);
    await this.stub(record.flowId).suspendFlow({
      flowId: record.flowId,
      payload,
      bindingDigest,
      expiresAt: record.expiresAt,
      retentionMs: this.retentionMs,
    });
  }

  async consume(flowId: string, binding: McpUsageFlowBinding): Promise<McpUsageFlowRecord | undefined> {
    validateFlowId(flowId);
    validateBinding(binding);
    const bindingDigest = await digestFlowBinding(binding);
    const payload = await this.stub(flowId).consumeFlow({ flowId, bindingDigest, binding });
    if (payload === undefined) return undefined;
    if (typeof payload !== 'string' || new TextEncoder().encode(payload).byteLength > MAX_MCP_FLOW_RECORD_BYTES) {
      throw new UsageStateError('Cloudflare MCP flow payload is malformed');
    }
    let record: McpUsageFlowRecord;
    try {
      record = JSON.parse(payload) as McpUsageFlowRecord;
      validateFlowRecord(record);
    } catch {
      throw new UsageStateError('Cloudflare MCP flow payload could not be decoded');
    }
    if (record.flowId !== flowId || !sameBinding(record.binding, binding)) {
      throw new UsageStateError('Cloudflare MCP flow payload binding mismatch');
    }
    return cloneFlowRecord(record);
  }

  private stub(flowId: string): CloudflareMcpFlowStub {
    validateFlowId(flowId);
    const domain = `${this.domainPrefix}:${flowId}`;
    if (typeof this.namespace.getByName === 'function') return this.namespace.getByName(domain);
    if (typeof this.namespace.idFromName === 'function' && typeof this.namespace.get === 'function') {
      return this.namespace.get(this.namespace.idFromName(domain));
    }
    throw new UsageStateError('Cloudflare MCP Flow DO namespace does not support getByName or idFromName/get');
  }
}
