export type AccountingWindowPeriod = 'calendar-day' | 'calendar-month';
export type AccountingWindowInstant = number | Date;

export type WindowedBudgetKeyConfig = Readonly<{
  period: AccountingWindowPeriod;
  timeZone: string;
  namespace: string;
  /** Optional trusted clock. `key({ now })` / `window({ now })` override it. */
  clock?: () => AccountingWindowInstant;
}>;

export type WindowedBudgetKeyInput = Readonly<{
  scope: string;
  id: string;
  now?: AccountingWindowInstant;
}>;

export type AccountingWindowProjection = Readonly<{
  key: string;
  /** Inclusive epoch-millisecond start of the selected calendar window. */
  startsAt: number;
  /** Exclusive epoch-millisecond end; this is the next reset boundary for this window. */
  endsAt: number;
}>;

export type WindowedBudgetKey = Readonly<{
  key(input: WindowedBudgetKeyInput): string;
  /** Derive the exact key and matching calendar boundary from one trusted calculation. */
  window(input: WindowedBudgetKeyInput): AccountingWindowProjection;
}>;

const DAY_SEARCH_SPAN_MS = 3 * 24 * 60 * 60 * 1000;
const MONTH_SEARCH_SPAN_MS = 40 * 24 * 60 * 60 * 1000;

/**
 * Create a pure calendar-window budget-key helper.
 *
 * The Store never observes wall-clock rollover. A caller selects a new accounting
 * bucket only by deriving a new key from explicit inputs. The configured time-zone
 * literal is part of key identity, so changing it intentionally selects fresh state
 * instead of silently reusing an old bucket with different boundary semantics.
 */
export function createWindowedBudgetKey(config: WindowedBudgetKeyConfig): WindowedBudgetKey {
  assertPlainRecord(config, 'config');
  assertExactKeys(
    config,
    ['period', 'timeZone', 'namespace', 'clock'],
    ['period', 'timeZone', 'namespace'],
    'config',
  );

  if (config.period !== 'calendar-day' && config.period !== 'calendar-month') {
    throw new TypeError('config.period must be "calendar-day" or "calendar-month"');
  }
  assertIdentityString(config.timeZone, 'config.timeZone');
  assertIdentityString(config.namespace, 'config.namespace');
  if (config.clock !== undefined && typeof config.clock !== 'function') {
    throw new TypeError('config.clock must be a function when provided');
  }

  const period = config.period;
  const periodToken = period === 'calendar-day' ? 'day' : 'month';
  const timeZone = config.timeZone;
  const namespace = encodeIdentitySegment(config.namespace, 'config.namespace');
  const timeZoneSegment = encodeIdentitySegment(timeZone, 'config.timeZone');
  const clock = config.clock;

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US-u-ca-iso8601-nu-latn', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    throw new RangeError(`config.timeZone is not supported: ${JSON.stringify(timeZone)}`);
  }

  function resolve(input: WindowedBudgetKeyInput): { timestamp: number; key: string; windowId: string } {
    assertPlainRecord(input, 'input');
    assertExactKeys(input, ['scope', 'id', 'now'], ['scope', 'id'], 'input');
    assertIdentityString(input.scope, 'input.scope');
    assertIdentityString(input.id, 'input.id');

    const instant = input.now ?? clock?.();
    if (instant === undefined) {
      throw new TypeError('input.now is required when config.clock is not configured');
    }
    const date = toValidDate(instant, input.now === undefined ? 'config.clock result' : 'input.now');
    const windowId = formatWindowId(formatter, date, period);
    return {
      timestamp: date.getTime(),
      windowId,
      key: [
        namespace,
        periodToken,
        `tz=${timeZoneSegment}`,
        encodeIdentitySegment(input.scope, 'input.scope'),
        encodeIdentitySegment(input.id, 'input.id'),
        windowId,
      ].join(':'),
    };
  }

  return Object.freeze({
    key(input: WindowedBudgetKeyInput): string {
      return resolve(input).key;
    },
    window(input: WindowedBudgetKeyInput): AccountingWindowProjection {
      const resolved = resolve(input);
      const searchSpanMs = period === 'calendar-day' ? DAY_SEARCH_SPAN_MS : MONTH_SEARCH_SPAN_MS;
      return {
        key: resolved.key,
        startsAt: findWindowBoundary(formatter, period, resolved.windowId, resolved.timestamp, -1, searchSpanMs),
        endsAt: findWindowBoundary(formatter, period, resolved.windowId, resolved.timestamp, 1, searchSpanMs),
      };
    },
  });
}

function findWindowBoundary(
  formatter: Intl.DateTimeFormat,
  period: AccountingWindowPeriod,
  currentWindowId: string,
  timestamp: number,
  direction: -1 | 1,
  searchSpanMs: number,
): number {
  const outside = timestamp + direction * searchSpanMs;
  const outsideDate = new Date(outside);
  if (!Number.isFinite(outsideDate.getTime())) {
    throw new RangeError('accounting window boundary is outside the supported Date range');
  }
  if (formatWindowId(formatter, outsideDate, period) === currentWindowId) {
    throw new RangeError('unable to bracket accounting window boundary');
  }

  let low: number;
  let high: number;
  if (direction < 0) {
    low = outside;
    high = timestamp;
    while (low + 1 < high) {
      const mid = low + Math.floor((high - low) / 2);
      if (formatWindowId(formatter, new Date(mid), period) === currentWindowId) high = mid;
      else low = mid;
    }
    return high;
  }

  low = timestamp;
  high = outside;
  while (low + 1 < high) {
    const mid = low + Math.floor((high - low) / 2);
    if (formatWindowId(formatter, new Date(mid), period) === currentWindowId) low = mid;
    else high = mid;
  }
  return high;
}

function formatWindowId(
  formatter: Intl.DateTimeFormat,
  date: Date,
  period: AccountingWindowPeriod,
): string {
  let year: string | undefined;
  let month: string | undefined;
  let day: string | undefined;
  for (const part of formatter.formatToParts(date)) {
    if (part.type === 'year') year = part.value;
    else if (part.type === 'month') month = part.value;
    else if (part.type === 'day') day = part.value;
  }
  if (year === undefined || month === undefined || day === undefined) {
    throw new RangeError('unable to derive ISO calendar window from the configured time zone');
  }
  return period === 'calendar-day' ? `${year}-${month}-${day}` : `${year}-${month}`;
}

function toValidDate(value: AccountingWindowInstant, name: string): Date {
  let timestamp: number;
  if (value instanceof Date) timestamp = value.getTime();
  else if (typeof value === 'number') timestamp = value;
  else throw new TypeError(`${name} must be a Date or epoch-millisecond number`);

  if (!Number.isFinite(timestamp)) throw new RangeError(`${name} must be a finite valid instant`);
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) throw new RangeError(`${name} must be a finite valid instant`);
  return date;
}

function encodeIdentitySegment(value: string, name: string): string {
  try {
    return encodeURIComponent(value);
  } catch {
    throw new TypeError(`${name} contains malformed Unicode`);
  }
}

function assertIdentityString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function assertPlainRecord(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be a plain object`);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError(`${name} must be a plain object`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  name: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new TypeError(`${name} contains unknown field ${JSON.stringify(key)}`);
  }
  for (const key of required) {
    if (!(key in value)) throw new TypeError(`${name}.${key} is required`);
  }
}
