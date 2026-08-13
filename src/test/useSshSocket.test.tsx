// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { createRef } from "react";

import {
  useSshSocket,
  type SshSocketOptions,
} from "@/components/ssh/hooks/useSshSocket";
import type { Reconnect } from "@/components/ssh/hooks/useReconnect";
import type { ConnectDetails } from "@/components/ssh/ConnectForm";
import { encodeMessage } from "@/lib/sshProtocol";

/** A mock WebSocket that records instances and lets tests fire its handlers. */
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static readonly OPEN = 1;
  url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  send = vi.fn();
  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }
  /** The most recently constructed socket. */
  static last() {
    return MockWebSocket.instances[MockWebSocket.instances.length - 1];
  }
}

const DETAILS: ConnectDetails = {
  host: "example.com",
  port: 22,
  username: "alice",
  password: "pw",
};

function fakeReconnect(over: Partial<Reconnect> = {}): Reconnect {
  return {
    markConnected: vi.fn(),
    beginReconnectAfterDrop: vi.fn(() => false),
    schedule: vi.fn(),
    cancelPending: vi.fn(),
    resetForConnect: vi.fn(),
    resetAttempts: vi.fn(),
    ...over,
  };
}

function setup(over: Partial<SshSocketOptions> = {}) {
  const opts: SshSocketOptions = {
    wsRef: createRef<WebSocket | null>(),
    reconnect: fakeReconnect(),
    userClosedRef: { current: false },
    lastDetailsRef: { current: DETAILS },
    onMessage: vi.fn(),
    onOpen: vi.fn(),
    onNeverConnected: vi.fn(),
    onSocketError: vi.fn(),
    ...over,
  };
  const hook = renderHook(() => useSshSocket(opts));
  return { opts, socket: () => hook.result.current };
}

describe("useSshSocket", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("opens a socket, stores it in wsRef, and targets the ws path", () => {
    const { opts, socket } = setup();
    socket().openSocket(DETAILS);
    const ws = MockWebSocket.last();
    expect(opts.wsRef.current).toBe(ws as unknown as WebSocket);
    // jsdom serves over http → ws:// scheme; default path is /api/ssh.
    expect(ws.url).toBe(`ws://${window.location.host}/api/ssh`);
  });

  it("sends the handshake via onOpen when the socket opens", () => {
    const { opts, socket } = setup();
    socket().openSocket(DETAILS);
    MockWebSocket.last().onopen?.();
    expect(opts.onOpen).toHaveBeenCalledWith(DETAILS);
  });

  it("parses incoming frames and forwards them to onMessage", () => {
    const { opts, socket } = setup();
    socket().openSocket(DETAILS);
    MockWebSocket.last().onmessage?.({ data: encodeMessage({ t: "pong", ts: 5 }) });
    expect(opts.onMessage).toHaveBeenCalledWith({ t: "pong", ts: 5 });
    // A garbage frame is dropped, not forwarded.
    (opts.onMessage as ReturnType<typeof vi.fn>).mockClear();
    MockWebSocket.last().onmessage?.({ data: "not json" });
    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it("on an unexpected close of a live session, schedules a reconnect", () => {
    const reconnect = fakeReconnect({ beginReconnectAfterDrop: vi.fn(() => true) });
    const { opts, socket } = setup({ reconnect });
    socket().openSocket(DETAILS);
    MockWebSocket.last().onclose?.();
    expect(opts.wsRef.current).toBeNull();
    expect(reconnect.schedule).toHaveBeenCalledTimes(1);
    expect(opts.onNeverConnected).not.toHaveBeenCalled();
  });

  it("on a close that never connected, reports a hard failure", () => {
    const reconnect = fakeReconnect({ beginReconnectAfterDrop: vi.fn(() => false) });
    const { opts, socket } = setup({ reconnect });
    socket().openSocket(DETAILS);
    MockWebSocket.last().onclose?.();
    expect(opts.onNeverConnected).toHaveBeenCalledTimes(1);
    expect(reconnect.schedule).not.toHaveBeenCalled();
  });

  it("suppresses reconnect handling when the user closed the socket", () => {
    const reconnect = fakeReconnect({ beginReconnectAfterDrop: vi.fn(() => true) });
    const { opts, socket } = setup({
      reconnect,
      userClosedRef: { current: true },
    });
    socket().openSocket(DETAILS);
    MockWebSocket.last().onclose?.();
    expect(opts.wsRef.current).toBeNull();
    expect(reconnect.schedule).not.toHaveBeenCalled();
    expect(opts.onNeverConnected).not.toHaveBeenCalled();
  });

  it("the scheduled retry reopens a fresh socket via the latest openSocket", () => {
    const reconnect = fakeReconnect({ beginReconnectAfterDrop: vi.fn(() => true) });
    const { opts, socket } = setup({ reconnect });
    socket().openSocket(DETAILS);
    MockWebSocket.last().onclose?.();
    // Capture and invoke the retry callback schedule() was handed.
    const retry = (reconnect.schedule as ReturnType<typeof vi.fn>).mock.calls[0][0] as () => void;
    const before = MockWebSocket.instances.length;
    retry();
    expect(MockWebSocket.instances.length).toBe(before + 1);
    expect(opts.wsRef.current).toBe(MockWebSocket.last() as unknown as WebSocket);
  });

  it("reports transport errors via onSocketError", () => {
    const { opts, socket } = setup();
    socket().openSocket(DETAILS);
    MockWebSocket.last().onerror?.();
    expect(opts.onSocketError).toHaveBeenCalledTimes(1);
  });
});
