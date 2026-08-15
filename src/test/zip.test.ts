import { describe, expect, it } from "vitest";
import {
  crc32,
  crc32Final,
  crc32Init,
  crc32Update,
  exceedsZip32,
  ZIP32_MAX,
  zipCentralHeader,
  zipDataDescriptor,
  zipEndRecord,
  zipLocalHeader,
} from "@/lib/zip";

const enc = new TextEncoder();
function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe("crc32", () => {
  it("matches the standard check value for '123456789'", () => {
    expect(crc32(enc.encode("123456789"))).toBe(0xcbf43926);
  });

  it("is 0 for empty input", () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it("streams to the same value as a one-shot", () => {
    const data = enc.encode("the quick brown fox");
    let c = crc32Init();
    c = crc32Update(c, data.subarray(0, 4));
    c = crc32Update(c, data.subarray(4));
    expect(crc32Final(c)).toBe(crc32(data));
  });
});

describe("exceedsZip32", () => {
  it("flags values that no longer fit a 32-bit ZIP field", () => {
    expect(exceedsZip32(0)).toBe(false);
    expect(exceedsZip32(ZIP32_MAX - 1)).toBe(false);
    expect(exceedsZip32(ZIP32_MAX)).toBe(true);
    expect(exceedsZip32(ZIP32_MAX + 1000)).toBe(true);
  });
});

describe("record layouts", () => {
  const dv = (b: Uint8Array) =>
    new DataView(b.buffer, b.byteOffset, b.byteLength);

  it("writes a store + data-descriptor local header with zeroed sizes", () => {
    const h = zipLocalHeader(5);
    expect(h.length).toBe(30);
    const v = dv(h);
    expect(v.getUint32(0, true)).toBe(0x04034b50);
    expect(v.getUint16(6, true)).toBe(0x0808); // UTF-8 | data-descriptor flags
    expect(v.getUint16(8, true)).toBe(0); // store
    expect(v.getUint32(14, true)).toBe(0); // crc deferred
    expect(v.getUint32(18, true)).toBe(0); // sizes deferred
    expect(v.getUint32(22, true)).toBe(0);
    expect(v.getUint16(26, true)).toBe(5); // name length
  });

  it("writes a data descriptor with matching compressed/uncompressed sizes", () => {
    const d = zipDataDescriptor(0xdeadbeef, 1234);
    expect(d.length).toBe(16);
    const v = dv(d);
    expect(v.getUint32(0, true)).toBe(0x08074b50);
    expect(v.getUint32(4, true)).toBe(0xdeadbeef);
    expect(v.getUint32(8, true)).toBe(1234);
    expect(v.getUint32(12, true)).toBe(1234);
  });

  it("writes a central header carrying crc/size/offset", () => {
    const h = zipCentralHeader({
      nameLength: 3,
      crc: 0xabc,
      size: 9,
      offset: 42,
    });
    expect(h.length).toBe(46);
    const v = dv(h);
    expect(v.getUint32(0, true)).toBe(0x02014b50);
    expect(v.getUint32(16, true)).toBe(0xabc);
    expect(v.getUint32(20, true)).toBe(9);
    expect(v.getUint32(24, true)).toBe(9);
    expect(v.getUint16(28, true)).toBe(3);
    expect(v.getUint32(42, true)).toBe(42);
  });
});

/** Assemble a store-only streaming ZIP the way server.mjs does, for round-trip. */
function buildZip(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = enc.encode(f.name);
    const local = zipLocalHeader(nameBuf.length);
    const crc = crc32(f.data);
    const dd = zipDataDescriptor(crc, f.data.length);
    parts.push(local, nameBuf, f.data, dd);
    central.push(
      zipCentralHeader({
        nameLength: nameBuf.length,
        crc,
        size: f.data.length,
        offset,
      }),
      nameBuf,
    );
    offset += local.length + nameBuf.length + f.data.length + dd.length;
  }
  const centralBuf = concat(...central);
  const end = zipEndRecord({
    count: files.length,
    centralSize: centralBuf.length,
    centralOffset: offset,
  });
  return concat(...parts, centralBuf, end);
}

describe("full archive round-trip", () => {
  it("produces a parseable central directory whose CRCs match the data", () => {
    const files = [
      { name: "a.txt", data: enc.encode("hello world") },
      { name: "dir/b.bin", data: new Uint8Array([0, 1, 2, 3, 255, 128]) },
      { name: "empty", data: new Uint8Array(0) },
    ];
    const zip = buildZip(files);
    const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);

    // End-of-central-directory is the last 22 bytes (no comment).
    const end = zip.length - 22;
    expect(v.getUint32(end, true)).toBe(0x06054b50);
    const count = v.getUint16(end + 10, true);
    const centralSize = v.getUint32(end + 12, true);
    const centralOffset = v.getUint32(end + 16, true);
    expect(count).toBe(files.length);

    // Walk the central directory and verify each entry against its local data.
    let p = centralOffset;
    const dec = new TextDecoder();
    for (let i = 0; i < count; i++) {
      expect(v.getUint32(p, true)).toBe(0x02014b50);
      const crc = v.getUint32(p + 16, true);
      const size = v.getUint32(p + 20, true);
      const nameLen = v.getUint16(p + 28, true);
      const localOffset = v.getUint32(p + 42, true);
      const name = dec.decode(zip.subarray(p + 46, p + 46 + nameLen));

      const source = files.find((f) => f.name === name)!;
      expect(source).toBeTruthy();
      expect(size).toBe(source.data.length);
      expect(crc).toBe(crc32(source.data));

      // Local header at localOffset → data sits after header + name.
      expect(v.getUint32(localOffset, true)).toBe(0x04034b50);
      const dataStart = localOffset + 30 + nameLen;
      const stored = zip.subarray(dataStart, dataStart + size);
      expect(Array.from(stored)).toEqual(Array.from(source.data));
      // Data descriptor immediately follows the data.
      expect(v.getUint32(dataStart + size, true)).toBe(0x08074b50);

      p += 46 + nameLen;
    }
    expect(p - centralOffset).toBe(centralSize);
  });
});
