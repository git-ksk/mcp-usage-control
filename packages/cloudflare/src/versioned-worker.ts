import type { DurableObjectState } from 'cloudflare:workers';
import { initializeCloudflareUsageSchema } from './schema.js';
import { UsageControlDurableObject as BaseUsageControlDurableObject } from './worker.js';

/**
 * Public Durable Object entry point with explicit SQLite schema validation.
 * Schema initialization runs before the legacy v1 constructor so incompatible
 * or newer databases fail closed before any compatibility DDL can run.
 */
export class UsageControlDurableObject extends BaseUsageControlDurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    initializeCloudflareUsageSchema(ctx.storage);
    super(ctx, env);
  }
}
