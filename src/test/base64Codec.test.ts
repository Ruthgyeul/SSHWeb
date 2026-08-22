import { describe, expect, it } from "vitest";

import { base64ToBytes, bytesToBase64 } from "@/lib/bytes";
import {
  base64ToBytesAsync,
  bytesToBase64Async,
  WORKER_MIN_BYTES,
} from "@/lib/base64Codec";

// Under Vitest's node environment there is no `Worker`, so both async helpers
// exercise the synchronous fallback. They must produce byte-identical results to
// the sync codec for both small (below threshold) and large (above threshold,
// where the worker path is attempted then falls back) inputs.

function makeBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + 7) & 0xff;
  return b;
}

describe("base64Codec async fallback", () => {
  it("encodes small input identically to the sync codec", async () => {
    const bytes = makeBytes(1024);
    expect(await bytesToBase64Async(bytes)).toBe(bytesToBase64(bytes));
  });

  it("encodes large input (above the worker threshold) identically", async () => {
    const bytes = makeBytes(WORKER_MIN_BYTES + 5000);
    expect(await bytesToBase64Async(bytes)).toBe(bytesToBase64(bytes));
  });

  it("round-trips bytes -> base64 -> bytes for a large buffer", async () => {
    const bytes = makeBytes(WORKER_MIN_BYTES * 2);
    const b64 = await bytesToBase64Async(bytes);
    const back = await base64ToBytesAsync(b64);
    expect(Array.from(back)).toEqual(Array.from(bytes));
  });

  it("decodes identically to the sync codec", async () => {
    const b64 = bytesToBase64(makeBytes(WORKER_MIN_BYTES + 100));
    expect(Array.from(await base64ToBytesAsync(b64))).toEqual(
      Array.from(base64ToBytes(b64)),
    );
  });
});
