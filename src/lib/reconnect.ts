/**
 * Pure reconnect policy for a dropped SSH session.
 *
 * Extracted from `SshSession` (which previously open-coded the attempt gating
 * and the backoff delay inline in `scheduleReconnect`) so the schedule is a
 * small, unit-tested unit — the same "pure logic in `src/lib`" discipline as the
 * caches. The component keeps the *side effects* (timers, socket, status state)
 * and the "do we still have credentials to reconnect with" check; this module
 * only answers "given N failed attempts so far, do we try again, and after how
 * long?".
 */

/** Base delay for the first reconnect attempt (ms). */
export const DEFAULT_RECONNECT_BASE_MS = 1000;
/** Ceiling the exponential backoff never exceeds (ms). */
export const DEFAULT_RECONNECT_MAX_MS = 8000;

export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
}

/**
 * Exponential backoff for the 1-based reconnect attempt number: the delay
 * doubles each attempt (`base · 2^(attempt-1)`), capped at `maxMs`. Attempt
 * numbers below 1 have no wait.
 */
export function reconnectBackoffMs(
  attempt: number,
  { baseMs = DEFAULT_RECONNECT_BASE_MS, maxMs = DEFAULT_RECONNECT_MAX_MS }: BackoffOptions = {},
): number {
  if (attempt < 1) return 0;
  return Math.min(baseMs * 2 ** (attempt - 1), maxMs);
}

export type ReconnectPlan =
  | { reconnect: false }
  | { reconnect: true; attempt: number; delayMs: number };

/**
 * Decide the next reconnect step. Given the number of attempts already made
 * (`currentAttempt`, 0 before the first retry) and the ceiling `maxAttempts`,
 * returns `{ reconnect: false }` once the ceiling is passed, otherwise the
 * next 1-based attempt number and its backoff delay.
 */
export function planReconnect(
  currentAttempt: number,
  maxAttempts: number,
  opts: BackoffOptions = {},
): ReconnectPlan {
  const attempt = currentAttempt + 1;
  if (attempt > maxAttempts) return { reconnect: false };
  return { reconnect: true, attempt, delayMs: reconnectBackoffMs(attempt, opts) };
}
