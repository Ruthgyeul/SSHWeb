/**
 * Pure helpers for the trust-on-first-use (TOFU) host-key store.
 *
 * The browser keeps a `host:port → SHA256 fingerprint` map in localStorage
 * (see `SshSession.tsx`, which owns the storage read/write). Everything here is
 * DOM-free so it runs under Vitest's node environment (see `knownHosts.test.ts`)
 * — the localStorage wrappers in the component build on these functions.
 */

/** localStorage key holding the trusted host-key fingerprints (TOFU store). */
export const KNOWN_HOSTS_KEY = "sshweb.knownHosts";

/** The stored shape: a flat `"host:port" → "SHA256:…"` fingerprint map. */
export type KnownHostMap = Record<string, string>;

/** One trusted host, split out of the flat map for display in a management UI. */
export interface KnownHostEntry {
  /** The raw storage key, `"host:port"`. */
  id: string;
  /** Hostname portion of the id. */
  host: string;
  /** Port portion of the id (falls back to `22` when the id has none). */
  port: number;
  /** The trusted `SHA256:…` fingerprint. */
  fingerprint: string;
}

/**
 * Parse the raw localStorage value into a clean `KnownHostMap`. Anything that
 * isn't a JSON object of string values (corrupt/old data) yields an empty map,
 * so a bad entry can never break the store.
 */
export function parseKnownHosts(raw: string | null | undefined): KnownHostMap {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: KnownHostMap = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/** Serialize a `KnownHostMap` back to the string stored in localStorage. */
export function serializeKnownHosts(map: KnownHostMap): string {
  return JSON.stringify(map);
}

/** Split a `"host:port"` id into its parts (defaulting the port to 22). */
export function splitHostId(id: string): { host: string; port: number } {
  const idx = id.lastIndexOf(":");
  if (idx < 0) return { host: id, port: 22 };
  const host = id.slice(0, idx);
  const port = Number(id.slice(idx + 1));
  return { host, port: Number.isFinite(port) && port > 0 ? port : 22 };
}

/**
 * Expand a `KnownHostMap` into a display list, sorted by host then port so a
 * management UI renders them in a stable, human-friendly order.
 */
export function knownHostEntries(map: KnownHostMap): KnownHostEntry[] {
  return Object.entries(map)
    .map(([id, fingerprint]) => {
      const { host, port } = splitHostId(id);
      return { id, host, port, fingerprint };
    })
    .sort((a, b) => {
      const byHost = a.host.localeCompare(b.host, undefined, {
        sensitivity: "base",
      });
      return byHost !== 0 ? byHost : a.port - b.port;
    });
}

/** Return a copy of `map` with `id` removed (does not mutate the input). */
export function removeKnownHost(map: KnownHostMap, id: string): KnownHostMap {
  if (!(id in map)) return map;
  const next = { ...map };
  delete next[id];
  return next;
}
