"use client";

import { summarizeUploads } from "@/lib/sshProtocol";
import { cn } from "@/lib/utils";
import type { DownloadItem, UploadItem } from "./FileBrowser";

interface TransferProgressProps {
  uploads: UploadItem[];
  downloads: DownloadItem[];
  /** Abort an in-flight or interrupted upload (removes its partial remotely). */
  onCancelUpload: (path: string) => void;
  /** Abort every queued/active/interrupted upload at once ("Cancel all"). */
  onCancelAllUploads: () => void;
  /** Resume an upload paused by a dropped connection. */
  onResumeUpload: (path: string) => void;
  /** Abort an in-flight download. */
  onCancelDownload: (path: string) => void;
}

/** The upload + download progress panels shown above the listing while
 * transfers are in flight. For an upload batch (>1 file) an aggregate bar
 * summarizes the whole queue with a single Cancel-all, and only the actively
 * streaming/interrupted files get their own row — the ones still waiting behind
 * the concurrency limit collapse into a "N queued" line so a big folder upload
 * doesn't render hundreds of rows. */
export function TransferProgress({
  uploads,
  downloads,
  onCancelUpload,
  onCancelAllUploads,
  onResumeUpload,
  onCancelDownload,
}: TransferProgressProps) {
  return (
    <>
      {uploads.length > 0 &&
        (() => {
          const summary = summarizeUploads(uploads);
          const showAggregate = uploads.length > 1;
          const rows = showAggregate
            ? uploads.filter((u) => u.status !== "queued")
            : uploads;
          return (
            <div className="flex flex-col gap-1.5 border-b border-term-border bg-term-panel/50 px-3 py-2">
              {showAggregate && (
                <div className="text-xs">
                  <div className="flex items-center justify-between gap-2 text-term-muted">
                    <span className="truncate font-medium">
                      ↑ Uploading {summary.files} file
                      {summary.files === 1 ? "" : "s"}
                      {summary.queued > 0 && (
                        <span className="text-term-faint">
                          {" "}
                          · {summary.queued} queued
                        </span>
                      )}
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className="tabular-nums text-term-faint">
                        {summary.pct}%
                      </span>
                      <button
                        type="button"
                        onClick={onCancelAllUploads}
                        className="rounded px-1 text-term-faint hover:bg-term-border hover:text-term-red"
                        title="Cancel all uploads"
                      >
                        Cancel all
                      </button>
                    </span>
                  </div>
                  <div className="mt-1 h-1 overflow-hidden rounded bg-term-border">
                    <div
                      className={cn(
                        "h-full transition-all",
                        summary.interrupted
                          ? "bg-term-yellow"
                          : "bg-term-accent",
                      )}
                      style={{ width: `${summary.pct}%` }}
                    />
                  </div>
                </div>
              )}
              {rows.map((u) => {
                const pct =
                  u.total > 0 ? Math.round((u.sent / u.total) * 100) : 100;
                const interrupted = u.status === "interrupted";
                return (
                  <div key={u.path} className="text-xs">
                    <div className="flex items-center justify-between gap-2 text-term-muted">
                      <span className="truncate">↑ {u.name}</span>
                      <span className="flex shrink-0 items-center gap-2">
                        {interrupted ? (
                          <>
                            <span className="text-term-yellow">
                              interrupted
                            </span>
                            <button
                              type="button"
                              onClick={() => onResumeUpload(u.path)}
                              className="rounded px-1 text-term-accent hover:bg-term-border"
                              title="Resume upload"
                            >
                              Resume
                            </button>
                          </>
                        ) : (
                          <span className="tabular-nums text-term-faint">
                            {pct}%
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => onCancelUpload(u.path)}
                          className="rounded px-1 text-term-faint hover:bg-term-border hover:text-term-red"
                          title="Cancel upload"
                          aria-label={`Cancel upload ${u.name}`}
                        >
                          ✕
                        </button>
                      </span>
                    </div>
                    <div className="mt-1 h-1 overflow-hidden rounded bg-term-border">
                      <div
                        className={cn(
                          "h-full transition-all",
                          interrupted ? "bg-term-yellow" : "bg-term-accent",
                        )}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })()}

      {downloads.length > 0 && (
        <div className="flex flex-col gap-1.5 border-b border-term-border bg-term-panel/50 px-3 py-2">
          {downloads.map((d) => {
            const pct =
              d.total > 0 ? Math.round((d.received / d.total) * 100) : 100;
            return (
              <div key={d.path} className="text-xs">
                <div className="flex items-center justify-between gap-2 text-term-muted">
                  <span className="truncate">↓ {d.name}</span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="tabular-nums text-term-faint">{pct}%</span>
                    <button
                      type="button"
                      onClick={() => onCancelDownload(d.path)}
                      className="rounded px-1 text-term-faint hover:bg-term-border hover:text-term-red"
                      title="Cancel download"
                      aria-label={`Cancel download ${d.name}`}
                    >
                      ✕
                    </button>
                  </span>
                </div>
                <div className="mt-1 h-1 overflow-hidden rounded bg-term-border">
                  <div
                    className="h-full bg-term-green transition-all"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
