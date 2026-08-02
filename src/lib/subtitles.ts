/**
 * Sidecar-subtitle helpers for the video preview. A `<video>` can only load a
 * `<track>` in WebVTT, so an SRT sidecar is converted to VTT client-side before
 * being handed to the element. Pure and DOM-free so it unit-tests under Vitest.
 */

/** Subtitle sidecar extensions we look for next to a video, in preference order
 * (VTT is native; SRT is converted). */
const SUBTITLE_EXTENSIONS = ["vtt", "srt"] as const;

/** Strip a filename's final extension (`clip.mp4` → `clip`); no extension → the
 * name unchanged. */
function stripExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? name : name.slice(0, dot);
}

/**
 * Find the best sidecar-subtitle file for `videoName` among `names` (the sibling
 * filenames in the same directory). Matches on the shared base name — both an
 * exact `clip.mp4` → `clip.srt` and a language-tagged `clip.en.srt` — preferring
 * a `.vtt` (native) over a `.srt` (needs conversion). Case-insensitive; returns
 * the matching filename, or `null` when there's no sidecar.
 */
export function findSubtitleSidecar(
  videoName: string,
  names: string[],
): string | null {
  const base = stripExtension(videoName).toLowerCase();
  if (!base) return null;
  let exact: string | null = null;
  let tagged: string | null = null;
  let taggedExt: number = SUBTITLE_EXTENSIONS.length;
  for (const name of names) {
    const lower = name.toLowerCase();
    const dot = lower.lastIndexOf(".");
    if (dot < 0) continue;
    const ext = lower.slice(dot + 1);
    const extRank = SUBTITLE_EXTENSIONS.indexOf(ext as (typeof SUBTITLE_EXTENSIONS)[number]);
    if (extRank < 0) continue;
    const stem = lower.slice(0, dot);
    if (stem === base) {
      // Exact base match: prefer .vtt over .srt (lower rank wins).
      if (exact === null || extRank < SUBTITLE_EXTENSIONS.indexOf(exactExt(exact))) {
        exact = name;
      }
    } else if (stem.startsWith(`${base}.`)) {
      // Language-tagged match (`clip.en.srt`); kept as a fallback behind exact.
      if (extRank < taggedExt) {
        tagged = name;
        taggedExt = extRank;
      }
    }
  }
  return exact ?? tagged;
}

/** The subtitle extension of an already-matched sidecar filename. */
function exactExt(name: string): (typeof SUBTITLE_EXTENSIONS)[number] {
  const dot = name.lastIndexOf(".");
  return name.slice(dot + 1).toLowerCase() as (typeof SUBTITLE_EXTENSIONS)[number];
}

/** Whether a sidecar filename needs SRT→VTT conversion before use in a track. */
export function subtitleNeedsConversion(name: string): boolean {
  return /\.srt$/i.test(name);
}

/**
 * Convert SubRip (`.srt`) text to WebVTT. WebVTT differs by a `WEBVTT` header
 * and `.`-decimal timestamps (SRT uses `,`); cue index lines are dropped (VTT
 * ignores them anyway). Already-VTT text (starts with `WEBVTT`) is returned
 * unchanged. Robust to `\r\n`/`\r` line endings.
 */
export function srtToVtt(srt: string): string {
  const text = srt.replace(/^﻿/, ""); // drop a leading BOM
  if (/^\s*WEBVTT/.test(text)) return text;
  const body = text
    .replace(/\r\n|\r/g, "\n")
    // `00:00:01,000 --> 00:00:04,000` → `00:00:01.000 --> 00:00:04.000`
    .replace(
      /(\d{2}:\d{2}:\d{2}),(\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}),(\d{3})/g,
      "$1.$2 --> $3.$4",
    )
    // Drop standalone numeric cue-index lines (VTT doesn't use them). Use
    // [ \t] (not \s) so the class can't swallow the line's own newline.
    .replace(/^\d+[ \t]*\n/gm, "");
  return `WEBVTT\n\n${body.replace(/^\n+/, "")}`;
}

/** A short language label from a language-tagged sidecar name (`clip.en.srt` →
 * `EN`), or a generic "Subtitles" when there's no tag. */
export function subtitleLabel(videoName: string, sidecarName: string): string {
  const base = stripExtension(videoName).toLowerCase();
  const stem = stripExtension(sidecarName);
  const lowerStem = stem.toLowerCase();
  if (lowerStem.startsWith(`${base}.`)) {
    const tag = stem.slice(base.length + 1);
    if (tag) return tag.toUpperCase();
  }
  return "Subtitles";
}
