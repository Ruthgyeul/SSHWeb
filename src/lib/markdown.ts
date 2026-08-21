/**
 * A tiny, dependency-free Markdown → HTML renderer for the file preview modal.
 *
 * It is deliberately a *subset* renderer (headings, bold/italic, inline code,
 * fenced code blocks, links, images-as-text, lists, blockquotes, horizontal
 * rules, paragraphs) — enough to read a README without pulling in a parser. It
 * runs on the user's own file content in their own browser, but it still treats
 * that content as untrusted: **all text is HTML-escaped first**, only a small
 * fixed set of tags is emitted, and link targets are sanitised so a
 * `javascript:`/`data:` URL can never become a live `href`.
 *
 * Pure and DOM-free so it runs under Vitest's node environment.
 */

/** Sentinel wrapping a protected inline-code placeholder (PUA char, never in text). */
const CODE_MARK = "";

/** Escape the HTML-significant characters. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Return a safe `href` for a link target, or `null` to render it as plain text.
 * Allows http(s)/mailto and relative/anchor links; rejects any other scheme
 * (notably `javascript:` and `data:`). Input is already HTML-escaped.
 *
 * ASCII control characters (incl. NUL/TAB/newline) are stripped first: browsers
 * ignore them when parsing a URL's scheme, so `java\x00script:` would run as
 * `javascript:` — stripping them means our scheme check sees the same string the
 * browser will, closing that bypass.
 */
function safeUrl(url: string): string | null {
  const u = url.replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (/^(https?:|mailto:)/i.test(u)) return u;
  if (/^(#|\/|\.\/|\.\.\/)/.test(u)) return u; // anchor / relative
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return null; // some other scheme → drop
  return u; // bare relative path (e.g. "docs/other.md")
}

/** Render inline markdown within an already block-split line of text. */
function inline(text: string): string {
  let s = esc(text);

  // Protect inline code spans from the other inline rules, restoring them last.
  const codes: string[] = [];
  s = s.replace(/`([^`]+)`/g, (_m, c) => {
    codes.push(`<code>${c}</code>`);
    return `${CODE_MARK}${codes.length - 1}${CODE_MARK}`;
  });

  // Images: we can't load the remote bytes, so show the alt text only.
  s = s.replace(/!\[([^\]]*)\]\(([^)]*)\)/g, (_m, alt) => alt);

  // Links: [text](url) with an optional "title".
  s = s.replace(
    /\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g,
    (_m, txt, url) => {
      const href = safeUrl(url);
      return href
        ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${txt}</a>`
        : txt;
    },
  );

  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  s = s.replace(
    /(^|[^A-Za-z0-9])_([^_]+)_(?=$|[^A-Za-z0-9])/g,
    "$1<em>$2</em>",
  );

  s = s.replace(
    new RegExp(`${CODE_MARK}(\\d+)${CODE_MARK}`, "g"),
    (_m, i) => codes[Number(i)],
  );
  return s;
}

/**
 * Render Markdown source to a sanitized HTML string suitable for injection into
 * a preview pane. See the module docstring for the supported subset and the
 * escaping/sanitising guarantees.
 */
export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];

  let inCode = false;
  let codeBuf: string[] = [];
  let para: string[] = [];
  let listType: "ul" | "ol" | null = null;
  let listItems: string[] = [];

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inline(para.join(" "))}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (listType) {
      out.push(`<${listType}>${listItems.join("")}</${listType}>`);
      listItems = [];
      listType = null;
    }
  };
  const flushBlocks = () => {
    flushPara();
    flushList();
  };

  for (const line of lines) {
    const fence = /^\s*```/.test(line);
    if (inCode) {
      if (fence) {
        out.push(`<pre><code>${esc(codeBuf.join("\n"))}</code></pre>`);
        codeBuf = [];
        inCode = false;
      } else {
        codeBuf.push(line);
      }
      continue;
    }
    if (fence) {
      flushBlocks();
      inCode = true;
      codeBuf = [];
      continue;
    }
    if (line.trim() === "") {
      flushBlocks();
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushBlocks();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2].trim())}</h${level}>`);
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushBlocks();
      out.push("<hr/>");
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      flushPara();
      flushList();
      out.push(`<blockquote>${inline(quote[1])}</blockquote>`);
      continue;
    }

    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const t: "ul" | "ol" = ul ? "ul" : "ol";
      if (listType && listType !== t) flushList();
      listType = t;
      listItems.push(`<li>${inline((ul ? ul[1] : ol![1]).trim())}</li>`);
      continue;
    }

    flushList();
    para.push(line.trim());
  }

  if (inCode) out.push(`<pre><code>${esc(codeBuf.join("\n"))}</code></pre>`);
  flushBlocks();
  return out.join("\n");
}
