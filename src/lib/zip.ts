/**
 * Minimal streaming ZIP (store-only) record builders.
 *
 * The SSH bridge zips a folder / multi-selection for download. Building the
 * whole archive in memory and sending it in one frame could OOM the shared
 * process on a large tree; instead the bridge streams it entry-by-entry over the
 * chunked download frames, reading each file as a stream and computing its CRC
 * incrementally. That means the CRC/size aren't known when the local header is
 * written, so every entry uses a **data descriptor** (general-purpose flag bit
 * 3) carrying the CRC and sizes *after* the data.
 *
 * These pure byte-layout builders are the unit-tested source of truth; the
 * orchestration (walking the tree, streaming files, backpressure) lives in
 * `server.mjs`, which hand-mirrors them (the "two synchronized places"
 * discipline). Store-only (no compression) keeps it dependency-free and lets a
 * file stream straight through.
 *
 * Sizes/offsets are 32-bit here (classic ZIP). An archive whose total size or a
 * single entry would exceed {@link ZIP32_MAX} needs ZIP64, which this does not
 * emit — the caller must detect that (see {@link exceedsZip32}) and abort rather
 * than silently overflow.
 */

/** The largest value a 32-bit ZIP size/offset field can hold. */
export const ZIP32_MAX = 0xffffffff;

/** Whether a size/offset no longer fits a 32-bit ZIP field (needs ZIP64). */
export function exceedsZip32(value: number): boolean {
  return value >= ZIP32_MAX;
}

/* ------------------------------------------------------------------ */
/* CRC-32 (incremental)                                                */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** Start an incremental CRC-32 accumulation. */
export function crc32Init(): number {
  return 0xffffffff;
}

/** Fold `buf` into a running CRC-32 (from {@link crc32Init}). */
export function crc32Update(crc: number, buf: Uint8Array): number {
  let c = crc >>> 0;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return c >>> 0;
}

/** Finalize a running CRC-32 into its output value. */
export function crc32Final(crc: number): number {
  return (crc ^ 0xffffffff) >>> 0;
}

/** One-shot CRC-32 of a buffer. */
export function crc32(buf: Uint8Array): number {
  return crc32Final(crc32Update(crc32Init(), buf));
}

/* ------------------------------------------------------------------ */
/* ZIP records                                                         */
/* ------------------------------------------------------------------ */

const LOCAL_SIG = 0x04034b50;
const DATA_DESC_SIG = 0x08074b50;
const CENTRAL_SIG = 0x02014b50;
const END_SIG = 0x06054b50;
// General-purpose flags: bit 11 = UTF-8 names, bit 3 = data descriptor follows.
const FLAG_UTF8 = 0x0800;
const FLAG_DATA_DESCRIPTOR = 0x0008;
const FLAGS = FLAG_UTF8 | FLAG_DATA_DESCRIPTOR;
const VERSION = 20; // 2.0 — enough for store + data descriptor

/**
 * The 30-byte local file header (+ the name follows separately). CRC and sizes
 * are zero here — they travel in the trailing data descriptor once the streamed
 * file's length and CRC are known.
 */
export function zipLocalHeader(nameLength: number): Uint8Array {
  const h = new Uint8Array(30);
  const v = new DataView(h.buffer);
  v.setUint32(0, LOCAL_SIG, true);
  v.setUint16(4, VERSION, true);
  v.setUint16(6, FLAGS, true);
  v.setUint16(8, 0, true); // method: store
  v.setUint16(10, 0, true); // mod time
  v.setUint16(12, 0, true); // mod date
  v.setUint32(14, 0, true); // crc-32 (in data descriptor)
  v.setUint32(18, 0, true); // compressed size (in data descriptor)
  v.setUint32(22, 0, true); // uncompressed size (in data descriptor)
  v.setUint16(26, nameLength, true);
  v.setUint16(28, 0, true); // extra length
  return h;
}

/** The 16-byte data descriptor written after an entry's streamed data. */
export function zipDataDescriptor(crc: number, size: number): Uint8Array {
  const d = new Uint8Array(16);
  const v = new DataView(d.buffer);
  v.setUint32(0, DATA_DESC_SIG, true);
  v.setUint32(4, crc >>> 0, true);
  v.setUint32(8, size >>> 0, true); // compressed size (store → == uncompressed)
  v.setUint32(12, size >>> 0, true); // uncompressed size
  return d;
}

/** A central-directory record for one entry (+ the name follows separately). */
export function zipCentralHeader(opts: {
  nameLength: number;
  crc: number;
  size: number;
  offset: number;
}): Uint8Array {
  const h = new Uint8Array(46);
  const v = new DataView(h.buffer);
  v.setUint32(0, CENTRAL_SIG, true);
  v.setUint16(4, VERSION, true); // version made by
  v.setUint16(6, VERSION, true); // version needed
  v.setUint16(8, FLAGS, true);
  v.setUint16(10, 0, true); // method: store
  v.setUint16(12, 0, true); // mod time
  v.setUint16(14, 0, true); // mod date
  v.setUint32(16, opts.crc >>> 0, true);
  v.setUint32(20, opts.size >>> 0, true); // compressed size
  v.setUint32(24, opts.size >>> 0, true); // uncompressed size
  v.setUint16(28, opts.nameLength, true);
  v.setUint16(30, 0, true); // extra length
  v.setUint16(32, 0, true); // comment length
  v.setUint16(34, 0, true); // disk number start
  v.setUint16(36, 0, true); // internal attrs
  v.setUint32(38, 0, true); // external attrs
  v.setUint32(42, opts.offset >>> 0, true); // local header offset
  return h;
}

/** The 22-byte end-of-central-directory record that closes the archive. */
export function zipEndRecord(opts: {
  count: number;
  centralSize: number;
  centralOffset: number;
}): Uint8Array {
  const e = new Uint8Array(22);
  const v = new DataView(e.buffer);
  v.setUint32(0, END_SIG, true);
  v.setUint16(4, 0, true); // this disk
  v.setUint16(6, 0, true); // disk with central dir
  v.setUint16(8, opts.count & 0xffff, true); // entries on this disk
  v.setUint16(10, opts.count & 0xffff, true); // total entries
  v.setUint32(12, opts.centralSize >>> 0, true);
  v.setUint32(16, opts.centralOffset >>> 0, true);
  v.setUint16(20, 0, true); // comment length
  return e;
}
