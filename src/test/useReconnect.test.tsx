// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

import { useReconnect } from "@/components/ssh/hooks/useReconnect";

function setup(max = 3) {
  const onReconnecting = vi.fn();
  const onGaveUp = vi.fn();
  const hook = renderHook(() =>
    useReconnect({ max, onReconnecting, onGaveUp }),
  );
  return { onReconnecting, onGaveUp, r: () => hook.result.current, hook };
}

describe("useReconnect", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does not reconnect a socket that never connected", () => {
    // No markConnected / prior schedule → a close should not trigger a retry.
    const { r } = setup();
    let shouldReconnect = true;
    act(() => {
      shouldReconnect = r().beginReconnectAfterDrop();
    });
    expect(shouldReconnect).toBe(false);
  });

  it("reconnects a dropped live session and fires the retry after the backoff", () => {
    const { r, onReconnecting } = setup();
    const retry = vi.fn();
    act(() => r().markConnected());
    // A live drop should ask to reconnect.
    let shouldReconnect = false;
    act(() => {
      shouldReconnect = r().beginReconnectAfterDrop();
    });
    expect(shouldReconnect).toBe(true);
    act(() => r().schedule(retry, true));
    expect(onReconnecting).toHaveBeenCalledWith(1, 3, expect.any(Number));
    // Retry only runs once the backoff timer elapses.
    expect(retry).not.toHaveBeenCalled();
    act(() => vi.runAllTimers());
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("keeps reconnecting across failed attempts, then gives up at the max", () => {
    const { r, onReconnecting, onGaveUp } = setup(3);
    act(() => r().markConnected());
    const retry = vi.fn();
    // Simulate: drop → schedule → timer fires → socket closes again (still in
    // flight because a scheduled reconnect set the flag), three times.
    for (let i = 1; i <= 3; i++) {
      act(() => {
        expect(r().beginReconnectAfterDrop()).toBe(true);
        r().schedule(retry, true);
      });
      expect(onReconnecting).toHaveBeenNthCalledWith(
        i,
        i,
        3,
        expect.any(Number),
      );
      act(() => vi.runAllTimers());
    }
    // A 4th drop exhausts the budget → give up, no further onReconnecting.
    act(() => {
      expect(r().beginReconnectAfterDrop()).toBe(true);
      r().schedule(retry, true);
    });
    expect(onGaveUp).toHaveBeenCalledTimes(1);
    expect(onReconnecting).toHaveBeenCalledTimes(3);
  });

  it("gives up immediately when there are no details to retry", () => {
    const { r, onGaveUp, onReconnecting } = setup();
    act(() => r().markConnected());
    const retry = vi.fn();
    act(() => {
      r().beginReconnectAfterDrop();
      r().schedule(retry, false); // canRetry = false (no lastDetails)
    });
    expect(onGaveUp).toHaveBeenCalledTimes(1);
    expect(onReconnecting).not.toHaveBeenCalled();
    act(() => vi.runAllTimers());
    expect(retry).not.toHaveBeenCalled();
  });

  it("markConnected resets the attempt counter so a later drop starts fresh", () => {
    const { r, onReconnecting } = setup(3);
    act(() => r().markConnected());
    const retry = vi.fn();
    // Burn two attempts.
    act(() => r().schedule(retry, true));
    act(() => vi.runAllTimers());
    act(() => r().schedule(retry, true));
    act(() => vi.runAllTimers());
    expect(onReconnecting).toHaveBeenLastCalledWith(2, 3, expect.any(Number));
    // A successful connect resets, so the next scheduled attempt is #1 again.
    act(() => r().markConnected());
    act(() => r().schedule(retry, true));
    expect(onReconnecting).toHaveBeenLastCalledWith(1, 3, expect.any(Number));
  });

  it("cancelPending clears a scheduled retry", () => {
    const { r } = setup();
    const retry = vi.fn();
    act(() => {
      r().markConnected();
      r().schedule(retry, true);
    });
    act(() => r().cancelPending());
    act(() => vi.runAllTimers());
    expect(retry).not.toHaveBeenCalled();
  });

  it("resetForConnect cancels a pending retry and clears in-flight state", () => {
    const { r } = setup();
    const retry = vi.fn();
    act(() => {
      r().markConnected();
      r().schedule(retry, true);
    });
    act(() => r().resetForConnect());
    act(() => vi.runAllTimers());
    expect(retry).not.toHaveBeenCalled();
    // After a full reset, a bare close is treated as a never-connected socket.
    let shouldReconnect = true;
    act(() => {
      shouldReconnect = r().beginReconnectAfterDrop();
    });
    expect(shouldReconnect).toBe(false);
  });

  it("returns a stable controller object across renders", () => {
    const { r, hook } = setup();
    const first = r();
    act(() => hook.rerender());
    expect(r()).toBe(first);
  });
});
