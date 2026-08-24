// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { ClientMessage, ServerMessage } from "@/lib/sshProtocol";
import { bytesToBase64 } from "@/lib/bytes";

// Capture the assembled-file hand-off so we can assert what a finished download
// saved without touching the DOM download machinery.
const holder = vi.hoisted(() => ({ triggerDownload: vi.fn() }));
vi.mock("@/components/ssh/dom/download", () => ({
  triggerDownload: (...a: unknown[]) => holder.triggerDownload(...a),
}));

import { useDownloadTransfers } from "@/components/ssh/hooks/useDownloadTransfers";

const chunk = (
  path: string,
  bytes: number[],
): Extract<ServerMessage, { t: "sftp-download-chunk" }> => ({
  t: "sftp-download-chunk",
  path,
  dataB64: bytesToBase64(new Uint8Array(bytes)),
});

function setup(maxInFlight = 2, isElevated?: () => boolean) {
  const sent: ClientMessage[] = [];
  const send = (m: ClientMessage) => sent.push(m);
  const onDownloaded = vi.fn();
  const hook = renderHook(() =>
    useDownloadTransfers({ send, onDownloaded, maxInFlight, isElevated }),
  );
  return { sent, onDownloaded, api: () => hook.result.current };
}

const reads = (sent: ClientMessage[]) =>
  sent.filter((m) => m.t === "sftp-read") as Extract<
    ClientMessage,
    { t: "sftp-read" }
  >[];

beforeEach(() => {
  holder.triggerDownload = vi.fn();
});

describe("useDownloadTransfers", () => {
  it("assembles a plain download and hands the bytes to triggerDownload", () => {
    const { sent, onDownloaded, api } = setup();
    act(() => api().startDownload("/home/me/big.bin"));
    // The queue started it immediately (a slot was free) with no resume offset.
    expect(reads(sent)).toEqual([
      { t: "sftp-read", path: "/home/me/big.bin", resumeOffset: undefined },
    ]);

    act(() =>
      api().handleDownloadMessage({
        t: "sftp-download-begin",
        path: "/home/me/big.bin",
        name: "big.bin",
        size: 3,
      }),
    );
    act(() => api().handleDownloadMessage(chunk("/home/me/big.bin", [1, 2])));
    act(() => api().handleDownloadMessage(chunk("/home/me/big.bin", [3])));
    act(() =>
      api().handleDownloadMessage({
        t: "sftp-download-end",
        path: "/home/me/big.bin",
      }),
    );

    expect(holder.triggerDownload).toHaveBeenCalledTimes(1);
    const [name, bytes] = holder.triggerDownload.mock.calls[0];
    expect(name).toBe("big.bin");
    expect(Array.from(bytes as Uint8Array)).toEqual([1, 2, 3]);
    expect(onDownloaded).toHaveBeenCalledWith("big.bin");
    // The progress row is gone once the file is saved.
    expect(api().downloads["/home/me/big.bin"]).toBeUndefined();
  });

  it("caps concurrent downloads and queues the rest (#74)", () => {
    const { sent, api } = setup(2);
    act(() => {
      api().startDownload("/a");
      api().startDownload("/b");
      api().startDownload("/c"); // over the limit → queued
    });
    expect(reads(sent).map((m) => m.path)).toEqual(["/a", "/b"]);
    expect(api().downloads["/c"].status).toBe("queued");

    // Finishing /a frees a slot; /c starts.
    act(() =>
      api().handleDownloadMessage({
        t: "sftp-download-begin",
        path: "/a",
        name: "a",
        size: 0,
      }),
    );
    act(() =>
      api().handleDownloadMessage({ t: "sftp-download-end", path: "/a" }),
    );
    expect(reads(sent).map((m) => m.path)).toEqual(["/a", "/b", "/c"]);
    expect(api().downloads["/c"].status).toBe("downloading");
  });

  it("cancelling a running download frees its queue slot", () => {
    const { sent, api } = setup(1);
    act(() => {
      api().startDownload("/a"); // starts
      api().startDownload("/b"); // queued
    });
    expect(reads(sent).map((m) => m.path)).toEqual(["/a"]);
    act(() => api().cancelDownload("/a"));
    // The cancel frame went out and /b took the freed slot.
    expect(
      sent.some((m) => m.t === "sftp-download-cancel" && m.path === "/a"),
    ).toBe(true);
    expect(reads(sent).map((m) => m.path)).toEqual(["/a", "/b"]);
    expect(api().downloads["/a"]).toBeUndefined();
  });

  it("resumes an interrupted download from its byte offset (#41)", () => {
    const { sent, api } = setup();
    act(() => api().startDownload("/log"));
    act(() =>
      api().handleDownloadMessage({
        t: "sftp-download-begin",
        path: "/log",
        name: "log",
        size: 5,
      }),
    );
    act(() => api().handleDownloadMessage(chunk("/log", [1, 2]))); // 2 of 5

    // Socket drops mid-stream: the row becomes interrupted, bytes are kept.
    act(() => api().interruptInFlight());
    expect(api().downloads["/log"].status).toBe("interrupted");
    expect(api().downloads["/log"].received).toBe(2);
    expect(holder.triggerDownload).not.toHaveBeenCalled();

    // Reconnect re-drives it from offset 2.
    act(() => api().resumeInterrupted());
    const resumeRead = reads(sent).at(-1)!;
    expect(resumeRead).toEqual({
      t: "sftp-read",
      path: "/log",
      resumeOffset: 2,
    });

    // The bridge echoes the offset and streams the remaining bytes; the final
    // file is the partial + the continuation, in order.
    act(() =>
      api().handleDownloadMessage({
        t: "sftp-download-begin",
        path: "/log",
        name: "log",
        size: 5,
        offset: 2,
      }),
    );
    act(() => api().handleDownloadMessage(chunk("/log", [3, 4, 5])));
    act(() =>
      api().handleDownloadMessage({ t: "sftp-download-end", path: "/log" }),
    );
    expect(holder.triggerDownload).toHaveBeenCalledTimes(1);
    const [, bytes] = holder.triggerDownload.mock.calls[0];
    expect(Array.from(bytes as Uint8Array)).toEqual([1, 2, 3, 4, 5]);
  });

  it("restarts from scratch when the resumed file changed (offset mismatch)", () => {
    const { api } = setup();
    act(() => api().startDownload("/f"));
    act(() =>
      api().handleDownloadMessage({
        t: "sftp-download-begin",
        path: "/f",
        name: "f",
        size: 4,
      }),
    );
    act(() => api().handleDownloadMessage(chunk("/f", [9, 9]))); // stale partial
    act(() => api().interruptInFlight());
    act(() => api().resumeInterrupted());
    // Bridge couldn't honour the offset (file changed) → fresh stream from 0.
    act(() =>
      api().handleDownloadMessage({
        t: "sftp-download-begin",
        path: "/f",
        name: "f",
        size: 3,
      }),
    );
    act(() => api().handleDownloadMessage(chunk("/f", [1, 2, 3])));
    act(() =>
      api().handleDownloadMessage({ t: "sftp-download-end", path: "/f" }),
    );
    const [, bytes] = holder.triggerDownload.mock.calls[0];
    // The stale [9,9] partial was discarded; only the fresh bytes are saved.
    expect(Array.from(bytes as Uint8Array)).toEqual([1, 2, 3]);
  });

  it("tears down a failed download and frees its slot without saving (error end)", () => {
    const { sent, api } = setup(1);
    act(() => {
      api().startDownload("/big"); // starts, holds the only slot
      api().startDownload("/next"); // queued
    });
    act(() =>
      api().handleDownloadMessage({
        t: "sftp-download-begin",
        path: "/big",
        name: "big",
        size: 100,
      }),
    );
    // A terminal failure (e.g. over the download cap mid-stream).
    act(() =>
      api().handleDownloadMessage({
        t: "sftp-download-end",
        path: "/big",
        error: true,
      }),
    );
    expect(holder.triggerDownload).not.toHaveBeenCalled();
    expect(api().downloads["/big"]).toBeUndefined();
    // The freed slot let the queued download start.
    expect(reads(sent).map((m) => m.path)).toEqual(["/big", "/next"]);
  });

  it("streams a zip download not started via the queue (no prior control block)", () => {
    const { api } = setup();
    // sftp-download-dir/-many reply straight with frames; there is no startDownload.
    act(() =>
      api().handleDownloadMessage({
        t: "sftp-download-begin",
        path: "/folder.zip",
        name: "folder.zip",
        size: 2,
      }),
    );
    expect(api().downloads["/folder.zip"].status).toBe("downloading");
    act(() => api().handleDownloadMessage(chunk("/folder.zip", [7, 8])));
    act(() =>
      api().handleDownloadMessage({
        t: "sftp-download-end",
        path: "/folder.zip",
      }),
    );
    const [name, bytes] = holder.triggerDownload.mock.calls[0];
    expect(name).toBe("folder.zip");
    expect(Array.from(bytes as Uint8Array)).toEqual([7, 8]);
  });

  it("drops a zip download on a socket drop (not offset-resumable)", () => {
    const { api } = setup();
    act(() =>
      api().handleDownloadMessage({
        t: "sftp-download-begin",
        path: "/z.zip",
        name: "z.zip",
        size: 10,
      }),
    );
    act(() => api().handleDownloadMessage(chunk("/z.zip", [1])));
    act(() => api().interruptInFlight());
    // A zip stream can't resume from an offset, so it's dropped, not parked.
    expect(api().downloads["/z.zip"]).toBeUndefined();
    act(() => api().resumeInterrupted());
    expect(holder.triggerDownload).not.toHaveBeenCalled();
  });

  it("sends the captured version on a resume so the bridge can verify identity (#41)", () => {
    const { sent, api } = setup();
    // startDownload captures the file's size:mtime version.
    act(() => api().startDownload("/log", "500:1700000000000"));
    // A fresh start carries no version (offset 0 → nothing to verify).
    expect(reads(sent).at(-1)!.resumeVersion).toBeUndefined();
    act(() =>
      api().handleDownloadMessage({
        t: "sftp-download-begin",
        path: "/log",
        name: "log",
        size: 5,
      }),
    );
    act(() => api().handleDownloadMessage(chunk("/log", [1, 2])));
    act(() => api().interruptInFlight());
    act(() => api().resumeInterrupted());
    // The resume read carries the captured version so the bridge can confirm the
    // file is unchanged before appending onto the buffered prefix.
    expect(reads(sent).at(-1)).toEqual({
      t: "sftp-read",
      path: "/log",
      resumeOffset: 2,
      resumeVersion: "500:1700000000000",
    });
  });

  it("holds an elevated download interrupted until elevation is restored (#41)", () => {
    let elevated = true;
    const { sent, api } = setup(2, () => elevated);
    act(() => api().startDownload("/root/secret")); // captured while elevated
    act(() =>
      api().handleDownloadMessage({
        t: "sftp-download-begin",
        path: "/root/secret",
        name: "secret",
        size: 4,
      }),
    );
    act(() => api().handleDownloadMessage(chunk("/root/secret", [1, 2])));

    // Reconnect drops elevation, then the socket comes back non-elevated.
    elevated = false;
    act(() => api().interruptInFlight());
    const before = reads(sent).length;
    act(() => api().resumeInterrupted());
    // The elevated download is NOT resumed through the login-user SFTP.
    expect(reads(sent).length).toBe(before);
    expect(api().downloads["/root/secret"].status).toBe("interrupted");

    // Once elevation is restored, it resumes.
    elevated = true;
    act(() => api().resumeInterrupted());
    expect(reads(sent).at(-1)).toEqual({
      t: "sftp-read",
      path: "/root/secret",
      resumeOffset: 2,
      resumeVersion: undefined,
    });
  });

  it("reset clears rows and control state (logout)", () => {
    const { api } = setup();
    act(() => api().startDownload("/x"));
    expect(api().downloads["/x"]).toBeDefined();
    act(() => api().reset());
    expect(api().downloads).toEqual({});
  });
});
