import { describe, it, expect } from "vitest";

import {
  reconnectBackoffMs,
  planReconnect,
  DEFAULT_RECONNECT_BASE_MS,
  DEFAULT_RECONNECT_MAX_MS,
} from "@/lib/reconnect";

describe("reconnectBackoffMs", () => {
  it("doubles each attempt from the base delay", () => {
    // Locks the exact schedule SshSession used inline: 1000·2^(n-1).
    expect(reconnectBackoffMs(1)).toBe(1000);
    expect(reconnectBackoffMs(2)).toBe(2000);
    expect(reconnectBackoffMs(3)).toBe(4000);
    expect(reconnectBackoffMs(4)).toBe(8000);
  });

  it("caps at the max delay for high attempt numbers", () => {
    expect(reconnectBackoffMs(5)).toBe(DEFAULT_RECONNECT_MAX_MS); // 16000 → 8000
    expect(reconnectBackoffMs(10)).toBe(DEFAULT_RECONNECT_MAX_MS);
  });

  it("has no wait for attempt numbers below 1", () => {
    expect(reconnectBackoffMs(0)).toBe(0);
    expect(reconnectBackoffMs(-3)).toBe(0);
  });

  it("honors custom base and max", () => {
    expect(reconnectBackoffMs(1, { baseMs: 500 })).toBe(500);
    expect(reconnectBackoffMs(3, { baseMs: 500 })).toBe(2000);
    expect(reconnectBackoffMs(9, { baseMs: 500, maxMs: 3000 })).toBe(3000);
  });

  it("defaults match the exported constants", () => {
    expect(reconnectBackoffMs(1)).toBe(DEFAULT_RECONNECT_BASE_MS);
  });
});

describe("planReconnect", () => {
  it("schedules the next attempt with its backoff while under the ceiling", () => {
    // MAX_RECONNECT is 3 in SshSession: attempts 1..3 retry, then give up.
    expect(planReconnect(0, 3)).toEqual({
      reconnect: true,
      attempt: 1,
      delayMs: 1000,
    });
    expect(planReconnect(1, 3)).toEqual({
      reconnect: true,
      attempt: 2,
      delayMs: 2000,
    });
    expect(planReconnect(2, 3)).toEqual({
      reconnect: true,
      attempt: 3,
      delayMs: 4000,
    });
  });

  it("gives up once the ceiling is passed", () => {
    // The 4th would-be attempt (currentAttempt 3, max 3) stops reconnecting.
    expect(planReconnect(3, 3)).toEqual({ reconnect: false });
    expect(planReconnect(10, 3)).toEqual({ reconnect: false });
  });

  it("never retries when the ceiling is zero", () => {
    expect(planReconnect(0, 0)).toEqual({ reconnect: false });
  });

  it("passes backoff options through to the delay", () => {
    expect(planReconnect(0, 3, { baseMs: 250 })).toEqual({
      reconnect: true,
      attempt: 1,
      delayMs: 250,
    });
  });
});
