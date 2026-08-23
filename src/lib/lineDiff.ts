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

/** Max lines per side the diff will process before truncating. */
export const MAX_DIFF_LINES = 5000;

function splitLines(s: string): string[] {
  // Normalize CRLF so line matching isn't defeated by line-ending differences.
  return s.replace(/\r\n/g, "\n").split("\n");
}

/** Compute a line diff of `a` → `b`. */
export function lineDiff(a: string, b: string): DiffResult {
  let aLines = splitLines(a);
  let bLines = splitLines(b);
  const truncated =
    aLines.length > MAX_DIFF_LINES || bLines.length > MAX_DIFF_LINES;
  if (truncated) {
    aLines = aLines.slice(0, MAX_DIFF_LINES);
    bLines = bLines.slice(0, MAX_DIFF_LINES);
  }

  const n = aLines.length;
  const m = bLines.length;
  // LCS length table (rows 0..n, cols 0..m).
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
      ops.push({ type: "same", text: aLines[i], aLine: i + 1, bLine: j + 1 });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ type: "del", text: aLines[i], aLine: i + 1 });
      i++;
    } else {
      ops.push({ type: "add", text: bLines[j], bLine: j + 1 });
      j++;
    }
  }
  while (i < n) ops.push({ type: "del", text: aLines[i], aLine: ++i });
  while (j < m) ops.push({ type: "add", text: bLines[j], bLine: ++j });

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
