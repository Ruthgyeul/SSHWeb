import { describe, expect, it } from "vitest";
import { base64ToBytes, bytesToBase64, concatBytes } from "@/lib/bytes";

describe("base64ToBytes", () => {
  it("decodes an ASCII base64 string to its raw bytes", () => {
    // "hi" → base64 "aGk="
    expect(Array.from(base64ToBytes("aGk="))).toEqual([0x68, 0x69]);
  });

  it("decodes an empty string to an empty buffer", () => {
    expect(base64ToBytes("").length).toBe(0);
  });

  it("round-trips raw binary bytes through bytesToBase64", () => {
    const bytes = new Uint8Array([0, 1, 2, 254, 255, 128, 127]);
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(
      Array.from(bytes),
    );
  });
});

describe("bytesToBase64", () => {
  it("encodes raw bytes to base64", () => {
    expect(bytesToBase64(new Uint8Array([0x68, 0x69]))).toBe("aGk=");
  });

  it("encodes an empty buffer to an empty string", () => {
    expect(bytesToBase64(new Uint8Array([]))).toBe("");
  });

  it("handles buffers larger than the internal chunk size without overflowing", () => {
    // Larger than the 0x8000 chunking window, so the chunked path is exercised.
    const big = new Uint8Array(0x8000 * 2 + 5).map((_, i) => i % 256);
    expect(Array.from(base64ToBytes(bytesToBase64(big)))).toEqual(
      Array.from(big),
    );
  });
});

describe("concatBytes", () => {
  it("joins chunks in order into one contiguous buffer", () => {
    const out = concatBytes([
      new Uint8Array([1, 2]),
      new Uint8Array([3]),
      new Uint8Array([4, 5]),
    ]);
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5]);
  });

  it("returns an empty buffer for no chunks", () => {
    expect(concatBytes([]).length).toBe(0);
  });

  it("skips empty chunks transparently", () => {
    const out = concatBytes([
      new Uint8Array([]),
      new Uint8Array([7, 8]),
      new Uint8Array([]),
    ]);
    expect(Array.from(out)).toEqual([7, 8]);
  });
});
