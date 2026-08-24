import { useCallback, useRef } from "react";

/** One queued download: the remote path and the byte offset to (re)start from
 * (0 for a fresh download, > 0 for a resume after a dropped connection). */
export interface DownloadJob {
  path: string;
  resumeOffset: number;
}

/**
 * The concurrency-limited download queue (#74) — the symmetric counterpart of
 * {@link import("./useUploadQueue").useUploadQueue}.
 *
 * Firing several plain file downloads at once should not open an unbounded
 * number of streams (and hit the bridge's per-session transfer cap), so
 * downloads are bounded to `maxInFlight`: the rest wait in a FIFO queue and
 * start as slots free. Each started download releases its slot when it finishes,
 * aborts, or errors (via {@link DownloadQueue.onReleased}), which pumps the next
 * job.
 *
 * `start` is injected with {@link DownloadQueue.setStart}; it returns whether the
 * job actually began (a cancelled/already-running job is skipped without
 * consuming a slot). The hook owns only the queue + in-flight accounting; the
 * per-file control/progress state stays with the caller. Mirrors `useUploadQueue`
 * so the two transfer schedulers stay one design.
 */
export interface DownloadQueue {
  /** Set the starter that actually begins a job. Returns true if a slot was used. */
  setStart: (start: (job: DownloadJob) => boolean) => void;
  /** Queue a job and pump (starts it now if a slot is free). */
  enqueue: (job: DownloadJob) => void;
  /** Call when a started download finishes/aborts/errors to free its slot. */
  onReleased: () => void;
  /** Drop queued jobs matching a predicate (e.g. a cancelled path). */
  remove: (keep: (job: DownloadJob) => boolean) => void;
  /** Clear the queue and in-flight count (a dropped socket / logout). */
  reset: () => void;
}

export function useDownloadQueue(maxInFlight: number): DownloadQueue {
  const queue = useRef<DownloadJob[]>([]);
  const inFlight = useRef(0);
  const startRef = useRef<(job: DownloadJob) => boolean>(() => false);

  const pump = useCallback(() => {
    while (inFlight.current < maxInFlight && queue.current.length > 0) {
      const job = queue.current.shift()!;
      // A cancelled/already-running job is skipped without consuming a slot.
      if (startRef.current(job)) inFlight.current += 1;
    }
  }, [maxInFlight]);

  const setStart = useCallback((start: (job: DownloadJob) => boolean) => {
    startRef.current = start;
  }, []);

  const enqueue = useCallback(
    (job: DownloadJob) => {
      queue.current.push(job);
      pump();
    },
    [pump],
  );

  const onReleased = useCallback(() => {
    inFlight.current = Math.max(0, inFlight.current - 1);
    pump();
  }, [pump]);

  const remove = useCallback((keep: (job: DownloadJob) => boolean) => {
    queue.current = queue.current.filter(keep);
  }, []);

  const reset = useCallback(() => {
    queue.current = [];
    inFlight.current = 0;
  }, []);

  return { setStart, enqueue, onReleased, remove, reset };
}
