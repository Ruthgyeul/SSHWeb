/**
 * Pure line-level diff for the two-file diff preview (#76). A classic LCS
 * (longest-common-subsequence) walk yields a list of operations — unchanged,
 * added, or removed lines — which the diff view renders as a side-by-side /
 * unified list. DOM-free and unit-tested.
 *
 * Bounded by MAX_DIFF_LINES on each side so a pair of huge files can't build an
 * O(n·m) table that blocks the UI; past the cap the inputs are truncated and the
 * result is flagged `truncated`.
 */
export type DiffOpType = "same" | "add" | "del";

export interface DiffOp {
  type: DiffOpType;
  text: string;
  /** 1-based line number in the left (a) file, when present. */
  aLine?: number;
  /** 1-based line number in the right (b) file, when present. */
  bLine?: number;
}

export interface DiffResult {
  ops: DiffOp[];
  /** True when either side was truncated at MAX_DIFF_LINES. */
  truncated: boolean;
}

/** Max lines per side the diff will process before truncating. Kept modest so
 * the LCS of two entirely-different files stays bounded: the table is only ever
 * built for the *differing middle* (common prefix/suffix are stripped first), so
 * the worst case is MAX_DIFF_LINES² only for two files that share no prefix or
 * suffix — at 1500 that's ~2.25M cells, safe even on mobile. */
export const MAX_DIFF_LINES = 1500;

function splitLines(s: string): string[] {
  // Normalize CRLF so line matching isn't defeated by line-ending differences.
  return s.replace(/\r\n/g, "\n").split("\n");
}

/** LCS-diff two line arrays that share no common prefix/suffix, offsetting the
 * emitted 1-based line numbers by the stripped prefix length on each side. */
function diffMiddle(
  aLines: string[],
  bLines: string[],
  aOffset: number,
  bOffset: number,
): DiffOp[] {
  const n = aLines.length;
  const m = bLines.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] =
        aLines[i] === bLines[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (aLines[i] === bLines[j]) {
      ops.push({
        type: "same",
        text: aLines[i],
        aLine: aOffset + i + 1,
        bLine: bOffset + j + 1,
      });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ type: "del", text: aLines[i], aLine: aOffset + i + 1 });
      i++;
    } else {
      ops.push({ type: "add", text: bLines[j], bLine: bOffset + j + 1 });
      j++;
    }
  }
  while (i < n) {
    ops.push({ type: "del", text: aLines[i], aLine: aOffset + i + 1 });
    i++;
  }
  while (j < m) {
    ops.push({ type: "add", text: bLines[j], bLine: bOffset + j + 1 });
    j++;
  }
  return ops;
}

/** Compute a line diff of `a` → `b`. Common leading/trailing lines are stripped
 * before the (quadratic) LCS so the table only covers the differing region. */
export function lineDiff(a: string, b: string): DiffResult {
  let aLines = splitLines(a);
  let bLines = splitLines(b);
  const truncated =
    aLines.length > MAX_DIFF_LINES || bLines.length > MAX_DIFF_LINES;
  if (truncated) {
    aLines = aLines.slice(0, MAX_DIFF_LINES);
    bLines = bLines.slice(0, MAX_DIFF_LINES);
  }

  // Strip the common prefix and suffix — these are emitted as "same" ops
  // directly, and keep the O(n·m) LCS confined to what actually differs.
  let pre = 0;
  const maxPre = Math.min(aLines.length, bLines.length);
  while (pre < maxPre && aLines[pre] === bLines[pre]) pre++;
  let suf = 0;
  while (
    suf < maxPre - pre &&
    aLines[aLines.length - 1 - suf] === bLines[bLines.length - 1 - suf]
  )
    suf++;

  const ops: DiffOp[] = [];
  for (let k = 0; k < pre; k++) {
    ops.push({ type: "same", text: aLines[k], aLine: k + 1, bLine: k + 1 });
  }
  ops.push(
    ...diffMiddle(
      aLines.slice(pre, aLines.length - suf),
      bLines.slice(pre, bLines.length - suf),
      pre,
      pre,
    ),
  );
  for (let k = 0; k < suf; k++) {
    const ai = aLines.length - suf + k;
    const bi = bLines.length - suf + k;
    ops.push({
      type: "same",
      text: aLines[ai],
      aLine: ai + 1,
      bLine: bi + 1,
    });
  }

  return { ops, truncated };
}

/** Count added/removed lines in a diff, for a summary header. */
export function diffStats(ops: DiffOp[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.type === "add") added++;
    else if (op.type === "del") removed++;
  }
  return { added, removed };
}
