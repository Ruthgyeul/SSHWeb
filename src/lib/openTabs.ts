/**
 * Persistence for the SSH client's open tabs (#25). A page reload otherwise
 * loses every open tab and its custom name; this stores just enough to restore
 * the tab strip — each tab's name and its connection *identity* (host / port /
 * username / auth method). It deliberately stores **no secrets** (never a
 * password, private key, or passphrase), matching the connection-profiles rule.
 * On restore a tab reopens showing its connect form pre-filled, ready to
 * reconnect — the credentials are re-entered, nothing is auto-connected.
 *
 * Pure and DOM-free (the hook/component owns localStorage), so it unit-tests
 * under Vitest's node environment.
 */

export type PersistedAuth = "password" | "key";

export interface PersistedConnect {
  host: string;
  port: string;
  username: string;
  auth: PersistedAuth;
}

export interface PersistedTab {
  name?: string;
  connect?: PersistedConnect;
}

/** Upper bound so a runaway writer can't grow the stored list without limit. */
export const MAX_PERSISTED_TABS = 20;

function sanitizeConnect(value: unknown): PersistedConnect | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const host = typeof v.host === "string" ? v.host.trim().slice(0, 255) : "";
  const username =
    typeof v.username === "string" ? v.username.trim().slice(0, 255) : "";
  if (!host || !username) return undefined;
  const portRaw = typeof v.port === "string" ? v.port.trim() : "";
  const port = /^\d{1,5}$/.test(portRaw) ? portRaw : "22";
  const auth: PersistedAuth = v.auth === "key" ? "key" : "password";
  return { host, port, username, auth };
}

/**
 * Parse the stored tab list, dropping anything malformed. Entries with neither a
 * name nor a valid connection are discarded; the result is capped at
 * {@link MAX_PERSISTED_TABS}. Any parse error yields an empty list.
 */
export function parseOpenTabs(raw: string | null | undefined): PersistedTab[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: PersistedTab[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const name =
      typeof rec.name === "string" && rec.name.trim() !== ""
        ? rec.name.trim().slice(0, 100)
        : undefined;
    const connect = sanitizeConnect(rec.connect);
    if (!name && !connect) continue;
    out.push({ name, connect });
    if (out.length >= MAX_PERSISTED_TABS) break;
  }
  return out;
}

/** Serialize a tab list for storage (capped, secrets already excluded upstream). */
export function serializeOpenTabs(tabs: PersistedTab[]): string {
  return JSON.stringify(tabs.slice(0, MAX_PERSISTED_TABS));
}
