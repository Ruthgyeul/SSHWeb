import { describe, expect, it } from "vitest";
import {
  computeTransferStats,
  formatRate,
  formatEta,
} from "@/lib/transferStats";

describe("computeTransferStats", () => {
  it("returns nulls until there is a positive time and byte delta", () => {
    const sample = { t0: 1000, b0: 0 };
    // No time elapsed.
    expect(computeTransferStats(0, 100, sample, 1000)).toEqual({
      bps: null,
      etaMs: null,
    });
    // Time elapsed but no bytes moved (stalled).
    expect(computeTransferStats(0, 100, sample, 2000)).toEqual({
      bps: null,
      etaMs: null,
    });
  });

  it("computes average rate and ETA from the baseline", () => {
    // 1 MiB in 2s → 512 KiB/s; 1 MiB remaining → ~2s ETA.
    const sample = { t0: 0, b0: 0 };
    const oneMiB = 1024 * 1024;
    const stats = computeTransferStats(oneMiB, oneMiB * 2, sample, 2000);
    expect(stats.bps).toBeCloseTo(oneMiB / 2, 5);
    expect(stats.etaMs).toBeCloseTo(2000, 5);
  });

  it("honors a non-zero baseline (resumed measurement)", () => {
    const sample = { t0: 1000, b0: 100 };
    // 300 bytes over 1s from the baseline.
    const stats = computeTransferStats(400, 1000, sample, 2000);
    expect(stats.bps).toBeCloseTo(300, 5);
    expect(stats.etaMs).toBeCloseTo((600 / 300) * 1000, 5);
  });

  it("gives a null ETA when the total is unknown", () => {
    const stats = computeTransferStats(500, 0, { t0: 0, b0: 0 }, 1000);
    expect(stats.bps).toBeCloseTo(500, 5);
    expect(stats.etaMs).toBeNull();
  });
});

describe("formatRate", () => {
  it("formats bytes/s across units", () => {
    expect(formatRate(0)).toBe("");
    expect(formatRate(null)).toBe("");
    expect(formatRate(512)).toBe("512 B/s");
    expect(formatRate(1024)).toBe("1 KB/s");
    expect(formatRate(1536)).toBe("1.5 KB/s");
    expect(formatRate(1024 * 1024)).toBe("1 MB/s");
    expect(formatRate(1024 * 1024 * 12.5)).toBe("13 MB/s");
  });

  it("ignores nonsense input", () => {
    expect(formatRate(-5)).toBe("");
    expect(formatRate(Number.NaN)).toBe("");
  });
});

describe("formatEta", () => {
  it("formats seconds, minutes and hours", () => {
    expect(formatEta(null)).toBe("");
    expect(formatEta(500)).toBe("1s");
    expect(formatEta(5000)).toBe("5s");
    expect(formatEta(65_000)).toBe("1m 05s");
    expect(formatEta(3_720_000)).toBe("1h 02m");
  });

  it("ignores negative/NaN", () => {
    expect(formatEta(-1)).toBe("");
    expect(formatEta(Number.NaN)).toBe("");
  });
});
