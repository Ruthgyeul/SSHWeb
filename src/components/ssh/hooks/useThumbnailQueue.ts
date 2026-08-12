import { useCallback, useRef } from "react";

import type { ClientMessage } from "@/lib/sshProtocol";

/**
 * The grid-thumbnail request scheduler, extracted from `SshSession`.
 *
 * A folder can hold hundreds of tiles, so thumbnail reads are **deduped**,
 * **concurrency-limited** (`maxInFlight`), and served **visible-first**: after a
 * fast scroll the tiles currently in/near the viewport paint before ones that
 * scrolled past, falling back to FIFO when nothing queued is visible. Each served
 * request goes out as an `sftp-read` with `thumb: true`; the reply (even an empty
 * skip) must call {@link ThumbnailQueue.onReplied} so the freed slot pumps the
 * next request and the queue never stalls.
 *
 * This owns only the *scheduling* state (dedupe set, visibility set, in-flight
 * count, pending queue). The decoded tiles themselves live in the component. The
 * logic is unit-tested via `renderHook` with a mock `send`.
 */
export interface ThumbnailQueue {
  /** Queue a thumbnail read for `path` (at most once — repeats are ignored). */
  request: (path: string) => void;
  /** Report whether a tile is currently in/near the viewport (visible-first). */
  setVisible: (path: string, visible: boolean) => void;
  /** Call when a `thumb` reply arrives (success, skip, or error) to free a slot. */
  onReplied: () => void;
  /** Drop all scheduling state (directory change, sudo toggle, logout). */
  reset: () => void;
}

export function useThumbnailQueue(
  send: (msg: ClientMessage) => void,
  maxInFlight: number,
): ThumbnailQueue {
  const requested = useRef<Set<string>>(new Set());
  const visible = useRef<Set<string>>(new Set());
  const inFlight = useRef(0);
  const queue = useRef<string[]>([]);

  const pump = useCallback(() => {
    while (inFlight.current < maxInFlight && queue.current.length > 0) {
      const q = queue.current;
      // Serve a currently-visible tile first; otherwise the oldest queued one.
      let idx = q.findIndex((p) => visible.current.has(p));
      if (idx < 0) idx = 0;
      const path = q.splice(idx, 1)[0];
      inFlight.current += 1;
      send({ t: "sftp-read", path, thumb: true });
    }
  }, [send, maxInFlight]);

  const request = useCallback(
    (path: string) => {
      if (requested.current.has(path)) return;
      requested.current.add(path);
      queue.current.push(path);
      pump();
    },
    [pump],
  );

  const setVisible = useCallback((path: string, isVisible: boolean) => {
    if (isVisible) visible.current.add(path);
    else visible.current.delete(path);
  }, []);

  const onReplied = useCallback(() => {
    inFlight.current = Math.max(0, inFlight.current - 1);
    pump();
  }, [pump]);

  const reset = useCallback(() => {
    requested.current = new Set();
    visible.current.clear();
    queue.current = [];
    inFlight.current = 0;
  }, []);

  return { request, setVisible, onReplied, reset };
}
