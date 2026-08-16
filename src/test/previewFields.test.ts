// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  previewFieldsFromBytes,
  previewRenderKind,
} from "@/components/ssh/preview/previewFields";

const bytesOf = (s: string) =>
  new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>;

beforeEach(() => {
  // jsdom lacks blob-URL helpers; media/PDF fields build one.
  URL.createObjectURL = vi.fn(
    (b: Blob) => `blob:${(b as Blob).type}`,
  ) as typeof URL.createObjectURL;
});
afterEach(() => vi.restoreAllMocks());

describe("previewRenderKind", () => {
  it("resolves media by extension", () => {
    expect(previewRenderKind("a.png")).toBe("image");
    expect(previewRenderKind("a.mp4")).toBe("video");
    expect(previewRenderKind("a.md")).toBe("markdown");
  });
  it("falls back to text for editable names and unsupported otherwise", () => {
    expect(previewRenderKind("notes.txt")).toBe("text");
    expect(previewRenderKind("Dockerfile")).toBe("text");
    expect(previewRenderKind("blob.bin")).toBe("unsupported");
  });
});

describe("previewFieldsFromBytes", () => {
  it("decodes text without a blob URL", () => {
    const f = previewFieldsFromBytes("a.txt", bytesOf("hello"));
    expect(f.kind).toBe("text");
    expect(f.text).toBe("hello");
    expect(f.src).toBe("");
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("flags non-UTF-8 text via the replacement char", () => {
    const bad = new Uint8Array([0xff, 0xfe, 0x41]) as Uint8Array<ArrayBuffer>;
    const f = previewFieldsFromBytes("a.txt", bad);
    expect(f.kind).toBe("text");
    expect(f.encodingWarning).toBe(true);
  });

  it("builds a blob URL for a media file, honoring a mime override", () => {
    const f = previewFieldsFromBytes("photo.jpg", bytesOf("x"), "image/webp");
    expect(f.kind).toBe("image");
    expect(f.src).toBe("blob:image/webp");
    expect(f.text).toBeUndefined();
  });

  it("sniffs a mis-named media file by magic number", () => {
    // A JPEG (FF D8 FF) named as a text file still previews as image.
    // sniffMediaKind needs at least 12 bytes to read a magic number.
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
    ]) as Uint8Array<ArrayBuffer>;
    const f = previewFieldsFromBytes("photo.txt", jpeg);
    expect(f.kind).toBe("image");
    expect(f.src.startsWith("blob:")).toBe(true);
  });

  it("returns a download-only card for undecodable non-text bytes", () => {
    const f = previewFieldsFromBytes("blob.bin", bytesOf("\x00\x01rubbish"));
    expect(f.kind).toBe("unsupported");
    expect(f.src).toBe("");
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});
