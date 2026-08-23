/**
 * Pure `hexdump -C`-style formatter for a read-only hex view of binary files
 * (#75). DOM-free and unit-tested; the FilePreview hex mode renders its output.
 *
 * Each line is: an 8-hex-digit offset, up to 16 space-separated byte values
 * (grouped 8 + 8 with an extra gap), then the ASCII gutter with non-printable
 * bytes shown as ".". Short final lines are padded so the ASCII column aligns.
 */

const PRINTABLE_MIN = 0x20;
const PRINTABLE_MAX = 0x7e;

/** One formatted row of a hex dump. */
export interface HexRow {
  /** Byte offset of the row start, as an 8-digit hex string. */
  offset: string;
  /** The hex-pair column (fixed width, space-padded for a short final row). */
  hex: string;
  /** The ASCII gutter (printable bytes, "." otherwise). */
  ascii: string;
}

/** Bytes per row — the conventional 16. */
export const HEX_BYTES_PER_ROW = 16;

function toHexByte(b: number): string {
  return b.toString(16).padStart(2, "0");
}

/** Format a single 16-byte (or shorter, for the last row) slice. */
export function formatHexRow(bytes: Uint8Array, offset: number): HexRow {
  const parts: string[] = [];
  let ascii = "";
  for (let i = 0; i < HEX_BYTES_PER_ROW; i++) {
    if (i === 8) parts.push(""); // extra gap between the two 8-byte groups
    if (i < bytes.length) {
      const b = bytes[i];
      parts.push(toHexByte(b));
      ascii +=
        b >= PRINTABLE_MIN && b <= PRINTABLE_MAX ? String.fromCharCode(b) : ".";
    } else {
      parts.push("  "); // pad a short final row so the ASCII column aligns
    }
  }
  return {
    // Fixed-width hex column (short final rows are space-padded above) so the
    // ASCII gutter stays aligned across every row.
    offset: offset.toString(16).padStart(8, "0"),
    hex: parts.join(" "),
    ascii,
  };
}

/** Format an entire byte array into hex-dump rows. */
export function hexDumpRows(bytes: Uint8Array): HexRow[] {
  const rows: HexRow[] = [];
  for (let off = 0; off < bytes.length; off += HEX_BYTES_PER_ROW) {
    rows.push(formatHexRow(bytes.subarray(off, off + HEX_BYTES_PER_ROW), off));
  }
  return rows;
}

/** Render a full `hexdump -C`-style string (offset  hex  |ascii|). */
export function hexDump(bytes: Uint8Array): string {
  return hexDumpRows(bytes)
    .map((r) => `${r.offset}  ${r.hex}  |${r.ascii}|`)
    .join("\n");
}
