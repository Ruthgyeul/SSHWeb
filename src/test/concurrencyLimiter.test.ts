import { describe, expect, it } from "vitest";
import {
  createConcurrencyLimiter,
  QueueFullError,
} from "@/lib/concurrencyLimiter";

/** A deferred promise + its resolver, for driving task completion by hand. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Let all pending microtasks (and thus the limiter's queue pump) settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("createConcurrencyLimiter", () => {
  it("runs at most maxConcurrent tasks at once", async () => {
    const limiter = createConcurrencyLimiter(2);
    const gates = [deferred(), deferred(), deferred()];
    let started = 0;

    const runs = gates.map((g) =>
      limiter.run(async () => {
        started += 1;
        await g.promise;
      }),
    );

    // Only two start immediately; the third waits for a slot.
    await flush();
    expect(started).toBe(2);
    expect(limiter.active).toBe(2);
    expect(limiter.queued).toBe(1);

    // Finish one → the queued task starts.
    gates[0].resolve();
    await flush();
    expect(started).toBe(3);

    gates[1].resolve();
    gates[2].resolve();
    await Promise.all(runs);
    expect(limiter.active).toBe(0);
    expect(limiter.queued).toBe(0);
  });

  it("rejects with QueueFullError once the queue is full", async () => {
    const limiter = createConcurrencyLimiter(1, 1); // 1 running + 1 queued max
    const gate = deferred();
    const running = limiter.run(() => gate.promise); // occupies the slot
    const queued = limiter.run(() => Promise.resolve("q")); // fills the queue

    await expect(
      limiter.run(() => Promise.resolve("x")),
    ).rejects.toBeInstanceOf(QueueFullError);

    gate.resolve();
    await running;
    await expect(queued).resolves.toBe("q");
  });

  it("propagates task results and errors", async () => {
    const limiter = createConcurrencyLimiter(2);
    await expect(limiter.run(() => 42)).resolves.toBe(42);
    await expect(
      limiter.run(() => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");
  });

  it("keeps draining the queue after a task throws", async () => {
    const limiter = createConcurrencyLimiter(1);
    const bad = limiter.run(() => {
      throw new Error("nope");
    });
    const good = limiter.run(() => "ok");
    await expect(bad).rejects.toThrow("nope");
    await expect(good).resolves.toBe("ok");
    expect(limiter.active).toBe(0);
  });
});
