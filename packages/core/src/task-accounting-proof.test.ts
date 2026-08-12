import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MemoryUsageStore,
  UsageControl,
  UsageStateError,
  type UsagePolicy,
  type UsageRequest,
  type UsageStore,
} from './index.js';

function taskRequest(operationId: string): UsageRequest {
  return {
    operationId,
    principal: { id: 'user-1', tenantId: 'tenant-1' },
    tool: 'long-running-tool',
    args: { job: 'same-business-operation' },
  };
}

function fixedPolicy(units = 1, limit = 1, reservationTtlMs = 100): UsagePolicy {
  return {
    quote() {
      return {
        decision: 'allow',
        units,
        budgets: [{ key: 'tenant:tenant-1:task-budget', limit }],
        reservationTtlMs,
      };
    },
  };
}

class CountingStore implements UsageStore {
  reserveCalls = 0;

  constructor(private readonly inner: UsageStore) {}

  reserve(input: Parameters<UsageStore['reserve']>[0]) {
    this.reserveCalls += 1;
    return this.inner.reserve(input);
  }

  markLiable(input: Parameters<UsageStore['markLiable']>[0]) {
    return this.inner.markLiable(input);
  }

  renew(input: Parameters<UsageStore['renew']>[0]) {
    return this.inner.renew(input);
  }

  settle(input: Parameters<UsageStore['settle']>[0]) {
    return this.inner.settle(input);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('MCP Tasks accounting proof', () => {
  it('keeps one reservation across working and input-required phases', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-13T00:00:00Z'));

    const store = new CountingStore(new MemoryUsageStore());
    const control = new UsageControl(store, fixedPolicy(1, 2, 50));
    const admission = await control.reserve(taskRequest('task-op'));
    if (!admission.allowed) throw new Error('expected task admission');

    // Durable task creation and queueing do not require a second reservation.
    await vi.advanceTimersByTimeAsync(40);
    await admission.lease.renew();

    // Metered execution becomes liable only immediately before the work that may incur cost.
    await admission.lease.markLiable();

    // A task may remain input_required for another protocol round while the same
    // authoritative server-side lease is renewed. tasks/update must not reserve again.
    await vi.advanceTimersByTimeAsync(40);
    await admission.lease.renew();
    await vi.advanceTimersByTimeAsync(40);

    const settlement = await admission.lease.settle(1, 'task_completed');
    expect(settlement.actualUnits).toBe(1);
    expect(store.reserveCalls).toBe(1);
  });

  it('allows zero settlement only when cancellation is proved before liability', async () => {
    const store = new MemoryUsageStore();
    const control = new UsageControl(store, fixedPolicy());
    const admission = await control.reserve(taskRequest('cancel-before-start'));
    if (!admission.allowed) throw new Error('expected task admission');

    await admission.lease.settle(0, 'task_cancelled_before_execution');

    const replacement = await control.reserve(taskRequest('replacement'));
    expect(replacement.allowed).toBe(true);
  });

  it('does not refund merely because a cooperative cancellation request was acknowledged', async () => {
    const store = new MemoryUsageStore();
    const control = new UsageControl(store, fixedPolicy());
    const admission = await control.reserve(taskRequest('cancel-after-start'));
    if (!admission.allowed) throw new Error('expected task admission');

    await admission.lease.markLiable();

    // A tasks/cancel ACK is only cancellation intent. No settlement happens here.
    const whileCancellationIsPending = await control.reserve(taskRequest('other-task'));
    expect(whileCancellationIsPending).toMatchObject({
      allowed: false,
      reason: 'quota_exceeded',
    });

    const settlement = await admission.lease.settle(1, 'task_cancelled_after_execution_started');
    expect(settlement.actualUnits).toBe(1);
  });

  it('releases an abandoned pending task after lease expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-13T00:00:00Z'));

    const store = new MemoryUsageStore();
    const control = new UsageControl(store, fixedPolicy(1, 1, 50));
    const admission = await control.reserve(taskRequest('queued-worker-crash'));
    if (!admission.allowed) throw new Error('expected task admission');

    // The worker disappears before crossing the metered boundary and cannot renew.
    await vi.advanceTimersByTimeAsync(51);

    const replacement = await control.reserve(taskRequest('replacement-after-pending-expiry'));
    expect(replacement.allowed).toBe(true);
  });

  it('retains the conservative full charge when a liable worker crashes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-13T00:00:00Z'));

    const store = new MemoryUsageStore();
    const control = new UsageControl(store, fixedPolicy(1, 1, 50));
    const admission = await control.reserve(taskRequest('liable-worker-crash'));
    if (!admission.allowed) throw new Error('expected task admission');

    await admission.lease.markLiable();
    await vi.advanceTimersByTimeAsync(51);

    // Touching the store triggers recovery. The expired liable reservation remains
    // fully consumed, so worker loss cannot become an optimistic refund.
    const another = await control.reserve(taskRequest('after-liable-expiry'));
    expect(another).toMatchObject({ allowed: false, reason: 'quota_exceeded' });

    // The original logical operation remains replay-protected during the tombstone period.
    const replay = await control.reserve(taskRequest('liable-worker-crash'));
    expect(replay).toEqual({ allowed: false, reason: 'duplicate_operation' });
  });

  it('permits only identical terminal settlement replay after an ambiguous acknowledgement', async () => {
    const control = new UsageControl(new MemoryUsageStore(), fixedPolicy());
    const admission = await control.reserve(taskRequest('ambiguous-terminal-ack'));
    if (!admission.allowed) throw new Error('expected task admission');

    await admission.lease.markLiable();
    const first = await admission.lease.settle(1, 'task_completed');

    // Model a lost settlement ACK: the caller may repeat the exact same terminal write.
    await expect(admission.lease.settle(1, 'task_completed')).resolves.toEqual(first);

    // It may not invent a conflicting outcome or unit count to regain availability.
    await expect(admission.lease.settle(0, 'task_cancelled_before_execution')).rejects.toBeInstanceOf(
      UsageStateError,
    );
  });
});
