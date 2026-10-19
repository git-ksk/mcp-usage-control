import { DurableObject, type DurableObjectState } from 'cloudflare:workers';
import { UsageStateError } from 'mcp-usage-control';
import type { McpUsageFlowRecord } from 'mcp-usage-control-mcp';
import { MAX_MCP_FLOW_RECORD_BYTES, MAX_MCP_FLOW_RETENTION_MS, type CloudflareMcpFlowSuspend, type CloudflareMcpFlowConsume } from './mcp-flow.js';
import { digestFlowBinding, sameBinding, validateBinding, validateFlowId, validateFlowRecord } from './mcp-flow-validation.js';

interface FlowRow extends Record<string, string | number | ArrayBuffer | null> {
  flow_id: string;
  payload: string;
  binding_digest: string;
  expires_at: number;
  retain_until: number;
  status: string;
}

/**
 * Dedicated per-flow SQLite Durable Object. Never reuse the accounting DO class
 * or its SQLite schema. Keep RPC binding private to the enclosing Worker.
 */
export class CloudflareMcpFlowDurableObject extends DurableObject<unknown> {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS mcp_flow_v1 (
      flow_id TEXT PRIMARY KEY NOT NULL,
      payload TEXT NOT NULL,
      binding_digest TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      retain_until INTEGER NOT NULL,
      status TEXT NOT NULL
    )`);
  }

  async suspendFlow(input: CloudflareMcpFlowSuspend): Promise<'ok'> {
    validateFlowId(input.flowId);
    if (!/^[a-f0-9]{64}$/.test(input.bindingDigest)) throw new UsageStateError('Invalid MCP flow binding digest');
    if (typeof input.payload !== 'string' || new TextEncoder().encode(input.payload).byteLength > MAX_MCP_FLOW_RECORD_BYTES) {
      throw new UsageStateError('Invalid MCP flow payload size');
    }
    if (!Number.isSafeInteger(input.expiresAt) || !Number.isSafeInteger(input.retentionMs) ||
      input.retentionMs < 0 || input.retentionMs > MAX_MCP_FLOW_RETENTION_MS) {
      throw new UsageStateError('Invalid MCP flow expiration/retention');
    }
    let record: McpUsageFlowRecord;
    try {
      record = JSON.parse(input.payload) as McpUsageFlowRecord;
      validateFlowRecord(record);
    } catch {
      throw new UsageStateError('Invalid MCP flow record');
    }
    if (await digestFlowBinding(record.binding) !== input.bindingDigest) {
      throw new UsageStateError('MCP flow digest does not match stored binding');
    }
    if (record.flowId !== input.flowId || record.expiresAt !== input.expiresAt) {
      throw new UsageStateError('MCP flow record identity/expiry mismatch');
    }
    const retainUntil = input.expiresAt + input.retentionMs;
    if (!Number.isSafeInteger(retainUntil)) throw new UsageStateError('MCP flow retention timestamp out of range');
    this.ctx.storage.transactionSync(() => {
      const now = Date.now(); // DO-side platform time domain: not application-host wall clock.
      if (input.expiresAt <= now) throw new UsageStateError('MCP flow is expired according to Durable Object time');
      const exists = this.ctx.storage.sql.exec<{ flow_id: string }>(
        'SELECT flow_id FROM mcp_flow_v1 WHERE flow_id = ?', input.flowId,
      ).toArray();
      if (exists.length > 0) throw new UsageStateError('MCP flow ID already exists');
      this.ctx.storage.sql.exec(
        'INSERT INTO mcp_flow_v1 (flow_id,payload,binding_digest,expires_at,retain_until,status) VALUES (?,?,?,?,?,?)',
        input.flowId, input.payload, input.bindingDigest, input.expiresAt, retainUntil, 'active',
      );
    });
    // A lost alarm RPC acknowledgement cannot authorize replay. The record
    // remains safe if scheduling fails; future same-ID calls cannot overwrite.
    await this.ctx.storage.setAlarm(retainUntil);
    return 'ok';
  }

  async consumeFlow(input: CloudflareMcpFlowConsume): Promise<string | undefined> {
    validateFlowId(input.flowId);
    if (!/^[a-f0-9]{64}$/.test(input.bindingDigest)) throw new UsageStateError('Invalid MCP flow binding digest');
    validateBinding(input.binding);
    if (await digestFlowBinding(input.binding) !== input.bindingDigest) {
      throw new UsageStateError('MCP flow requested binding/digest mismatch');
    }
    return this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      const row = this.ctx.storage.sql.exec<FlowRow>(
        'SELECT * FROM mcp_flow_v1 WHERE flow_id = ?', input.flowId,
      ).toArray()[0];
      if (!row || row.status === 'consumed') return undefined;
      if (row.status !== 'active' || typeof row.payload !== 'string' ||
        typeof row.binding_digest !== 'string' || !Number.isSafeInteger(row.expires_at) ||
        new TextEncoder().encode(row.payload).byteLength > MAX_MCP_FLOW_RECORD_BYTES) {
        throw new UsageStateError('MCP flow DO record is corrupt');
      }
      if (row.binding_digest !== input.bindingDigest) return undefined;
      if (row.expires_at <= now) return undefined;
      // Confirm the payload is structurally valid BEFORE the destructive claim.
      let record: McpUsageFlowRecord;
      try {
        record = JSON.parse(row.payload) as McpUsageFlowRecord;
        validateFlowRecord(record);
      } catch {
        throw new UsageStateError('MCP flow DO payload is invalid');
      }
      if (record.flowId !== input.flowId || record.expiresAt !== row.expires_at ||
        !sameBinding(record.binding, input.binding)) {
        throw new UsageStateError('MCP flow DO record is inconsistent');
      }
      // The digest is bound to the actual record by the separate protected adapter.
      this.ctx.storage.sql.exec(
        "UPDATE mcp_flow_v1 SET status = 'consumed', payload = '' WHERE flow_id = ? AND status = 'active'",
        input.flowId,
      );
      return row.payload;
    });
  }

  async alarm(): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('DELETE FROM mcp_flow_v1 WHERE retain_until <= ?', Date.now());
    });
  }
}
