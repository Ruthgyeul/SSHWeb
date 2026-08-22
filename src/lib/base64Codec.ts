/**
 * Async base64 <-> bytes codec that offloads large payloads to a Web Worker so a
 * big editor save (or any large single-buffer encode/decode) doesn't block the
 * main thread and jank the UI (#98).
 *
 * It is a strict superset of the synchronous helpers in `bytes.ts`:
 *   - Small payloads (below WORKER_MIN_BYTES) run synchronously — the worker's
 *     message round-trip would cost more than the work itself.
 *   - Large payloads run in a lazily-created inline worker (built from a Blob URL
 *     so no separate bundler worker-entry is needed).
 *   - If Workers are unavailable (SSR, older runtimes) or the worker errors, it
 *     falls back to the synchronous path — so the result is always identical to
 *     `bytes.ts`, never a failure.
 *
 * The worker body mirrors the exact chunked algorithm in `bytes.ts`.
 */

import { base64ToBytes, bytesToBase64 } from "./bytes";

/** Below this size the sync path wins (worker round-trip isn't worth it). */
export const WORKER_MIN_BYTES = 256 * 1024;

const WORKER_SOURCE = `
self.onmessage = function (e) {
  var id = e.data.id, op = e.data.op, data = e.data.data;
  try {
    if (op === "encode") {
      var bytes = new Uint8Array(data);
      var bin = "";
      var chunk = 0x8000;
      for (var i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      self.postMessage({ id: id, result: self.btoa(bin) });
    } else {
      var s = self.atob(data);
      var out = new Uint8Array(s.length);
      for (var j = 0; j < s.length; j++) out[j] = s.charCodeAt(j);
      self.postMessage({ id: id, result: out.buffer }, [out.buffer]);
    }
  } catch (err) {
    self.postMessage({ id: id, error: String(err) });
  }
};
`;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
}

let worker: Worker | null = null;
let workerFailed = false;
let nextId = 1;
const pending = new Map<number, Pending>();

/** Lazily create the shared inline worker; returns null if unsupported. */
function getWorker(): Worker | null {
  if (workerFailed) return null;
  if (worker) return worker;
  if (typeof Worker === "undefined" || typeof Blob === "undefined") return null;
  try {
    const url = URL.createObjectURL(
      new Blob([WORKER_SOURCE], { type: "application/javascript" }),
    );
    worker = new Worker(url);
    URL.revokeObjectURL(url);
    worker.onmessage = (e: MessageEvent) => {
      const { id, result, error } = e.data as {
        id: number;
        result?: unknown;
        error?: string;
      };
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (error) p.reject(new Error(error));
      else p.resolve(result);
    };
    worker.onerror = () => {
      // Fail every in-flight request over to the sync fallback and stop using
      // the worker for the rest of the session.
      workerFailed = true;
      for (const [, p] of pending) p.reject(new Error("worker error"));
      pending.clear();
      try {
        worker?.terminate();
      } catch {
        /* already gone */
      }
      worker = null;
    };
    return worker;
  } catch {
    workerFailed = true;
    return null;
  }
}

function post<T>(
  op: "encode" | "decode",
  data: unknown,
  transfer?: Transferable[],
): Promise<T> {
  const w = getWorker();
  if (!w) return Promise.reject(new Error("no worker"));
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, {
      resolve: resolve as (v: unknown) => void,
      reject,
    });
    w.postMessage({ id, op, data }, transfer ?? []);
  });
}

/** Encode bytes to base64, offloading large inputs to the worker. */
export async function bytesToBase64Async(bytes: Uint8Array): Promise<string> {
  if (bytes.length < WORKER_MIN_BYTES) return bytesToBase64(bytes);
  try {
    // Copy into a transferable ArrayBuffer sized to the view.
    const copy = bytes.slice();
    return await post<string>("encode", copy.buffer, [copy.buffer]);
  } catch {
    return bytesToBase64(bytes);
  }
}

/** Decode base64 to bytes, offloading large inputs to the worker. */
export async function base64ToBytesAsync(b64: string): Promise<Uint8Array> {
  if (b64.length < WORKER_MIN_BYTES) return base64ToBytes(b64);
  try {
    const buf = await post<ArrayBuffer>("decode", b64);
    return new Uint8Array(buf);
  } catch {
    return base64ToBytes(b64);
  }
}
