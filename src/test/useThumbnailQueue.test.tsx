// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

import { useThumbnailQueue } from "@/components/ssh/hooks/useThumbnailQueue";

/** Collect the paths sent as `sftp-read` thumb requests, in order. */
function setup(maxInFlight = 2) {
  const send = vi.fn();
  const paths = () =>
    send.mock.calls.map(([m]) => m.path);
  const hook = renderHook(() => useThumbnailQueue(send, maxInFlight));
  return { send, paths, q: () => hook.result.current };
}

describe("useThumbnailQueue", () => {
  it("sends each request as an sftp-read thumb, up to the concurrency limit", () => {
    const { send, paths, q } = setup(2);
    act(() => {
      q().request("a");
      q().request("b");
      q().request("c"); // over the limit → stays queued
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(paths()).toEqual(["a", "b"]);
    expect(send.mock.calls[0][0]).toMatchObject({ t: "sftp-read", thumb: true });
  });

  it("frees a slot on reply and pumps the next queued request", () => {
    const { paths, q } = setup(2);
    act(() => {
      q().request("a");
      q().request("b");
      q().request("c");
    });
    expect(paths()).toEqual(["a", "b"]);
    act(() => q().onReplied()); // one slot frees
    expect(paths()).toEqual(["a", "b", "c"]);
  });

  it("dedupes repeated requests for the same path", () => {
    const { send, q } = setup(5);
    act(() => {
      q().request("a");
      q().request("a");
      q().request("a");
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("serves visible tiles before ones that scrolled out of view", () => {
    const { paths, q } = setup(1); // one at a time to observe ordering
    act(() => {
      q().request("a");
      q().request("b");
      q().request("c");
    });
    // Slot 1 took "a" (nothing visible yet). Mark "c" visible, then free slots.
    act(() => q().setVisible("c", true));
    act(() => q().onReplied()); // picks visible "c" over FIFO "b"
    expect(paths()).toEqual(["a", "c"]);
    act(() => q().onReplied()); // "b" remains
    expect(paths()).toEqual(["a", "c", "b"]);
  });

  it("falls back to FIFO when nothing queued is visible", () => {
    const { paths, q } = setup(1);
    act(() => {
      q().request("a");
      q().request("b");
    });
    act(() => q().onReplied());
    expect(paths()).toEqual(["a", "b"]);
  });

  it("reset drops the queue, dedupe set, visibility and in-flight count", () => {
    const { send, paths, q } = setup(1);
    act(() => {
      q().request("a"); // sent, in-flight = 1
      q().request("b"); // queued
    });
    expect(send).toHaveBeenCalledTimes(1);
    act(() => q().reset());
    // After reset the in-flight counter is clear, so a new request sends
    // immediately, and a previously-requested path can be requested again.
    act(() => q().request("a"));
    expect(paths()).toEqual(["a", "a"]);
  });
});
