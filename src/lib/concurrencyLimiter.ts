/**
 * A tiny async concurrency limiter: run at most `maxConcurrent` tasks at once,
 * queueing the rest, and rejecting new work once the queue reaches `maxQueue`
 * so a flood can't grow the queue without bound.
 *
 * The SSH bridge uses this to cap expensive, client-triggered work — grid
 * thumbnails (each reads a whole file and runs sharp/ffmpeg) and recursive
 * find/grep searches — so a client firing hundreds in parallel can't exhaust
 * the single shared process's memory and CPU. It's hand-mirrored in `server.mjs`
 * (server-only code that can't import this module); this copy is the unit-tested
 * source of truth for the queueing logic.
 */
export interface ConcurrencyLimiter {
  /** Run `task` when a slot is free. Rejects with {@link QueueFullError} if the
   * queue is already at `maxQueue`. */
  run<T>(task: () => Promise<T> | T): Promise<T>;
  /** Tasks currently running. */
  readonly active: number;
  /** Tasks waiting for a slot. */
  readonly queued: number;
}

/** Thrown by `run` when the queue is full, so the caller can shed load. */
export class QueueFullError extends Error {
  constructor() {
    super("concurrency limiter queue is full");
    this.name = "QueueFullError";
  }
}

interface Job {
  task: () => unknown;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
}

export function createConcurrencyLimiter(
  maxConcurrent: number,
  maxQueue = Number.POSITIVE_INFINITY,
): ConcurrencyLimiter {
  const limit = Math.max(1, Math.floor(maxConcurrent));
  let active = 0;
  const queue: Job[] = [];

  const pump = () => {
    while (active < limit && queue.length > 0) {
      const job = queue.shift()!;
      active += 1;
      Promise.resolve()
        .then(job.task)
        .then(job.resolve, job.reject)
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  };

  return {
    run<T>(task: () => Promise<T> | T): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        if (queue.length >= maxQueue) {
          reject(new QueueFullError());
          return;
        }
        queue.push({
          task: task as () => unknown,
          resolve: resolve as (value: unknown) => void,
          reject,
        });
        pump();
      });
    },
    get active() {
      return active;
    },
    get queued() {
      return queue.length;
    },
  };
}
