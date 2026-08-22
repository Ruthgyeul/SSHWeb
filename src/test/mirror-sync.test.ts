import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import * as protocol from "@/lib/sshProtocol";

// The bridge (`server.mjs`) hand-mirrors constants and security-critical logic
// that also live in `src/lib` — the "two synchronized places" discipline the
// docs describe. The lib copies are unit-tested, but `server.mjs` is not
// imported by those tests (importing it would boot a server), so a silent
// divergence between the two homes would otherwise pass CI. This guard reads
// the bridge source as text and asserts the mirror still matches.

const serverSource = readFileSync(
  fileURLToPath(new URL("../../server.mjs", import.meta.url)),
  "utf8",
);

/**
 * Extract a top-level `const NAME = <arithmetic>;` from server.mjs and evaluate
 * the (numbers-and-operators-only) right-hand side. Returns undefined when the
 * constant isn't a plain arithmetic literal (e.g. it's computed from env).
 */
function serverNumericConst(name: string): number | undefined {
  const m = serverSource.match(
    new RegExp(`\\bconst ${name}\\s*=\\s*([0-9_*/+\\-() \\t]+);`),
  );
  if (!m) return undefined;
  const expr = m[1].replace(/_/g, "").trim();
  if (!/^[0-9*/+\-() \t]+$/.test(expr)) return undefined;
  return Function(`"use strict"; return (${expr});`)() as number;
}

describe("server.mjs ↔ src/lib mirror sync", () => {
  // Numeric constants that must hold the same value in both homes. The client
  // (via sshProtocol) and the bridge gate reads/thumbnails against these, so a
  // drift means the two sides disagree about limits.
  const mirroredNumbers: Array<[string, number]> = [
    ["THUMBNAIL_VIDEO_MAX_BYTES", protocol.THUMBNAIL_VIDEO_MAX_BYTES],
    ["THUMBNAIL_PIXELS", protocol.THUMBNAIL_PIXELS],
    ["PREVIEW_IMAGE_MAX_DIM", protocol.PREVIEW_IMAGE_MAX_DIM],
    ["PREVIEW_IMAGE_MIN_BYTES", protocol.PREVIEW_IMAGE_MIN_BYTES],
    ["PREVIEW_IMAGE_SOURCE_MAX_BYTES", protocol.PREVIEW_IMAGE_SOURCE_MAX_BYTES],
    ["MAX_FIND_RESULTS", protocol.MAX_FIND_RESULTS],
    ["GREP_MAX_FILE_BYTES", protocol.GREP_MAX_FILE_BYTES],
  ];

  for (const [name, libValue] of mirroredNumbers) {
    it(`${name} matches the sshProtocol value`, () => {
      const serverValue = serverNumericConst(name);
      expect(
        serverValue,
        `server.mjs is missing a plain numeric const ${name}`,
      ).toBeTypeOf("number");
      expect(serverValue).toBe(libValue);
    });
  }

  it("accessTokenMatches uses a constant-time comparison", () => {
    // The server copy intentionally diverges from serverSecurity.ts by using
    // crypto.timingSafeEqual (the lib copy uses === for testability). If the
    // server path ever regresses to a plain === compare it silently reintroduces
    // a timing side-channel that serverSecurity.test.ts can't catch — guard it.
    const fn = serverSource.match(
      /function accessTokenMatches\([^)]*\)\s*\{([\s\S]*?)\n\}/,
    );
    expect(fn, "accessTokenMatches not found in server.mjs").not.toBeNull();
    const body = fn![1];
    expect(body).toContain("timingSafeEqual");
    expect(body).not.toMatch(/return\s+\w+\s*===\s*\w+/);
  });
});
