export const CANONICAL_SETTLEMENT_OUTCOMES = [
  'authorization_denied',
  'invalid_arguments',
  'pre_dispatch_rejected',
  'pre_dispatch_no_effect',
  'cancelled_before_dispatch',
  'completed',
  'proven_no_effect',
  'dispatched_conservative',
  'cancelled_after_dispatch',
] as const;

export type CanonicalSettlementOutcome = (typeof CANONICAL_SETTLEMENT_OUTCOMES)[number];

export type SettlementOutcomeAliases = Readonly<Record<string, CanonicalSettlementOutcome>>;

export interface SettlementOutcomeDiagnosticSink {
  onInvalidSettlementOutcome(): void | Promise<void>;
}

/**
 * Compatibility aliases used by the built-in MCP adapter and older integrations.
 * New integrations should emit the canonical vocabulary directly.
 */
export const DEFAULT_SETTLEMENT_OUTCOME_ALIASES: SettlementOutcomeAliases = Object.freeze({
  success: 'completed',
  tool_error: 'completed',
  error: 'dispatched_conservative',
  unsupported_input_required: 'dispatched_conservative',
  input_required_round_limit: 'dispatched_conservative',
  invalid_input_required_state: 'dispatched_conservative',
  input_required_suspend_failed: 'dispatched_conservative',
});

/** Bounded diagnostic for integration vocabulary drift; raw input is deliberately not retained. */
export class InvalidSettlementOutcomeError extends TypeError {
  readonly code = 'invalid_settlement_outcome' as const;

  constructor() {
    super('Settlement outcome is not part of the canonical usage vocabulary');
    this.name = 'InvalidSettlementOutcomeError';
  }
}

export function isCanonicalSettlementOutcome(value: unknown): value is CanonicalSettlementOutcome {
  return (
    typeof value === 'string' &&
    (CANONICAL_SETTLEMENT_OUTCOMES as readonly string[]).includes(value)
  );
}

/**
 * Normalize a bounded consumer/domain outcome before it crosses the usage boundary.
 * Invalid vocabulary fails before Store settlement and is distinguishable from backend failure.
 * Diagnostic delivery is best-effort and can never replace the bounded normalization error.
 */
export function normalizeSettlementOutcome(
  value: unknown,
  aliases: SettlementOutcomeAliases = DEFAULT_SETTLEMENT_OUTCOME_ALIASES,
  diagnostics?: SettlementOutcomeDiagnosticSink,
): CanonicalSettlementOutcome {
  if (isCanonicalSettlementOutcome(value)) return value;
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    return rejectInvalidSettlementOutcome(diagnostics);
  }
  const normalized = aliases[value];
  if (normalized === undefined || !isCanonicalSettlementOutcome(normalized)) {
    return rejectInvalidSettlementOutcome(diagnostics);
  }
  return normalized;
}

function rejectInvalidSettlementOutcome(
  diagnostics: SettlementOutcomeDiagnosticSink | undefined,
): never {
  if (diagnostics !== undefined) {
    try {
      const result = diagnostics.onInvalidSettlementOutcome();
      if (result && typeof (result as Promise<void>).catch === 'function') {
        void (result as Promise<void>).catch(() => undefined);
      }
    } catch {
      // Diagnostics are not part of settlement normalization or enforcement.
    }
  }
  throw new InvalidSettlementOutcomeError();
}
