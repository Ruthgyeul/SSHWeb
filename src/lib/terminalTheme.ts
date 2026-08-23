/**
 * The single terminal color theme for the xterm view.
 *
 * SSHWeb ships one fixed dark theme (matching the site palette in
 * `styles/globals.css`) — there is no theme picker. `XtermView` feeds
 * {@link TERMINAL_THEME} straight into xterm's `ITheme` option. Kept as plain,
 * DOM-free hex values so it can be unit-tested under Vitest's node environment.
 */

/** The subset of xterm's `ITheme` we set — a full 16-color ANSI palette. */
export interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/**
 * The one and only terminal color theme — the SSHWeb site palette (matches
 * `styles/globals.css`). There is no theme picker; the terminal always uses this.
 */
export const TERMINAL_THEME: TerminalTheme = {
  background: "#0a0d13",
  foreground: "#e6e8ee",
  cursor: "#34d399",
  cursorAccent: "#0a0d13",
  selectionBackground: "rgba(52, 211, 153, 0.3)",
  black: "#1e2430",
  red: "#f87171",
  green: "#34d399",
  yellow: "#fbbf24",
  blue: "#38bdf8",
  magenta: "#f472b6",
  cyan: "#22d3ee",
  white: "#c3c8d4",
  brightBlack: "#5c6478",
  brightRed: "#fca5a5",
  brightGreen: "#6ee7b7",
  brightYellow: "#fcd34d",
  brightBlue: "#7cd4fb",
  brightMagenta: "#f9a8d4",
  brightCyan: "#67e8f9",
  brightWhite: "#f8fafc",
};
