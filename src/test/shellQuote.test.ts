import { describe, expect, it } from "vitest";
import { shellQuoteSingle, cdCommand } from "@/lib/shellQuote";

describe("shellQuoteSingle", () => {
  it("wraps a plain path in single quotes", () => {
    expect(shellQuoteSingle("/home/user/docs")).toBe("'/home/user/docs'");
  });

  it("neutralizes shell metacharacters", () => {
    expect(shellQuoteSingle("/tmp/a b;rm -rf ~")).toBe("'/tmp/a b;rm -rf ~'");
    expect(shellQuoteSingle("$(whoami)")).toBe("'$(whoami)'");
  });

  it("escapes embedded single quotes with the '\\'' idiom", () => {
    expect(shellQuoteSingle("it's here")).toBe("'it'\\''s here'");
  });
});

describe("cdCommand", () => {
  it("builds a quoted cd with a trailing newline", () => {
    expect(cdCommand("/var/log")).toBe("cd '/var/log'\n");
  });

  it("uses a bare cd for home ('~' or empty)", () => {
    expect(cdCommand("~")).toBe("cd\n");
    expect(cdCommand("")).toBe("cd\n");
    expect(cdCommand("   ")).toBe("cd\n");
  });

  it("quotes a path with a space or quote safely", () => {
    expect(cdCommand("/tmp/my dir")).toBe("cd '/tmp/my dir'\n");
    expect(cdCommand("/tmp/o'brien")).toBe("cd '/tmp/o'\\''brien'\n");
  });
});
