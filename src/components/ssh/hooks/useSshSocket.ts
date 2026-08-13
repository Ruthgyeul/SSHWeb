import { useCallback, useEffect, useRef, type RefObject } from "react";

import { SSH_WS_PATH } from "@/config/siteConfig";
import { parseMessage, type ServerMessage } from "@/lib/sshProtocol";
import type { ConnectDetails } from "../ConnectForm";
import type { Reconnect } from "./useReconnect";

/**
 * The bridge WebSocket lifecycle for an `SshSession`, extracted from the
 * component.
 *
 * Owns opening the socket and wiring its four handlers, and — on an unexpected
 * close — deciding via the {@link Reconnect} controller whether to schedule a
 * retry (through the internal `openSocketRef`, which breaks the open ↔ retry
 * cycle) or surface a hard failure. Everything the socket needs from the wider
 * session is injected as callbacks, so this hook stays free of session-state
 * knowledge:
 *  - `onOpen(details)` — sends the `connect` handshake (with the terminal size),
 *  - `onMessage(msg)` — the parsed server-message handler,
 *  - `onNeverConnected()` — a socket that closed before ever connecting
 *    (auth/host failure; don't loop),
 *  - `onSocketError()` — a transport-level error.
 *
 * The component keeps `wsRef` (so its `send` and readyState checks are
 * unchanged) and the `userClosed` / `lastDetails` refs (connection intent and
 * identity), passing them in. Covered by a `renderHook` suite against a mock
 * `WebSocket`.
 */
export interface SshSocketOptions {
  /** The live socket ref, owned by the component (its `send` reads it). */
  wsRef: RefObject<WebSocket | null>;
  /** The auto-reconnect controller (see `useReconnect`). */
  reconnect: Reconnect;
  /** True once the user explicitly disconnected — suppresses reconnect. */
  userClosedRef: RefObject<boolean>;
  /** The last connect details, used to retry a dropped socket. */
  lastDetailsRef: RefObject<ConnectDetails | null>;
  /** Handle a parsed server message. */
  onMessage: (msg: ServerMessage) => void;
  /** Socket opened — send the `connect` handshake. */
  onOpen: (details: ConnectDetails) => void;
  /** Socket closed before ever connecting (auth/host failure). */
  onNeverConnected: () => void;
  /** Transport-level socket error. */
  onSocketError: () => void;
}

export interface SshSocket {
  /** Open a socket and start the handshake (first connect and each retry). */
  openSocket: (details: ConnectDetails) => void;
}

export function useSshSocket(options: SshSocketOptions): SshSocket {
  // Keep the latest options in a ref so the returned openSocket stays stable
  // while still calling current closures.
  const optsRef = useRef(options);
  useEffect(() => {
    optsRef.current = options;
  });

  // openSocket and the reconnect timer reference each other; a ref breaks the
  // cycle (the backoff timer retries via the latest openSocket through this ref).
  const openSocketRef = useRef<((details: ConnectDetails) => void) | null>(null);

  // Schedule the next auto-reconnect attempt (or give up), retrying via the
  // latest openSocket only while we still hold connection details.
  const scheduleReconnect = useCallback(() => {
    const { reconnect, lastDetailsRef } = optsRef.current;
    reconnect.schedule(() => {
      if (lastDetailsRef.current) openSocketRef.current?.(lastDetailsRef.current);
    }, !!lastDetailsRef.current);
  }, []);

  const openSocket = useCallback(
    (details: ConnectDetails) => {
      const {
        wsRef,
        reconnect,
        userClosedRef,
        onMessage,
        onOpen,
        onNeverConnected,
        onSocketError,
      } = optsRef.current;

      const scheme = window.location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(
        `${scheme}://${window.location.host}${SSH_WS_PATH}`,
      );
      wsRef.current = ws;

      ws.onopen = () => onOpen(details);
      ws.onmessage = (event) => {
        const msg = parseMessage<ServerMessage>(String(event.data));
        if (msg) onMessage(msg);
      };
      ws.onclose = () => {
        wsRef.current = null;
        if (userClosedRef.current) return; // disconnect() owns the state
        if (reconnect.beginReconnectAfterDrop()) {
          // A live session dropped — try to bring it back.
          scheduleReconnect();
        } else {
          // Never reached "connected" → auth/host failure; don't loop.
          onNeverConnected();
        }
      };
      ws.onerror = () => onSocketError();
    },
    [scheduleReconnect],
  );

  // Keep the ref pointing at the latest openSocket for the reconnect retry.
  useEffect(() => {
    openSocketRef.current = openSocket;
  }, [openSocket]);

  return { openSocket };
}
