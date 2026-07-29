import { describe, expect, it } from "vitest";
import { escapeHtml, highlightToHtml, tokenizeLine } from "./syntaxHighlight";

describe("tokenizeLine", () => {
  it("tags a trailing comment", () => {
    const toks = tokenizeLine("x = 1 # note");
    expect(toks.at(-1)).toEqual({ type: "comment", value: "# note" });
  });

  it("recognizes // comments too", () => {
    expect(tokenizeLine("a // b").at(-1)).toEqual({
      type: "comment",
      value: "// b",
    });
  });

  it("captures a whole string literal including quotes", () => {
    const toks = tokenizeLine('say("hi there")');
    expect(toks.some((t) => t.type === "string" && t.value === '"hi there"')).toBe(
      true,
    );
  });

  it("does not end a string on an escaped quote", () => {
    const toks = tokenizeLine('"a\\"b"');
    expect(toks[0]).toEqual({ type: "string", value: '"a\\"b"' });
  });

  it("marks keywords and numbers", () => {
    const toks = tokenizeLine("const n = 42");
    expect(toks.find((t) => t.value === "const")?.type).toBe("keyword");
    expect(toks.find((t) => t.value === "42")?.type).toBe("number");
  });

  it("leaves ordinary identifiers plain", () => {
    expect(tokenizeLine("foo")).toEqual([{ type: "plain", value: "foo" }]);
  });
});

describe("escapeHtml", () => {
  it("escapes the HTML-significant characters", () => {
    expect(escapeHtml('<a href="x">&\'</a>')).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;",
    );
  });
});

describe("highlightToHtml", () => {
  it("wraps tokens in class-tagged spans and escapes content", () => {
    const html = highlightToHtml('const s = "<b>"');
    expect(html).toContain('<span class="sx-kw">const</span>');
    expect(html).toContain('<span class="sx-str">&quot;&lt;b&gt;&quot;</span>');
  });

  it("preserves newlines line-for-line", () => {
    expect(highlightToHtml("a\nb").split("\n")).toHaveLength(2);
  });
});
