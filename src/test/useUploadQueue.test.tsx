// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

import {
  useUploadQueue,
  type UploadJob,
} from "@/components/ssh/hooks/useUploadQueue";

function job(path: string, startOffset = 0): UploadJob {
  return { path, startOffset };
}

/** A queue whose starter always begins the job (consumes a slot). */
function setup(maxInFlight = 2) {
  const started: string[] = [];
  const start = vi.fn((j: UploadJob) => {
    started.push(j.path);
    return true;
  });
  const hook = renderHook(() => useUploadQueue(maxInFlight));
  act(() => hook.result.current.setStart(start));
  return { start, started, q: () => hook.result.current };
}

describe("useUploadQueue", () => {
  it("starts jobs up to the concurrency limit, queueing the rest", () => {
    const { start, started, q } = setup(2);
    act(() => {
      q().enqueue(job("a"));
      q().enqueue(job("b"));
      q().enqueue(job("c")); // over the limit
    });
    expect(started).toEqual(["a", "b"]);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("pumps the next queued job when a slot is released", () => {
    const { started, q } = setup(2);
    act(() => {
      q().enqueue(job("a"));
      q().enqueue(job("b"));
      q().enqueue(job("c"));
    });
    expect(started).toEqual(["a", "b"]);
    act(() => q().onReleased());
    expect(started).toEqual(["a", "b", "c"]);
  });

  it("passes the job's startOffset through to the starter", () => {
    const { start, q } = setup(1);
    act(() => q().enqueue(job("resume.bin", 4096)));
    expect(start).toHaveBeenCalledWith({
      path: "resume.bin",
      startOffset: 4096,
    });
  });

  it("skips a job the starter rejects without consuming a slot", () => {
    const started: string[] = [];
    // "b" is cancelled/running → starter returns false (no slot used).
    const start = vi.fn((j: UploadJob) => {
      if (j.path === "b") return false;
      started.push(j.path);
      return true;
    });
    const hook = renderHook(() => useUploadQueue(1));
    act(() => hook.result.current.setStart(start));
    act(() => {
      hook.result.current.enqueue(job("a")); // starts, slot used
      hook.result.current.enqueue(job("b")); // queued
      hook.result.current.enqueue(job("c")); // queued
    });
    expect(started).toEqual(["a"]);
    act(() => hook.result.current.onReleased()); // frees the "a" slot
    // Draining continues past the rejected "b" (no slot) straight to "c".
    expect(started).toEqual(["a", "c"]);
    expect(start.mock.calls.map(([j]) => j.path)).toEqual(["a", "b", "c"]);
  });

  it("remove drops queued jobs that don't match the keep predicate", () => {
    const { started, q } = setup(1);
    act(() => {
      q().enqueue(job("a")); // starts
      q().enqueue(job("b")); // queued
      q().enqueue(job("c")); // queued
    });
    act(() => q().remove((j) => j.path !== "b")); // cancel "b"
    act(() => q().onReleased());
    expect(started).toEqual(["a", "c"]); // "b" never started
  });

  it("reset clears the queue and frees all slots", () => {
    const { started, q } = setup(1);
    act(() => {
      q().enqueue(job("a"));
      q().enqueue(job("b"));
    });
    expect(started).toEqual(["a"]);
    act(() => q().reset());
    act(() => q().enqueue(job("c"))); // in-flight cleared → starts immediately
    expect(started).toEqual(["a", "c"]);
  });
});
