/**
 * Heuristic detection of high-risk shell commands, used to add an extra warning
 * to the multi-line paste confirmation (#64). This is a best-effort safety net
 * against paste-jacking and fat-finger disasters — NOT a security boundary (the
 * remote host's own permissions are). It deliberately targets a small set of
 * unambiguously destructive patterns to keep false positives low.
 *
 * Pure and DOM-free so it unit-tests under Vitest's node environment.
 */

interface DangerPattern {
  re: RegExp;
  label: string;
}

const PATTERNS: DangerPattern[] = [
  // rm with a recursive + force combination (any flag order: -rf, -fr, -r -f…).
  {
    re: /\brm\b(?=[^\n]*\s-\S*r)(?=[^\n]*\s-\S*f)/i,
    label: "recursive force delete (rm -rf)",
  },
  // Piping a downloaded script straight into a shell (curl … | sh).
  {
    re: /\b(?:curl|wget|fetch)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|d)?sh\b/i,
    label: "pipe a download into a shell",
  },
  // Formatting a filesystem.
  { re: /\bmkfs(?:\.\w+)?\b/i, label: "format a filesystem (mkfs)" },
  // Raw write to a block device.
  { re: /\bdd\b[^\n]*\bof=\/dev\/\w+/i, label: "raw write to a device (dd)" },
  // Classic bash fork bomb.
  {
    re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:?\s*&\s*\}\s*;\s*:/,
    label: "fork bomb",
  },
  // World-writable recursive chmod at the filesystem root.
  {
    re: /\bchmod\s+-R\s+0*777\s+\/(?:\s|$)/,
    label: "recursive chmod 777 on /",
  },
  // Overwriting a disk device via redirection.
  {
    re: /(?:>|>>)\s*\/dev\/(?:sd|nvme|hd|vd)\w+/i,
    label: "overwrite a disk device",
  },
];

/**
 * Return the distinct human-readable labels of dangerous patterns found in
 * `text` (empty when none). Order follows {@link PATTERNS}.
 */
export function dangerousCommandMatches(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const { re, label } of PATTERNS) {
    if (re.test(text) && !out.includes(label)) out.push(label);
  }
  return out;
}

/** Convenience boolean: whether `text` contains any flagged pattern. */
export function isDangerousCommand(text: string): boolean {
  return dangerousCommandMatches(text).length > 0;
}
