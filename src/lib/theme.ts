/**
 * Terminal design tokens.
 *
 * These are the single source of truth for the palette in TypeScript contexts
 * that cannot read CSS variables — chiefly the Open Graph image generator
 * (src/lib/og.tsx), which renders in a Satori runtime with no DOM.
 *
 * The SAME values are mirrored as CSS custom properties / Tailwind theme tokens
 * in src/styles/globals.css. If you retune the palette, change it in BOTH
 * places. Everything else (components, pages) should reference the CSS
 * variables or Tailwind utilities, not import from here, so the site stays
 * restyleable from one file.
 */
export const color = {
  bg: "#0a0d13", // page background
  bgPanel: "#0d1119", // sticky bars / insets
  card: "#111621", // card surface
  border: "rgba(255,255,255,0.08)", // card borders
  borderSoft: "rgba(255,255,255,0.06)",
  text: "#e6e8ee", // primary text
  textDim: "#c3c8d4", // secondary text
  muted: "#8b93a7", // labels
  faint: "#5c6478", // captions
  fainter: "#3a4152", // dividers
  accent: "#38bdf8", // cyan — links, focus, primary accent
  accentSoft: "#7cd4fb",
  green: "#34d399", // success / prompt glyph
  yellow: "#fbbf24", // warning / 500
  red: "#f87171", // error / 404 glyph
  pink: "#f472b6", // keys in detail blocks
  lime: "#a3e635", // values in detail blocks
} as const;

export type ColorToken = keyof typeof color;
