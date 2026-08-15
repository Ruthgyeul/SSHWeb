import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CLIENT_MESSAGE_FIELDS,
  GREP_MAX_FILE_BYTES,
  MAX_FIND_RESULTS,
  PREVIEW_IMAGE_MAX_DIM,
  PREVIEW_IMAGE_MIN_BYTES,
  PREVIEW_IMAGE_QUALITY,
  PREVIEW_IMAGE_SOURCE_MAX_BYTES,
  THUMBNAIL_PIXELS,
  THUMBNAIL_VIDEO_MAX_BYTES,
} from "@/lib/sshProtocol";

/**
 * `server.mjs` runs outside the TypeScript/Next build, so several protocol
 * constants and the message-validation table are *hand-mirrored* there from
 * `src/lib/sshProtocol.ts` ("two synchronized places"). Nothing normally
 * catches it when the two drift apart. This suite reads `server.mjs` as text and
 * asserts the mirrored values still match the TypeScript source of truth.
 *
 * We read the source rather than importing `server.mjs` because importing it
 * would boot the real HTTP/WebSocket server (that's the job of the separate
 * integration test).
 */
const serverSource = readFileSync(
  fileURLToPath(new URL("../../server.mjs", import.meta.url)),
  "utf8",
);

/** Read `const NAME = <plain numeric expression>;` from the server source. */
function serverNumber(name: string): number {
  const m = serverSource.match(new RegExp(`\\bconst ${name} = ([^;]+);`));
  if (!m) throw new Error(`server.mjs: const ${name} not found`);
  const expr = m[1].trim();
  if (!/^[0-9*+\s]+$/.test(expr)) {
    throw new Error(`server.mjs: const ${name} is not a plain number: ${expr}`);
  }
  return Function(`"use strict"; return (${expr});`)() as number;
}

/** Extract an object literal `const NAME = { ... };` and evaluate it. */
function serverObject(name: string): unknown {
  const m = serverSource.match(
    new RegExp(`\\bconst ${name} = (\\{[\\s\\S]*?\\n\\});`),
  );
  if (!m) throw new Error(`server.mjs: const ${name} object not found`);
  return Function(`"use strict"; return (${m[1]});`)();
}

describe("mirror consistency: sshProtocol.ts ↔ server.mjs", () => {
  it("mirrors the numeric protocol constants", () => {
    expect(serverNumber("MAX_FIND_RESULTS")).toBe(MAX_FIND_RESULTS);
    expect(serverNumber("GREP_MAX_FILE_BYTES")).toBe(GREP_MAX_FILE_BYTES);
    expect(serverNumber("THUMBNAIL_PIXELS")).toBe(THUMBNAIL_PIXELS);
    expect(serverNumber("THUMBNAIL_VIDEO_MAX_BYTES")).toBe(
      THUMBNAIL_VIDEO_MAX_BYTES,
    );
    expect(serverNumber("PREVIEW_IMAGE_MAX_DIM")).toBe(PREVIEW_IMAGE_MAX_DIM);
    expect(serverNumber("PREVIEW_IMAGE_MIN_BYTES")).toBe(
      PREVIEW_IMAGE_MIN_BYTES,
    );
    expect(serverNumber("PREVIEW_IMAGE_SOURCE_MAX_BYTES")).toBe(
      PREVIEW_IMAGE_SOURCE_MAX_BYTES,
    );
  });

  it("mirrors the default preview-image quality", () => {
    // The server reads SSH_PREVIEW_IMAGE_QUALITY with a hardcoded default that
    // must equal the TypeScript constant.
    const m = serverSource.match(/SSH_PREVIEW_IMAGE_QUALITY \|\| "(\d+)"/);
    expect(m, "default quality literal present in server.mjs").not.toBeNull();
    expect(Number(m![1])).toBe(PREVIEW_IMAGE_QUALITY);
  });

  it("mirrors the client-message required-field table", () => {
    expect(serverObject("CLIENT_MESSAGE_FIELDS")).toEqual(
      CLIENT_MESSAGE_FIELDS,
    );
  });
});
