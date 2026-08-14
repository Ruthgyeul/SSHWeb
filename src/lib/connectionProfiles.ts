/**
 * Saved connection profiles (recent hosts) for the SSH login form.
 *
 * A profile remembers only the **connection identity** — host, port, username
 * and which auth method to preselect — never the password or private key. Those
 * stay a per-login secret, matching the project's rule that credentials are
 * relayed to the target host and never stored. The pure list logic lives here
 * (unit-tested); `useConnectionProfiles` wraps it in localStorage.
 */
import type { AuthMethod } from "./sshProtocol";
import { connectionLabel, type ConnectionLike } from "./connections";

export interface ConnectionProfile {
  id: string;
  /** Display name; defaults to `user@host[:port]`. */
  label: string;
  host: string;
  port: number;
  username: string;
  /** Which auth method to preselect (never the secret itself). */
  auth: AuthMethod;
}

/** The identity two profiles are considered "the same server" by. */
export function profileMatchKey(p: ConnectionLike): string {
  return `${p.username}@${p.host.toLowerCase()}:${p.port}`;
}

/** Sanitize a raw localStorage string into a profile list. */
export function parseConnectionProfiles(
  raw: string | null,
): ConnectionProfile[] {
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (p) =>
          p &&
          typeof p.id === "string" &&
          typeof p.host === "string" &&
          p.host !== "" &&
          typeof p.username === "string" &&
          Number.isFinite(p.port),
      )
      .map((p) => ({
        id: p.id,
        host: p.host,
        port: p.port,
        username: p.username,
        auth: p.auth === "key" ? "key" : "password",
        label:
          typeof p.label === "string" && p.label.trim()
            ? p.label
            : connectionLabel(p),
      }));
  } catch {
    return [];
  }
}

/** Fields needed to create/update a profile (no secret). */
export interface ProfileInput {
  host: string;
  port: number;
  username: string;
  auth: AuthMethod;
  label?: string;
}

/**
 * Insert `input` as a profile, or update the existing profile for the same
 * server (matched by `profileMatchKey`) in place — keeping its id and position,
 * so re-saving a host you already have doesn't create a duplicate or reshuffle
 * the list. A new profile is appended. `makeId` supplies the id for a new entry.
 */
export function upsertProfile(
  list: ConnectionProfile[],
  input: ProfileInput,
  makeId: () => string,
): ConnectionProfile[] {
  const key = profileMatchKey(input);
  const label = input.label?.trim() || connectionLabel(input);
  const existing = list.find((p) => profileMatchKey(p) === key);
  if (existing) {
    return list.map((p) =>
      p.id === existing.id
        ? { id: p.id, host: input.host, port: input.port, username: input.username, auth: input.auth, label }
        : p,
    );
  }
  return [
    {
      id: makeId(),
      host: input.host,
      port: input.port,
      username: input.username,
      auth: input.auth,
      label,
    },
    ...list,
  ];
}

/** Remove the profile with `id`. */
export function removeConnectionProfile(
  list: ConnectionProfile[],
  id: string,
): ConnectionProfile[] {
  return list.filter((p) => p.id !== id);
}
