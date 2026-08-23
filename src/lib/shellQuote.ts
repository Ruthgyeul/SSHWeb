/**
 * Minimal POSIX single-quote shell quoting for injecting a path into the remote
 * shell (e.g. the "open terminal here" `cd` — #50). Single quotes disable every
 * shell metacharacter; an embedded single quote is emitted as the standard
 * `'\''` escape. Pure and unit-tested.
 */

/** Wrap `s` in single quotes so the shell treats it as one literal argument. */
export function shellQuoteSingle(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build a `cd` command (with trailing newline) that changes the remote shell to
 * `path`. An empty path or "~" becomes a bare `cd` (→ home), since a quoted "~"
 * would be taken literally as a directory named "~".
 */
export function cdCommand(path: string): string {
  const p = path.trim();
  if (p === "" || p === "~") return "cd\n";
  return `cd ${shellQuoteSingle(p)}\n`;
}
