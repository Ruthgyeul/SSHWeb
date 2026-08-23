import { describe, expect, it } from "vitest";
import {
  formatHexRow,
  hexDump,
  hexDumpRows,
  HEX_BYTES_PER_ROW,
} from "@/lib/hexDump";

describe("formatHexRow", () => {
  it("formats a full 16-byte row with the mid-row group gap and ASCII gutter", () => {
    const bytes = new Uint8Array([
      0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x2c, 0x20, 0x57, 0x6f, 0x72, 0x6c, 0x64,
      0x21, 0x0a, 0x00, 0xff,
    ]);
    const row = formatHexRow(bytes, 0);
    expect(row.offset).toBe("00000000");
    expect(row.hex).toBe("48 65 6c 6c 6f 2c 20 57  6f 72 6c 64 21 0a 00 ff");
    // Printable → char; newline, NUL, 0xff → ".".
    expect(row.ascii).toBe("Hello, World!...");
  });

  it("pads a short final row so the ASCII column stays aligned", () => {
    const full = formatHexRow(new Uint8Array(16).fill(0x41), 0);
    const short = formatHexRow(new Uint8Array([0x41, 0x42, 0x43]), 0x10);
    expect(short.offset).toBe("00000010");
    // Same hex-column width as a full row (padding spaces fill the rest).
    expect(short.hex.length).toBe(full.hex.length);
    expect(short.hex.startsWith("41 42 43")).toBe(true);
    expect(short.ascii).toBe("ABC");
  });
});

describe("hexDumpRows / hexDump", () => {
  it("splits into 16-byte rows with increasing offsets", () => {
    const bytes = new Uint8Array(20).map((_, i) => i);
    const rows = hexDumpRows(bytes);
    expect(rows).toHaveLength(2);
    expect(rows[0].offset).toBe("00000000");
    expect(rows[1].offset).toBe("00000010");
    expect(rows[1].ascii).toBe("...."); // bytes 16–19 are non-printable
  });

  it("renders a hexdump -C-style string aligned to the row width", () => {
    const dump = hexDump(new Uint8Array([0x61, 0x62, 0x63]));
    const row = formatHexRow(new Uint8Array([0x61, 0x62, 0x63]), 0);
    expect(dump).toBe(`${row.offset}  ${row.hex}  |abc|`);
    expect(dump.startsWith("00000000  61 62 63")).toBe(true);
    expect(dump.endsWith("|abc|")).toBe(true);
  });

  it("returns an empty string / no rows for empty input", () => {
    expect(hexDumpRows(new Uint8Array())).toEqual([]);
    expect(hexDump(new Uint8Array())).toBe("");
  });

  it("uses a 16-byte row width", () => {
    expect(HEX_BYTES_PER_ROW).toBe(16);
  });
});
