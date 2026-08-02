import { describe, expect, it } from "vitest";
import {
  findSubtitleSidecar,
  srtToVtt,
  subtitleLabel,
  subtitleNeedsConversion,
} from "@/lib/subtitles";

describe("findSubtitleSidecar", () => {
  it("matches an exact base name, preferring .vtt over .srt", () => {
    const names = ["clip.mp4", "clip.srt", "clip.vtt", "other.srt"];
    expect(findSubtitleSidecar("clip.mp4", names)).toBe("clip.vtt");
  });

  it("falls back to a language-tagged sidecar", () => {
    const names = ["movie.mkv", "movie.en.srt", "movie.fr.srt"];
    expect(findSubtitleSidecar("movie.mkv", names)).toBe("movie.en.srt");
  });

  it("is case-insensitive", () => {
    expect(findSubtitleSidecar("Clip.MP4", ["CLIP.SRT"])).toBe("CLIP.SRT");
  });

  it("returns null when there's no sidecar", () => {
    expect(findSubtitleSidecar("clip.mp4", ["clip.mp4", "notes.txt"])).toBeNull();
    expect(findSubtitleSidecar("clip.mp4", [])).toBeNull();
  });

  it("prefers an exact match over a language-tagged one", () => {
    const names = ["clip.mp4", "clip.srt", "clip.en.srt"];
    expect(findSubtitleSidecar("clip.mp4", names)).toBe("clip.srt");
  });
});

describe("subtitleNeedsConversion", () => {
  it("is true only for .srt", () => {
    expect(subtitleNeedsConversion("a.srt")).toBe(true);
    expect(subtitleNeedsConversion("a.SRT")).toBe(true);
    expect(subtitleNeedsConversion("a.vtt")).toBe(false);
  });
});

describe("srtToVtt", () => {
  it("adds the WEBVTT header and dot-decimal timestamps, dropping cue indices", () => {
    const srt = [
      "1",
      "00:00:01,000 --> 00:00:04,000",
      "Hello, world",
      "",
      "2",
      "00:00:05,500 --> 00:00:06,000",
      "Second line",
      "",
    ].join("\n");
    const vtt = srtToVtt(srt);
    expect(vtt.startsWith("WEBVTT")).toBe(true);
    expect(vtt).toContain("00:00:01.000 --> 00:00:04.000");
    expect(vtt).toContain("00:00:05.500 --> 00:00:06.000");
    expect(vtt).toContain("Hello, world");
    // Numeric cue-index lines are gone.
    expect(vtt).not.toMatch(/^\s*1\s*$/m);
  });

  it("handles CRLF line endings", () => {
    const srt = "1\r\n00:00:01,000 --> 00:00:02,000\r\nHi\r\n";
    const vtt = srtToVtt(srt);
    expect(vtt).toContain("00:00:01.000 --> 00:00:02.000");
    expect(vtt).toContain("Hi");
  });

  it("passes already-VTT text through unchanged", () => {
    const already = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n";
    expect(srtToVtt(already)).toBe(already);
  });
});

describe("subtitleLabel", () => {
  it("derives an uppercase language tag when present", () => {
    expect(subtitleLabel("movie.mkv", "movie.en.srt")).toBe("EN");
    expect(subtitleLabel("movie.mkv", "movie.pt-br.vtt")).toBe("PT-BR");
  });

  it("uses a generic label for an untagged sidecar", () => {
    expect(subtitleLabel("clip.mp4", "clip.srt")).toBe("Subtitles");
  });
});
