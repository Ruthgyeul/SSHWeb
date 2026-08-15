// @vitest-environment jsdom
//
// Characterization tests for SshSession's server-message *assembly* — the
// sftp-download-begin/chunk/end handling in handleServerMessage plus the
// preview open/paint path. These lock in the observable behaviour (a plain
// download hands assembled bytes to triggerDownload; a preview streams into the
// modal and paints text) so a later refactor that splits handleServerMessage
// out of the component can be proven behaviour-neutral.
//
// The connect UI, xterm, FileBrowser and FilePreview are mocked to stubs: we
// drive the real handleServerMessage (captured via the useSshSocket seam) and
// the real openPreviewFile (via the FileBrowser stub's onPreview), and read the
// resulting preview state off a FilePreview stub.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerMessage } from "@/lib/sshProtocol";
import { bytesToBase64 } from "@/lib/bytes";

// --- Captured seams, shared between the mock factories and the tests. ---
const holder = vi.hoisted(() => ({
  onMessage: null as null | ((m: ServerMessage) => void),
  onOpen: null as null | ((d: unknown) => void),
  fbProps: null as null | Record<string, (...args: unknown[]) => void>,
  previewProps: null as null | Record<string, unknown>,
  triggerDownload: vi.fn(),
}));

vi.mock("@/components/ssh/XtermView", () => ({
  XtermView: () => <div data-testid="xterm" />,
}));

vi.mock("@/components/ssh/dom/download", () => ({
  triggerDownload: (...args: unknown[]) => holder.triggerDownload(...args),
}));

vi.mock("@/components/ssh/FileBrowser", () => ({
  FileBrowser: (props: Record<string, (...a: unknown[]) => void>) => {
    holder.fbProps = props;
    return <div data-testid="filebrowser" />;
  },
}));

vi.mock("@/components/ssh/FilePreview", () => ({
  FilePreview: (props: Record<string, unknown>) => {
    holder.previewProps = props;
    return (
      <div
        data-testid="preview"
        data-kind={String(props.kind)}
        data-loading={String(props.loading)}
        data-truncated={String(props.truncated)}
        data-optimized={String(props.optimized)}
      >
        {String(props.text ?? "")}
      </div>
    );
  },
}));

// Replace the socket lifecycle with a controllable stub: capture the message +
// open callbacks, and make openSocket wire a fake OPEN socket + fire onOpen.
vi.mock("@/components/ssh/hooks/useSshSocket", () => ({
  useSshSocket: (opts: {
    wsRef: { current: unknown };
    onMessage: (m: ServerMessage) => void;
    onOpen: (d: unknown) => void;
  }) => {
    holder.onMessage = opts.onMessage;
    holder.onOpen = opts.onOpen;
    return {
      openSocket: (details: unknown) => {
        opts.wsRef.current = { readyState: 1, send: vi.fn(), close: vi.fn() };
        opts.onOpen(details);
      },
    };
  },
}));

import { SshSession } from "@/components/ssh/SshSession";

const drive = (msg: ServerMessage) => act(() => holder.onMessage!(msg));

/** Render, connect, reach "connected", and switch to the files tab so the
 * FileBrowser stub's callbacks are captured. */
function connectToFiles() {
  render(<SshSession active onMeta={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("Host"), {
    target: { value: "example.com" },
  });
  fireEvent.change(screen.getByLabelText("Port"), { target: { value: "22" } });
  fireEvent.change(screen.getByLabelText("Username"), {
    target: { value: "me" },
  });
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: "pw" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Connect →" }));

  drive({ t: "status", state: "connected" });
  drive({ t: "caps", sudo: false, maxDownloadBytes: 0 });
  drive({
    t: "sftp-list",
    path: "/home/me",
    entries: [
      { name: "a.txt", type: "file", size: 11, mtime: 0, mode: 0o644 },
      { name: "big.bin", type: "file", size: 3, mtime: 0, mode: 0o644 },
    ],
  });
  fireEvent.click(screen.getByRole("button", { name: "files" }));
}

beforeEach(() => {
  holder.onMessage = null;
  holder.onOpen = null;
  holder.fbProps = null;
  holder.previewProps = null;
  holder.triggerDownload = vi.fn();
  // jsdom lacks blob-URL helpers; a preview image builds one.
  if (!URL.createObjectURL)
    URL.createObjectURL = vi.fn(
      () => "blob:mock",
    ) as typeof URL.createObjectURL;
  if (!URL.revokeObjectURL)
    URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SshSession download/preview assembly", () => {
  it("assembles a plain download and hands the bytes to triggerDownload", () => {
    connectToFiles();
    act(() => holder.fbProps!.onDownload("/home/me/big.bin"));

    drive({
      t: "sftp-download-begin",
      path: "/home/me/big.bin",
      name: "big.bin",
      size: 3,
    });
    drive({
      t: "sftp-download-chunk",
      path: "/home/me/big.bin",
      dataB64: bytesToBase64(new Uint8Array([1, 2])),
    });
    drive({
      t: "sftp-download-chunk",
      path: "/home/me/big.bin",
      dataB64: bytesToBase64(new Uint8Array([3])),
    });
    drive({ t: "sftp-download-end", path: "/home/me/big.bin" });

    expect(holder.triggerDownload).toHaveBeenCalledTimes(1);
    const [name, bytes] = holder.triggerDownload.mock.calls[0];
    expect(name).toBe("big.bin");
    expect(Array.from(bytes as Uint8Array)).toEqual([1, 2, 3]);
  });

  it("streams a text preview into the modal and paints it", () => {
    connectToFiles();
    act(() => holder.fbProps!.onPreview("/home/me/a.txt", "a.txt"));

    // Opens immediately in a loading state.
    expect(screen.getByTestId("preview")).toHaveAttribute(
      "data-loading",
      "true",
    );

    const enc = new TextEncoder();
    drive({
      t: "sftp-download-begin",
      path: "/home/me/a.txt",
      name: "a.txt",
      size: 11,
      preview: true,
    });
    drive({
      t: "sftp-download-chunk",
      path: "/home/me/a.txt",
      dataB64: bytesToBase64(enc.encode("hello ")),
      preview: true,
    });
    drive({
      t: "sftp-download-chunk",
      path: "/home/me/a.txt",
      dataB64: bytesToBase64(enc.encode("world")),
      preview: true,
    });
    drive({ t: "sftp-download-end", path: "/home/me/a.txt", preview: true });

    const modal = screen.getByTestId("preview");
    expect(modal).toHaveAttribute("data-kind", "text");
    expect(modal).toHaveAttribute("data-loading", "false");
    expect(modal).toHaveTextContent("hello world");
    // A whole (non-capped) read is not flagged truncated.
    expect(modal).toHaveAttribute("data-truncated", "false");
  });

  it("flags a capped (head-only) text preview as truncated", () => {
    connectToFiles();
    act(() => holder.fbProps!.onPreview("/home/me/a.txt", "a.txt"));

    drive({
      t: "sftp-download-begin",
      path: "/home/me/a.txt",
      name: "a.txt",
      size: 11,
      preview: true,
    });
    drive({
      t: "sftp-download-chunk",
      path: "/home/me/a.txt",
      dataB64: bytesToBase64(new TextEncoder().encode("hello ")),
      preview: true,
    });
    drive({
      t: "sftp-download-end",
      path: "/home/me/a.txt",
      preview: true,
      truncated: true,
    });

    const modal = screen.getByTestId("preview");
    expect(modal).toHaveAttribute("data-truncated", "true");
    expect(modal).toHaveTextContent("hello");
  });

  it("marks a bridge-transcoded image preview optimized and blob-backed", () => {
    connectToFiles();
    act(() => holder.fbProps!.onPreview("/home/me/photo.jpg", "photo.jpg"));

    drive({
      t: "sftp-download-begin",
      path: "/home/me/photo.jpg",
      name: "photo.jpg",
      size: 4,
      preview: true,
      mime: "image/webp",
      origWidth: 4000,
      origHeight: 3000,
    });
    drive({
      t: "sftp-download-chunk",
      path: "/home/me/photo.jpg",
      dataB64: bytesToBase64(new Uint8Array([137, 80, 78, 71])),
      preview: true,
    });
    drive({
      t: "sftp-download-end",
      path: "/home/me/photo.jpg",
      preview: true,
    });

    const modal = screen.getByTestId("preview");
    expect(modal).toHaveAttribute("data-kind", "image");
    expect(modal).toHaveAttribute("data-loading", "false");
    // A server `mime` means these are a downscaled WebP, not the original — so
    // the modal is flagged optimized (Download re-fetches the original).
    expect(modal).toHaveAttribute("data-optimized", "true");
  });

  it("ignores a stale download-begin for a file the user already left", () => {
    connectToFiles();
    // No preview open, and not a registered plain download: a preview-tagged
    // begin for an unknown path must be dropped, not throw.
    expect(() =>
      drive({
        t: "sftp-download-begin",
        path: "/home/me/ghost.txt",
        name: "ghost.txt",
        size: 5,
        preview: true,
      }),
    ).not.toThrow();
    expect(holder.triggerDownload).not.toHaveBeenCalled();
  });
});
