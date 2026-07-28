import { describe, expect, it } from "vitest";
import {
  COMMANDS,
  completeCommand,
  runCommand,
  type TerminalContext,
} from "./terminal";

const ctx: TerminalContext = {
  siteName: "Test Site",
  description: "A test description.",
  author: "Test Author",
  githubUrl: "https://github.com/test",
  email: "test@example.com",
  user: "guest",
  host: "example",
};

describe("runCommand", () => {
  it("returns no output for empty or whitespace-only input", () => {
    expect(runCommand("", ctx).lines).toEqual([]);
    expect(runCommand("   ", ctx).lines).toEqual([]);
  });

  it("echoes site identity from the context, not hardcoded values", () => {
    expect(runCommand("about", ctx).lines).toEqual([
      "Test Site",
      "A test description.",
    ]);
    expect(runCommand("whoami", ctx).lines).toEqual(["guest"]);
    expect(runCommand("links", ctx).lines).toEqual([
      "GitHub:  https://github.com/test",
      "Email:   test@example.com",
    ]);
  });

  it("is case-insensitive and ignores surrounding whitespace", () => {
    expect(runCommand("  WhoAmI  ", ctx).lines).toEqual(["guest"]);
  });

  it("passes arguments through to echo", () => {
    expect(runCommand("echo hello  world", ctx).lines).toEqual(["hello world"]);
  });

  it("signals a screen clear for `clear`", () => {
    const result = runCommand("clear", ctx);
    expect(result.clear).toBe(true);
    expect(result.lines).toEqual([]);
  });

  it("returns a shell-style not-found for unknown commands", () => {
    const result = runCommand("sudo rm -rf /", ctx);
    expect(result.lines[0]).toBe("command not found: sudo");
    expect(result.clear).toBeUndefined();
  });

  it("lists every registered command in `help`", () => {
    const help = runCommand("help", ctx).lines.join("\n");
    for (const command of COMMANDS) {
      expect(help).toContain(command.name);
    }
  });
});

describe("completeCommand", () => {
  it("returns matches for a prefix", () => {
    expect(completeCommand("wh")).toEqual(["whoami"]);
  });

  it("returns every command for an empty prefix", () => {
    expect(completeCommand("")).toEqual(COMMANDS.map((c) => c.name));
  });

  it("returns nothing when no command matches", () => {
    expect(completeCommand("xyz")).toEqual([]);
  });
});
