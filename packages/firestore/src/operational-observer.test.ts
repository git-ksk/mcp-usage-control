import { describe, expect, it } from 'vitest';
import { UsageOperationalMonitor } from 'mcp-usage-control/operational';
import type { FirestoreRecoveryObserver } from './index.js';

describe('Firestore operational observer compatibility', () => {
  it('accepts the provider-neutral operational monitor and counts recovery events', () => {
    const monitor = new UsageOperationalMonitor();
    const observer: FirestoreRecoveryObserver = monitor;

    observer.onEvent({
      type: 'reservation.recovered',
      timestamp: 1,
      store: 'firestore',
      recovery: 'pending_released',
      reservationId: 'fs1.test',
      reservedUnits: 3,
      count: 1,
    });
    observer.onEvent({
      type: 'vector.reservation.recovered',
      timestamp: 2,
      store: 'firestore',
      recovery: 'liable_retained',
      reservationId: 'fs1.vector-test',
      dimensionCount: 2,
      budgetCount: 3,
      count: 1,
    });

    expect(monitor.snapshot().lifecycle).toMatchObject({
      eventsObserved: 2,
      pendingReservationsReleased: 1,
      liableReservationsRetained: 1,
    });
  });
});
