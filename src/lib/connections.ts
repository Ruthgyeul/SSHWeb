/**
 * Pure helpers for the multi-tab "same server" quick-connect: turning a
 * connection into a short label and picking the reusable connections to offer a
 * given tab. Kept DOM-free in `lib/` so they can be unit-tested; the wiring
 * (state, props) lives in `SshClient`.
 */

/** The minimal shape a connection needs to be labelled/de-duplicated. */
export interface ConnectionLike {
  username: string;
  host: string;
  port: number;
}

/** A short `user@host` label, appending `:port` only when it isn't the default 22. */
export function connectionLabel(d: ConnectionLike): string {
  return `${d.username}@${d.host}${d.port !== 22 ? `:${d.port}` : ""}`;
}

/**
 * Build the list of connections to offer tab `selfId` as one-click logins:
 * every *other* tab's live connection, de-duplicated by label so a server that
 * several tabs are on appears only once (the first occurrence wins).
 */
export function reusableConnectionsExcluding<T extends ConnectionLike>(
  connections: Record<number, T>,
  selfId: number,
): { label: string; details: T }[] {
  const seen = new Set<string>();
  const out: { label: string; details: T }[] = [];
  for (const [id, details] of Object.entries(connections)) {
    if (Number(id) === selfId) continue;
    const label = connectionLabel(details);
    if (seen.has(label)) continue;
    seen.add(label);
    out.push({ label, details });
  }
  return out;
}
