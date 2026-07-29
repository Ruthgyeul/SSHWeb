/**
 * Terminal appearance presets and font-size helpers for the xterm view.
 *
 * These are plain, DOM-free values (colors as hex strings, sizes as numbers) so
 * the pure parts can be unit-tested under Vitest's node environment. The React
 * side (`XtermView`) feeds a {@link TerminalTheme} straight into xterm's
 * `ITheme` option, and the settings popover persists the chosen name + font size
 * to `localStorage` so a preference survives reloads and new tabs.
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

/** A named preset shown in the settings popover. */
export interface TerminalThemePreset {
  id: string;
  label: string;
  theme: TerminalTheme;
}

/**
 * Built-in color schemes. The first entry ("SSHWeb") matches the site palette
 * defined in `styles/globals.css` and is the default. The rest are well-known
 * community schemes, kept here as literal hex so this module stays DOM-free.
 */
export const TERMINAL_THEMES: TerminalThemePreset[] = [
  {
    id: "sshweb",
    label: "SSHWeb",
    theme: {
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
    },
  },
  {
    id: "dracula",
    label: "Dracula",
    theme: {
      background: "#282a36",
      foreground: "#f8f8f2",
      cursor: "#f8f8f2",
      cursorAccent: "#282a36",
      selectionBackground: "rgba(189, 147, 249, 0.35)",
      black: "#21222c",
      red: "#ff5555",
      green: "#50fa7b",
      yellow: "#f1fa8c",
      blue: "#bd93f9",
      magenta: "#ff79c6",
      cyan: "#8be9fd",
      white: "#f8f8f2",
      brightBlack: "#6272a4",
      brightRed: "#ff6e6e",
      brightGreen: "#69ff94",
      brightYellow: "#ffffa5",
      brightBlue: "#d6acff",
      brightMagenta: "#ff92df",
      brightCyan: "#a4ffff",
      brightWhite: "#ffffff",
    },
  },
  {
    id: "solarized-dark",
    label: "Solarized Dark",
    theme: {
      background: "#002b36",
      foreground: "#93a1a1",
      cursor: "#93a1a1",
      cursorAccent: "#002b36",
      selectionBackground: "rgba(131, 148, 150, 0.35)",
      black: "#073642",
      red: "#dc322f",
      green: "#859900",
      yellow: "#b58900",
      blue: "#268bd2",
      magenta: "#d33682",
      cyan: "#2aa198",
      white: "#eee8d5",
      brightBlack: "#586e75",
      brightRed: "#cb4b16",
      brightGreen: "#586e75",
      brightYellow: "#657b83",
      brightBlue: "#839496",
      brightMagenta: "#6c71c4",
      brightCyan: "#93a1a1",
      brightWhite: "#fdf6e3",
    },
  },
  {
    id: "gruvbox-dark",
    label: "Gruvbox Dark",
    theme: {
      background: "#282828",
      foreground: "#ebdbb2",
      cursor: "#ebdbb2",
      cursorAccent: "#282828",
      selectionBackground: "rgba(235, 219, 178, 0.3)",
      black: "#282828",
      red: "#cc241d",
      green: "#98971a",
      yellow: "#d79921",
      blue: "#458588",
      magenta: "#b16286",
      cyan: "#689d6a",
      white: "#a89984",
      brightBlack: "#928374",
      brightRed: "#fb4934",
      brightGreen: "#b8bb26",
      brightYellow: "#fabd2f",
      brightBlue: "#83a598",
      brightMagenta: "#d3869b",
      brightCyan: "#8ec07c",
      brightWhite: "#ebdbb2",
    },
  },
  {
    id: "solarized-light",
    label: "Solarized Light",
    theme: {
      background: "#fdf6e3",
      foreground: "#586e75",
      cursor: "#586e75",
      cursorAccent: "#fdf6e3",
      selectionBackground: "rgba(88, 110, 117, 0.2)",
      black: "#073642",
      red: "#dc322f",
      green: "#859900",
      yellow: "#b58900",
      blue: "#268bd2",
      magenta: "#d33682",
      cyan: "#2aa198",
      white: "#eee8d5",
      brightBlack: "#002b36",
      brightRed: "#cb4b16",
      brightGreen: "#586e75",
      brightYellow: "#657b83",
      brightBlue: "#839496",
      brightMagenta: "#6c71c4",
      brightCyan: "#93a1a1",
      brightWhite: "#fdf6e3",
    },
  },
];

/** The default preset id (first entry — the site palette). */
export const DEFAULT_THEME_ID = TERMINAL_THEMES[0].id;

/** Look up a preset by id, falling back to the default when unknown/absent. */
export function getThemePreset(id: string | null | undefined): TerminalThemePreset {
  return TERMINAL_THEMES.find((t) => t.id === id) ?? TERMINAL_THEMES[0];
}

export const MIN_FONT_SIZE = 9;
export const MAX_FONT_SIZE = 24;
export const DEFAULT_FONT_SIZE = 13;

/** Clamp a font size to the supported range, snapping NaN back to the default. */
export function clampFontSize(size: number): number {
  if (!Number.isFinite(size)) return DEFAULT_FONT_SIZE;
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(size)));
}
