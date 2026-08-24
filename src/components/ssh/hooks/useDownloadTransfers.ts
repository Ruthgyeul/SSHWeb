import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientMessage, ServerMessage } from "@/lib/sshProtocol";
import { base64ToBytes, concatBytes } from "@/lib/bytes";
import { triggerDownload } from "../dom/download";
import type { DownloadItem } from "../FileBrowser";
import { useDownloadQueue, type DownloadJob } from "./useDownloadQueue";

/** Per-download control + accumulated bytes, keyed by remote path. Mirrors the
 * upload side's `uploadCtlRef`: enough state to show progress, cancel, and
 * resume after a dropped connection. `resumable` distinguishes a queue-managed
 * plain-file download (offset-resumable) from a one-shot zip stream
 * (`sftp-download-dir`/`-many`), which can't resume from an offset. */
interface DownloadCtl {
  name: string;
  /** Full file size (0 until the first `sftp-download-begin` reports it). */
  total: number;
  /** Bytes buffered so far (survives an interruption for the resume offset). */
  received: number;
  chunks: Uint8Array[];
  cancelled: boolean;
  running: boolean;
  interrupted: boolean;
  queued: boolean;
  resumable: boolean;
}

/** Project a control block into the progress-panel row shape (pure). */
function downloadRow(ctl: DownloadCtl, path: string): DownloadItem {
  return {
    path,
    name: ctl.name,
    received: ctl.received,
    total: ctl.total,
    status: ctl.queued
      ? "queued"
      : ctl.interrupted
        ? "interrupted"
        : "downloading",
  };
}

export interface DownloadTransfersDeps {
  send: (msg: ClientMessage) => void;
  /** Notified when a real download finishes, so the session can toast (#26). */
  onDownloaded?: (name: string) => void;
  /** How many plain downloads may stream at once (#74). */
  maxInFlight: number;
}

export interface DownloadTransfers {
  /** In-flight/queued/interrupted downloads, keyed by path (drives the panel). */
  downloads: Record<string, DownloadItem>;
  /** The plain (non-preview) `sftp-download-*` state machine. */
  handleDownloadMessage: (
    msg: Extract<
      ServerMessage,
      { t: "sftp-download-begin" | "sftp-download-chunk" | "sftp-download-end" }
    >,
  ) => void;
  /** Begin a plain file download (queued behind the concurrency limit). */
  startDownload: (path: string, size?: number) => void;
  /** Abort an in-flight/queued/interrupted download (frees its slot). */
  cancelDownload: (path: string) => void;
  /** Resume a download paused by a dropped connection (from its offset). */
  resumeDownload: (path: string) => void;
  /** A live socket dropped: park resumable downloads as interrupted. */
  interruptInFlight: () => void;
  /** The socket reconnected: re-drive interrupted downloads from their offset. */
  resumeInterrupted: () => void;
  /** Clear everything (logout / teardown). */
  reset: () => void;
}

/**
 * The plain-file download subsystem for `SshSession` (#41 resumable download,
 * #74 download queue) — the symmetric counterpart of the upload state machine.
 *
 * Owns the `downloads` progress state, the accumulated bytes, and the
 * concurrency-limited queue: a plain download is registered "queued", starts
 * when a slot frees, streams over the `sftp-download-*` frames, and on the
 * closing frame saves the assembled file. A dropped connection parks a
 * streaming download as "interrupted" (keeping the partial bytes) and it
 * auto-resumes from its byte offset on reconnect — the download mirror of the
 * upload resume path. Zip streams (`sftp-download-dir`/`-many`) flow through the
 * same frames but aren't queue-managed and aren't offset-resumable.
 *
 * Previews use their own path (`usePreviewGallery`); only non-preview frames are
 * routed here. Behaviour is characterized in `useDownloadTransfers.test.tsx`.
 */
export function useDownloadTransfers(
  deps: DownloadTransfersDeps,
): DownloadTransfers {
  const { send, onDownloaded, maxInFlight } = deps;
  const [downloads, setDownloads] = useState<Record<string, DownloadItem>>({});
  const ctlRef = useRef<Record<string, DownloadCtl>>({});
  const {
    enqueue,
    onReleased,
    remove: removeQueued,
    reset: resetQueue,
    setStart,
  } = useDownloadQueue(maxInFlight);

  const patchRow = useCallback((path: string, row: DownloadItem) => {
    setDownloads((d) => ({ ...d, [path]: row }));
  }, []);

  const dropRow = useCallback((path: string) => {
    setDownloads((d) => {
      if (!(path in d)) return d;
      const rest = { ...d };
      delete rest[path];
      return rest;
    });
  }, []);

  // The queue's starter: begin one job, returning whether it consumed a slot. A
  // cancelled/already-running job is skipped (no slot). The reply frames drive
  // progress; the closing frame (or an error/cancel) releases the slot.
  const startJob = useCallback(
    (job: DownloadJob): boolean => {
      const ctl = ctlRef.current[job.path];
      if (!ctl || ctl.cancelled || ctl.running) return false;
      ctl.running = true;
      ctl.queued = false;
      ctl.interrupted = false;
      send({
        t: "sftp-read",
        path: job.path,
        resumeOffset: job.resumeOffset > 0 ? job.resumeOffset : undefined,
      });
      patchRow(job.path, downloadRow(ctl, job.path));
      return true;
    },
    [send, patchRow],
  );

  useEffect(() => {
    setStart(startJob);
  }, [startJob, setStart]);

  const startDownload = useCallback(
    (path: string, size?: number) => {
      const existing = ctlRef.current[path];
      // Ignore a duplicate request for a download already in flight/queued.
      if (existing && !existing.cancelled) return;
      const name = path.split("/").pop() || "download";
      const ctl: DownloadCtl = {
        name,
        total: size ?? 0,
        received: 0,
        chunks: [],
        cancelled: false,
        running: false,
        interrupted: false,
        queued: true,
        resumable: true,
      };
      ctlRef.current[path] = ctl;
      patchRow(path, downloadRow(ctl, path));
      enqueue({ path, resumeOffset: 0 });
    },
    [enqueue, patchRow],
  );

  const cancelDownload = useCallback(
    (path: string) => {
      const ctl = ctlRef.current[path];
      const heldSlot = !!ctl && ctl.resumable && ctl.running;
      if (ctl) ctl.cancelled = true;
      removeQueued((job) => job.path !== path);
      delete ctlRef.current[path];
      send({ t: "sftp-download-cancel", path });
      dropRow(path);
      // Only a running, queue-managed download held a concurrency slot.
      if (heldSlot) onReleased();
    },
    [send, dropRow, removeQueued, onReleased],
  );

  const resumeDownload = useCallback(
    (path: string) => {
      const ctl = ctlRef.current[path];
      if (!ctl || ctl.running || ctl.cancelled || !ctl.interrupted) return;
      ctl.interrupted = false;
      ctl.queued = true;
      patchRow(path, downloadRow(ctl, path));
      enqueue({ path, resumeOffset: ctl.received });
    },
    [enqueue, patchRow],
  );

  const handleDownloadMessage = useCallback(
    (
      msg: Extract<
        ServerMessage,
        {
          t:
            "sftp-download-begin" | "sftp-download-chunk" | "sftp-download-end";
        }
      >,
    ) => {
      switch (msg.t) {
        case "sftp-download-begin": {
          let ctl = ctlRef.current[msg.path];
          if (ctl) {
            // A queue-managed plain download (from startDownload/resume): mark it
            // streaming and decide append-vs-restart from the echoed offset.
            ctl.total = msg.size;
            ctl.running = true;
            ctl.queued = false;
            ctl.interrupted = false;
            const resuming =
              typeof msg.offset === "number" &&
              msg.offset > 0 &&
              msg.offset === ctl.received &&
              ctl.chunks.length > 0;
            if (!resuming) {
              // Fresh stream, or a mismatch (the file changed since the drop, so
              // the bridge restarted from 0) — discard any stale partial.
              ctl.chunks = [];
              ctl.received = 0;
            }
          } else {
            // No prior control block: a zip stream (`sftp-download-dir`/`-many`)
            // that didn't go through the queue. Register it non-resumable and
            // not slot-managed so it streams and saves like before.
            ctl = {
              name: msg.name,
              total: msg.size,
              received: 0,
              chunks: [],
              cancelled: false,
              running: true,
              interrupted: false,
              queued: false,
              resumable: false,
            };
            ctlRef.current[msg.path] = ctl;
          }
          patchRow(msg.path, downloadRow(ctl, msg.path));
          break;
        }

        case "sftp-download-chunk": {
          const ctl = ctlRef.current[msg.path];
          if (!ctl) break;
          const bytes = base64ToBytes(msg.dataB64);
          ctl.chunks.push(bytes);
          ctl.received += bytes.length;
          patchRow(msg.path, downloadRow(ctl, msg.path));
          break;
        }

        case "sftp-download-end": {
          const ctl = ctlRef.current[msg.path];
          if (!ctl) break;
          // A terminal failure (over-cap / read error / capacity): tear the row
          // down and free the slot without saving the partial. A separate
          // `error` frame surfaces the reason as a toast.
          if (msg.error) {
            const heldSlot = ctl.resumable && ctl.running;
            delete ctlRef.current[msg.path];
            dropRow(msg.path);
            if (heldSlot) onReleased();
            break;
          }
          const heldSlot = ctl.resumable && ctl.running;
          const { name, chunks } = ctl;
          delete ctlRef.current[msg.path];
          dropRow(msg.path);
          triggerDownload(name, concatBytes(chunks));
          onDownloaded?.(name);
          if (heldSlot) onReleased();
          break;
        }
      }
    },
    [patchRow, dropRow, onReleased, onDownloaded],
  );

  const interruptInFlight = useCallback(() => {
    for (const [path, ctl] of Object.entries(ctlRef.current)) {
      if (ctl.cancelled) continue;
      // A zip stream can't resume from an offset — drop it (the user re-triggers).
      if (!ctl.resumable) {
        delete ctlRef.current[path];
        dropRow(path);
        continue;
      }
      if (ctl.running || ctl.queued) {
        ctl.running = false;
        ctl.queued = false;
        ctl.interrupted = true;
        patchRow(path, downloadRow(ctl, path));
      }
    }
    // Every live stream died with the socket; clear the queue's accounting so
    // the reconnect can re-drive interrupted downloads from a clean slate.
    resetQueue();
  }, [dropRow, patchRow, resetQueue]);

  const resumeInterrupted = useCallback(() => {
    for (const [path, ctl] of Object.entries(ctlRef.current)) {
      if (ctl.interrupted && !ctl.running && !ctl.cancelled) {
        ctl.interrupted = false;
        ctl.queued = true;
        patchRow(path, downloadRow(ctl, path));
        enqueue({ path, resumeOffset: ctl.received });
      }
    }
  }, [enqueue, patchRow]);

  const reset = useCallback(() => {
    ctlRef.current = {};
    setDownloads({});
    resetQueue();
  }, [resetQueue]);

  return {
    downloads,
    handleDownloadMessage,
    startDownload,
    cancelDownload,
    resumeDownload,
    interruptInFlight,
    resumeInterrupted,
    reset,
  };
}
