/**
 * Browser-side download helper for the web SSH client.
 *
 * Unlike the pure helpers in `src/lib`, this touches the DOM (`Blob`,
 * `URL.createObjectURL`, an anchor click), so it lives next to the SSH
 * components rather than in `lib/`. The bytes it saves come from
 * `src/lib/bytes.ts`.
 */

/** Kick off a browser download of some bytes under the given filename. */
export function triggerDownload(name: string, bytes: Uint8Array<ArrayBuffer>) {
  const url = URL.createObjectURL(new Blob([bytes]));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
