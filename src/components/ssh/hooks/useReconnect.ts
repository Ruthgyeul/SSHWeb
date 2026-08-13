import { useCallback, useEffect, useMemo, useRef } from "react";

import { planReconnect } from "@/lib/reconnect";

/**
 * The auto-reconnect controller for an `SshSession`, extracted from the socket
 * lifecycle.
 *
 * Owns the reconnect bookkeeping — the attempt counter, the "was ever
 * connected" and "a reconnect is in flight" flags, and the backoff timer — and
 * drives them through the pure `planReconnect` (in `src/lib/reconnect.ts`). The
 * socket open itself and the connection details stay in the component; this hook
 * decides *whether* and *when* to retry and reports the outcome through the
 * injected `onReconnecting` / `onGaveUp` status callbacks.
 *
 * The transitions are:
 *  - {@link Reconnect.markConnected} on a successful connect (stop retrying,
 *    reset the attempt counter),
 *  - {@link Reconnect.beginReconnectAfterDrop} + {@link Reconnect.schedule} when
 *    a live socket closes unexpectedly,
 *  - {@link Reconnect.resetForConnect} for a fresh user-initiated connect,
 *  - {@link Reconnect.resetAttempts} for a manual "reconnect now",
 *  - {@link Reconnect.cancelPending} when the user disconnects (or on unmount).
 *
 * Covered by a `renderHook` suite driven with fake timers.
 */
export interface ReconnectOptions {
  /** Max auto-reconnect attempts before giving up. */
  max: number;
  /** Called when an attempt is scheduled — drive the "reconnecting" status. */
  onReconnecting: (attempt: number, max: number, delayMs: number) => void;
  /** Called when retries are exhausted (or impossible) — drive the "dropped" status. */
  onGaveUp: () => void;
}

export interface Reconnect {
  /** Note a successful connect: stop reconnecting and reset the attempt counter. */
  markConnected: () => void;
  /** A live socket closed. Returns whether it should trigger a reconnect (i.e. the
   * session had connected, or a reconnect was already in flight); clears the
   * "was connected" flag so a subsequent failed attempt still counts as in-flight. */
  beginReconnectAfterDrop: () => boolean;
  /** Schedule the next attempt (or give up if the backoff plan or `canRetry` says
   * so). `retry` runs when the backoff timer fires. */
  schedule: (retry: () => void, canRetry: boolean) => void;
  /** Cancel a pending timer and clear the reconnecting flag (user disconnect). */
  cancelPending: () => void;
  /** Reset all bookkeeping for a fresh, user-initiated connect. */
  resetForConnect: () => void;
  /** Reset just the attempt counter (a manual "reconnect now" starts backoff fresh). */
  resetAttempts: () => void;
}

export function useReconnect(options: ReconnectOptions): Reconnect {
  // Keep the latest options in a ref so the returned callbacks stay stable while
  // still calling the current status closures.
  const optsRef = useRef(options);
  useEffect(() => {
    optsRef.current = options;
  });

  const attemptRef = useRef(0);
  const reconnectingRef = useRef(false);
  const wasConnectedRef = useRef(false);
  const timerRef = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const markConnected = useCallback(() => {
    wasConnectedRef.current = true;
    reconnectingRef.current = false;
    attemptRef.current = 0;
  }, []);

  const beginReconnectAfterDrop = useCallback(() => {
    const shouldReconnect = wasConnectedRef.current || reconnectingRef.current;
    // A live session dropped — consume the "was connected" flag so a follow-up
    // failed attempt still reads as a reconnect in flight.
    if (shouldReconnect) wasConnectedRef.current = false;
    return shouldReconnect;
  }, []);

  const schedule = useCallback((retry: () => void, canRetry: boolean) => {
    const { max, onReconnecting, onGaveUp } = optsRef.current;
    const plan = planReconnect(attemptRef.current, max);
    if (!plan.reconnect || !canRetry) {
      reconnectingRef.current = false;
      onGaveUp();
      return;
    }
    attemptRef.current = plan.attempt;
    reconnectingRef.current = true;
    onReconnecting(plan.attempt, max, plan.delayMs);
    timerRef.current = window.setTimeout(retry, plan.delayMs);
  }, []);

  const cancelPending = useCallback(() => {
    clearTimer();
    reconnectingRef.current = false;
  }, [clearTimer]);

  const resetForConnect = useCallback(() => {
    clearTimer();
    wasConnectedRef.current = false;
    reconnectingRef.current = false;
    attemptRef.current = 0;
  }, [clearTimer]);

  const resetAttempts = useCallback(() => {
    attemptRef.current = 0;
  }, []);

  // Stable object identity (all methods are stable) so callers can list the
  // controller in effect/callback deps without churning every render.
  return useMemo(
    () => ({
      markConnected,
      beginReconnectAfterDrop,
      schedule,
      cancelPending,
      resetForConnect,
      resetAttempts,
    }),
    [markConnected, beginReconnectAfterDrop, schedule, cancelPending, resetForConnect, resetAttempts],
  );
}
