import { describe, expect, it } from "vitest";
import {
  lineDiff,
  diffStats,
  MAX_DIFF_LINES,
  type DiffOp,
} from "@/lib/lineDiff";

const types = (ops: DiffOp[]) => ops.map((o) => `${o.type}:${o.text}`);

describe("lineDiff", () => {
  it("marks every line 'same' for identical inputs", () => {
    const { ops, truncated } = lineDiff("a\nb\nc", "a\nb\nc");
    expect(truncated).toBe(false);
    expect(ops.every((o) => o.type === "same")).toBe(true);
    expect(ops).toHaveLength(3);
    expect(ops[1]).toMatchObject({ type: "same", aLine: 2, bLine: 2 });
  });

  it("detects an inserted line", () => {
    const { ops } = lineDiff("a\nc", "a\nb\nc");
    expect(types(ops)).toEqual(["same:a", "add:b", "same:c"]);
    expect(diffStats(ops)).toEqual({ added: 1, removed: 0 });
  });

  it("detects a removed line", () => {
    const { ops } = lineDiff("a\nb\nc", "a\nc");
    expect(types(ops)).toEqual(["same:a", "del:b", "same:c"]);
    expect(diffStats(ops)).toEqual({ added: 0, removed: 1 });
  });

  it("represents a changed line as a delete + add", () => {
    const { ops } = lineDiff("a\nOLD\nc", "a\nNEW\nc");
    expect(types(ops)).toEqual(["same:a", "del:OLD", "add:NEW", "same:c"]);
    expect(diffStats(ops)).toEqual({ added: 1, removed: 1 });
  });

  it("normalizes CRLF so line endings don't create spurious diffs", () => {
    const { ops } = lineDiff("a\r\nb", "a\nb");
    expect(ops.every((o) => o.type === "same")).toBe(true);
  });

  it("carries correct 1-based line numbers", () => {
    const { ops } = lineDiff("a\nb", "a\nX\nb");
    const add = ops.find((o) => o.type === "add");
    expect(add).toMatchObject({ bLine: 2 });
    const lastSame = ops[ops.length - 1];
    expect(lastSame).toMatchObject({ type: "same", aLine: 2, bLine: 3 });
  });

  it("truncates and flags a pair of over-long inputs", () => {
    const big = Array.from(
      { length: MAX_DIFF_LINES + 50 },
      (_, i) => `L${i}`,
    ).join("\n");
    const { ops, truncated } = lineDiff(big, big);
    expect(truncated).toBe(true);
    expect(ops.length).toBeLessThanOrEqual(MAX_DIFF_LINES);
  });
});
