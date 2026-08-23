/**
 * Pure helpers for a transfer's live throughput and ETA, shown on the upload /
 * download progress rows (#42). The math is average rate since a captured
 * baseline sample — the UI records one `TransferSample` per active transfer and
 * feeds the latest byte count back in — so it stays a DOM-free, unit-tested
 * function here while the component owns the timing.
 */

/** A baseline captured when a transfer's row first became active. */
export interface TransferSample {
  /** epoch ms at which the baseline was taken */
  t0: number;
  /** bytes already transferred at the baseline */
  b0: number;
}

export interface TransferStats {
  /** Average bytes/second since the baseline, or null when not yet measurable. */
  bps: number | null;
  /** Estimated ms remaining, or null when unknown (no rate, or unknown total). */
  etaMs: number | null;
}

/**
 * Average rate + ETA for a transfer given its baseline sample and current
 * progress. Returns nulls until there's a positive time delta AND positive
 * byte delta (so a just-started or stalled transfer shows no misleading rate).
 */
export function computeTransferStats(
  transferred: number,
  total: number,
  sample: TransferSample,
  now: number,
): TransferStats {
  const dtSec = (now - sample.t0) / 1000;
  const dBytes = transferred - sample.b0;
  if (dtSec <= 0 || dBytes <= 0) return { bps: null, etaMs: null };
  const bps = dBytes / dtSec;
  const remaining = Math.max(0, total - transferred);
  const etaMs = total > 0 && bps > 0 ? (remaining / bps) * 1000 : null;
  return { bps, etaMs };
}

/** Human-readable transfer rate, e.g. "0 B/s", "512 KB/s", "1.2 MB/s". */
export function formatRate(bps: number | null): string {
  if (bps === null || !Number.isFinite(bps) || bps <= 0) return "";
  if (bps < 1024) return `${Math.round(bps)} B/s`;
  const units = ["KB/s", "MB/s", "GB/s", "TB/s"];
  let v = bps / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(v >= 10 || v % 1 === 0 ? 0 : 1)} ${units[u]}`;
}

/** Human-readable remaining time, e.g. "5s", "1m 05s", "1h 02m". Empty for
 * null/negative; clamps sub-second to "0s". */
export function formatEta(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "";
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `${min}m ${String(sec).padStart(2, "0")}s`;
  const hr = Math.floor(min / 60);
  const rmin = min % 60;
  return `${hr}h ${String(rmin).padStart(2, "0")}m`;
}
