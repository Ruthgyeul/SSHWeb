/**
 * A tiny, dependency-free, language-neutral syntax highlighter for the inline
 * file editor. It is intentionally *approximate* — it colors strings, comments,
 * numbers and a broad set of common keywords with a single-pass per-line scanner
 * rather than a real grammar. The goal is a pleasant editing surface, not a
 * correct parser, so it stays cheap and never throws on odd input.
 *
 * Pure and DOM-free (returns HTML strings), so it runs under Vitest's node env.
 * The emitted class names (`sx-str`/`sx-com`/`sx-num`/`sx-kw`) are styled in
 * `styles/globals.css` with the terminal palette.
 */

export type TokenType = "plain" | "comment" | "string" | "number" | "keyword";

export interface Token {
  type: TokenType;
  value: string;
}

/** Keywords shared across the languages a server admin is likely to edit. */
const KEYWORDS = new Set([
  // JS/TS
  "const", "let", "var", "function", "return", "if", "else", "for", "while",
  "do", "switch", "case", "break", "continue", "class", "extends", "new",
  "import", "export", "from", "default", "async", "await", "try", "catch",
  "finally", "throw", "typeof", "instanceof", "yield", "static", "this",
  "super", "delete", "in", "of", "void",
  // Python
  "def", "elif", "except", "with", "as", "lambda", "pass", "global",
  "nonlocal", "raise", "assert", "and", "or", "not", "is", "None", "True",
  "False", "self",
  // Rust / Go / C-ish
  "fn", "mut", "struct", "impl", "enum", "match", "use", "pub", "trait",
  "package", "func", "type", "interface", "map", "range", "defer", "go",
  "int", "float", "double", "char", "bool", "string", "public", "private",
  "protected", "final", "abstract", "null", "true", "false",
  // shell
  "echo", "then", "fi", "done", "esac", "elif", "local", "export",
]);

const isDigit = (c: string) => c >= "0" && c <= "9";
const isWordStart = (c: string) =>
  (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || c === "$";
const isWord = (c: string) => isWordStart(c) || isDigit(c);

/** Tokenize a single line (no newlines) into typed spans, left to right. */
export function tokenizeLine(line: string): Token[] {
  const tokens: Token[] = [];
  let plain = "";
  const flush = () => {
    if (plain) {
      tokens.push({ type: "plain", value: plain });
      plain = "";
    }
  };

  let i = 0;
  while (i < line.length) {
    const c = line[i];

    // Line comment: `#…` or `//…` to end of line.
    if (c === "#" || (c === "/" && line[i + 1] === "/")) {
      flush();
      tokens.push({ type: "comment", value: line.slice(i) });
      return tokens;
    }

    // String literal: '…' "…" `…`, honoring backslash escapes.
    if (c === '"' || c === "'" || c === "`") {
      flush();
      let j = i + 1;
      while (j < line.length && line[j] !== c) {
        if (line[j] === "\\") j++;
        j++;
      }
      const end = j < line.length ? j + 1 : line.length;
      tokens.push({ type: "string", value: line.slice(i, end) });
      i = end;
      continue;
    }

    // Number (integers, decimals, and hex-ish runs).
    if (isDigit(c)) {
      let j = i;
      while (j < line.length && /[0-9._a-fA-FxX]/.test(line[j])) j++;
      flush();
      tokens.push({ type: "number", value: line.slice(i, j) });
      i = j;
      continue;
    }

    // Identifier / keyword.
    if (isWordStart(c)) {
      let j = i;
      while (j < line.length && isWord(line[j])) j++;
      const word = line.slice(i, j);
      flush();
      tokens.push({ type: KEYWORDS.has(word) ? "keyword" : "plain", value: word });
      i = j;
      continue;
    }

    plain += c;
    i++;
  }
  flush();
  return tokens;
}

/** Escape the five HTML-significant characters so text renders verbatim. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const CLASS: Record<TokenType, string | null> = {
  plain: null,
  comment: "sx-com",
  string: "sx-str",
  number: "sx-num",
  keyword: "sx-kw",
};

/**
 * Render text to highlighted HTML: each line tokenized, escaped, and wrapped in
 * class-tagged `<span>`s. Newlines are preserved so the output lines up 1:1 with
 * a `<textarea>` overlay of the same text.
 */
export function highlightToHtml(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      tokenizeLine(line)
        .map((tok) => {
          const escaped = escapeHtml(tok.value);
          const cls = CLASS[tok.type];
          return cls ? `<span class="${cls}">${escaped}</span>` : escaped;
        })
        .join(""),
    )
    .join("\n");
}
