import { useCallback, useRef } from "react";

/** One queued upload: the remote path and the byte offset to (re)start from. */
export interface UploadJob {
  path: string;
  startOffset: number;
}

/**
 * The concurrency-limited upload queue, extracted from `SshSession`.
 *
 * Dropping a folder of hundreds of files should not read them all into memory
 * or open hundreds of streams at once, so uploads are bounded to `maxInFlight`:
 * the rest wait in a FIFO queue and start as slots free. Each started upload
 * releases its slot when it finishes (via {@link UploadQueue.onReleased}), which
 * pumps the next job.
 *
 * `start` is injected late with {@link UploadQueue.setStart} — the WebSocket
 * message handler needs `enqueue` before the component's `runUpload` exists, so
 * the hook holds the starter in a ref (this replaces the old `pumpUploadsRef`
 * indirection). `start` returns whether the job actually began: a job that was
 * cancelled or is already running is skipped **without** consuming a slot, so
 * the caller returns `false` for it. The hook owns only the queue + in-flight
 * accounting; the per-file control/progress state stays in the component.
 */
export interface UploadQueue {
  /** Set the starter that actually begins a job. Returns true if a slot was used. */
  setStart: (start: (job: UploadJob) => boolean) => void;
  /** Queue a job and pump (starts it now if a slot is free). */
  enqueue: (job: UploadJob) => void;
  /** Call when a started upload finishes/aborts to free its slot and pump. */
  onReleased: () => void;
  /** Drop queued jobs matching a predicate (e.g. a cancelled path). */
  remove: (keep: (job: UploadJob) => boolean) => void;
  /** Clear the queue and in-flight count (logout / teardown). */
  reset: () => void;
}

export function useUploadQueue(maxInFlight: number): UploadQueue {
  const queue = useRef<UploadJob[]>([]);
  const inFlight = useRef(0);
  const startRef = useRef<(job: UploadJob) => boolean>(() => false);

  const pump = useCallback(() => {
    while (inFlight.current < maxInFlight && queue.current.length > 0) {
      const job = queue.current.shift()!;
      // A cancelled/already-running job is skipped without consuming a slot.
      if (startRef.current(job)) inFlight.current += 1;
    }
  }, [maxInFlight]);

  const setStart = useCallback((start: (job: UploadJob) => boolean) => {
    startRef.current = start;
  }, []);

  const enqueue = useCallback(
    (job: UploadJob) => {
      queue.current.push(job);
      pump();
    },
    [pump],
  );

  const onReleased = useCallback(() => {
    inFlight.current = Math.max(0, inFlight.current - 1);
    pump();
  }, [pump]);

  const remove = useCallback((keep: (job: UploadJob) => boolean) => {
    queue.current = queue.current.filter(keep);
  }, []);

  const reset = useCallback(() => {
    queue.current = [];
    inFlight.current = 0;
  }, []);

  return { setStart, enqueue, onReleased, remove, reset };
}
