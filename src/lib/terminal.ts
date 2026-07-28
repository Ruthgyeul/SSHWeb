/**
 * Command engine for the interactive <Terminal> component.
 *
 * This is deliberately UI-free and pure: `runCommand` takes an input string and
 * a context object (site identity, resolved from siteConfig by the caller) and
 * returns the lines to print. Keeping the logic here — rather than inside the
 * client component — means it runs in Vitest's node environment with no DOM and
 * no env setup (see terminal.test.ts).
 *
 * Add a command by extending COMMANDS; `help` and tab-completion are generated
 * from that list, so there's a single source of truth.
 */

/** Site identity the commands can echo back. Supplied by the caller so this
 *  module stays pure and testable without importing env-driven config. */
export interface TerminalContext {
  siteName: string;
  description: string;
  author: string;
  githubUrl: string;
  email: string;
  user: string;
  host: string;
}

export interface CommandResult {
  /** Lines to append to the output (may be empty). */
  lines: string[];
  /** When true, the caller should wipe the screen instead of appending. */
  clear?: boolean;
}

interface CommandSpec {
  name: string;
  summary: string;
  run: (args: string[], ctx: TerminalContext) => CommandResult;
}

const lines = (...ls: string[]): CommandResult => ({ lines: ls });

/**
 * The command registry. Order here is the order shown by `help`.
 * Keep each command's output placeholder-friendly — it reads from `ctx`, never
 * from a hardcoded identity.
 */
export const COMMANDS: CommandSpec[] = [
  {
    name: "help",
    summary: "List available commands",
    run: () =>
      lines(
        "Available commands:",
        ...COMMANDS.map((c) => `  ${c.name.padEnd(10)} ${c.summary}`),
        "",
        "Tip: press Tab to autocomplete, ↑/↓ to browse history.",
      ),
  },
  {
    name: "about",
    summary: "What is this site?",
    run: (_args, ctx) => lines(ctx.siteName, ctx.description),
  },
  {
    name: "whoami",
    summary: "Print the current shell user",
    run: (_args, ctx) => lines(ctx.user),
  },
  {
    name: "ls",
    summary: "List sections",
    run: () => lines("about.txt   projects/   contact.txt   README.md"),
  },
  {
    name: "links",
    summary: "Show contact + social links",
    run: (_args, ctx) =>
      lines(`GitHub:  ${ctx.githubUrl}`, `Email:   ${ctx.email}`),
  },
  {
    name: "echo",
    summary: "Print the given text",
    run: (args) => lines(args.join(" ")),
  },
  {
    name: "clear",
    summary: "Clear the screen",
    run: () => ({ lines: [], clear: true }),
  },
];

const COMMAND_MAP = new Map(COMMANDS.map((c) => [c.name, c]));

/**
 * Parse and execute a single line of input.
 *
 * Empty input is a no-op (returns no lines). Unknown commands return a
 * shell-style "command not found" with a hint, never throwing.
 */
export function runCommand(input: string, ctx: TerminalContext): CommandResult {
  const trimmed = input.trim();
  if (trimmed === "") return { lines: [] };

  const [name, ...args] = trimmed.split(/\s+/);
  const command = COMMAND_MAP.get(name.toLowerCase());
  if (!command) {
    return lines(
      `command not found: ${name}`,
      "Type 'help' to see available commands.",
    );
  }
  return command.run(args, ctx);
}

/**
 * Return the command names that start with `prefix`, for Tab completion.
 * An empty prefix returns every command.
 */
export function completeCommand(prefix: string): string[] {
  const p = prefix.trim().toLowerCase();
  return COMMANDS.map((c) => c.name).filter((n) => n.startsWith(p));
}
