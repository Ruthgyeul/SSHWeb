import { describe, it, expect } from "vitest";
import { renderMarkdown } from "@/lib/markdown";

describe("renderMarkdown", () => {
  it("renders headings, paragraphs and inline emphasis", () => {
    expect(renderMarkdown("# Title")).toBe("<h1>Title</h1>");
    expect(renderMarkdown("## Sub")).toBe("<h2>Sub</h2>");
    expect(renderMarkdown("a **bold** and *italic* and `code` word")).toBe(
      "<p>a <strong>bold</strong> and <em>italic</em> and <code>code</code> word</p>",
    );
  });

  it("renders unordered and ordered lists", () => {
    expect(renderMarkdown("- one\n- two")).toBe(
      "<ul><li>one</li><li>two</li></ul>",
    );
    expect(renderMarkdown("1. a\n2. b")).toBe("<ol><li>a</li><li>b</li></ol>");
  });

  it("renders fenced code blocks with escaped contents", () => {
    expect(renderMarkdown("```\n<x> & y\n```")).toBe(
      "<pre><code>&lt;x&gt; &amp; y</code></pre>",
    );
  });

  it("renders blockquotes and horizontal rules", () => {
    expect(renderMarkdown("> quote")).toBe("<blockquote>quote</blockquote>");
    expect(renderMarkdown("---")).toBe("<hr/>");
  });

  it("escapes raw HTML so it can't inject markup", () => {
    expect(renderMarkdown("<script>alert(1)</script>")).toBe(
      "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>",
    );
  });

  it("renders safe links but strips dangerous URL schemes", () => {
    expect(renderMarkdown("[docs](https://example.com)")).toBe(
      '<p><a href="https://example.com" target="_blank" rel="noopener noreferrer">docs</a></p>',
    );
    // javascript: is dropped — the text remains, but no href is emitted.
    expect(renderMarkdown("[x](javascript:alert)")).toBe("<p>x</p>");
    // data: URLs are likewise refused.
    expect(renderMarkdown("[y](data:text/html,hi)")).toBe("<p>y</p>");
  });

  it("shows image alt text (remote bytes can't be loaded)", () => {
    expect(renderMarkdown("![a photo](photo.png)")).toBe("<p>a photo</p>");
  });
});
