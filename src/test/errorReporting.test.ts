import { describe, expect, it } from "vitest";

import { buildErrorReport } from "@/lib/errorReporting";

describe("buildErrorReport", () => {
  it("captures name, message, digest and context from an Error", () => {
    const err = Object.assign(new TypeError("boom"), { digest: "abc123" });
    const report = buildErrorReport(err, "route");
    expect(report.name).toBe("TypeError");
    expect(report.message).toBe("boom");
    expect(report.digest).toBe("abc123");
    expect(report.context).toBe("route");
    expect(report.stack).toContain("boom");
  });

  it("caps the stack to a bounded number of lines", () => {
    const err = new Error("x");
    err.stack = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const report = buildErrorReport(err);
    expect((report.stack ?? "").split("\n").length).toBeLessThanOrEqual(20);
  });

  it("normalizes a non-Error thrown value", () => {
    const report = buildErrorReport("just a string");
    expect(report.name).toBe("string");
    expect(report.message).toBe("just a string");
    expect(report.stack).toBeUndefined();
  });

  it("bounds an oversized non-Error message", () => {
    const report = buildErrorReport("z".repeat(5000));
    expect(report.message.length).toBeLessThanOrEqual(1000);
  });

  it("bounds an oversized Error message and stack", () => {
    const err = new Error("m".repeat(5000));
    err.stack = "s".repeat(20000);
    const report = buildErrorReport(err);
    expect(report.message.length).toBeLessThanOrEqual(1000);
    expect((report.stack ?? "").length).toBeLessThanOrEqual(4000);
  });
});
