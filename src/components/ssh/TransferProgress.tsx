"use client";

import { useEffect, useRef, useState } from "react";
import { summarizeUploads } from "@/lib/sshProtocol";
import {
  computeTransferStats,
  formatRate,
  formatEta,
  type TransferSample,
} from "@/lib/transferStats";
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
  // Rate/ETA (#42) is computed off the render path (React forbids reading refs
  // or the clock during render): an effect keeps a baseline sample per active
  // transfer and, on a 500ms tick plus every progress change, writes a
  // "1.2 MB/s · ~8s" label per key into state, which render just reads. The
  // baseline is captured when a transfer first becomes active and pruned when it
  // finishes, so the average rate is measured from that point.
  const samplesRef = useRef<Map<string, TransferSample>>(new Map());
  const [rateLabels, setRateLabels] = useState<Record<string, string>>({});

  useEffect(() => {
    const recompute = () => {
      const now = Date.now();
      const samples = samplesRef.current;
      const active = new Set<string>();
      const next: Record<string, string> = {};
      const consider = (key: string, transferred: number, total: number) => {
        active.add(key);
        let sample = samples.get(key);
        if (!sample) {
          sample = { t0: now, b0: transferred };
          samples.set(key, sample);
        }
        const { bps, etaMs } = computeTransferStats(
          transferred,
          total,
          sample,
          now,
        );
        const eta = formatEta(etaMs);
        const label = [formatRate(bps), eta && `~${eta}`]
          .filter(Boolean)
          .join(" · ");
        if (label) next[key] = label;
      };
      for (const u of uploads)
        if (u.status !== "queued" && u.status !== "interrupted")
          consider(`up:${u.path}`, u.sent, u.total);
      for (const d of downloads) consider(`dn:${d.path}`, d.received, d.total);
      for (const k of [...samples.keys()])
        if (!active.has(k)) samples.delete(k);
      // Skip a no-op state update so an idle panel doesn't re-render every tick.
      setRateLabels((prev) => {
        const keys = Object.keys(next);
        if (
          keys.length === Object.keys(prev).length &&
          keys.every((k) => prev[k] === next[k])
        )
          return prev;
        return next;
      });
    };
    // All state updates happen in async callbacks (not synchronously in the
    // effect body) so the clock/ref access stays off the render path.
    const kickoff = setTimeout(recompute, 0);
    const id = setInterval(recompute, 500);
    return () => {
      clearTimeout(kickoff);
      clearInterval(id);
    };
  }, [uploads, downloads]);

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
                          <>
                            {rateLabels[`up:${u.path}`] && (
                              <span className="tabular-nums text-term-faint">
                                {rateLabels[`up:${u.path}`]}
                              </span>
                            )}
                            <span className="tabular-nums text-term-faint">
                              {pct}%
                            </span>
                          </>
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
                    {rateLabels[`dn:${d.path}`] && (
                      <span className="tabular-nums text-term-faint">
                        {rateLabels[`dn:${d.path}`]}
                      </span>
                    )}
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
