/**
 * Pure byte <-> base64 helpers used by the web SSH client to move file and
 * terminal data across the JSON wire protocol (which carries binary as base64).
 *
 * Everything here is DOM-free — it relies only on `atob`/`btoa` and the typed
 * array globals, so it runs under Vitest's node environment (see `bytes.test.ts`)
 * the same way the rest of `src/lib` does.
 */

/** Decode a base64 string to raw bytes (e.g. terminal output before xterm). */
export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const buffer = new ArrayBuffer(bin.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Encode raw bytes to base64 in chunks (avoids call-stack limits on big files). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Concatenate a list of byte chunks into one contiguous buffer. */
export function concatBytes(chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
