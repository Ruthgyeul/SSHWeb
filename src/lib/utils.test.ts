import { describe, expect, it } from "vitest";
import { cn, toJsonLd } from "./utils";

describe("cn", () => {
  it("joins truthy class names with spaces", () => {
    expect(cn("a", "b", "c")).toBe("a b c");
  });

  it("skips falsy values so conditionals don't leak into the DOM", () => {
    const active = false;
    const disabled = true;
    expect(cn("base", active && "is-active", disabled && "is-disabled")).toBe(
      "base is-disabled",
    );
    expect(cn("x", null, undefined, "")).toBe("x");
  });
});

describe("toJsonLd", () => {
  it("produces JSON that still parses back to the original value", () => {
    const data = { name: "Example", url: "https://example.com" };
    expect(JSON.parse(toJsonLd(data))).toEqual(data);
  });

  it("escapes '<' so a value cannot break out of a </script> tag", () => {
    const out = toJsonLd({ name: "</script><script>alert(1)</script>" });
    expect(out).not.toContain("</script>");
    expect(out).toContain("\\u003c");
    // Still valid JSON that round-trips to the original string.
    expect(JSON.parse(out).name).toBe("</script><script>alert(1)</script>");
  });

  it("escapes '>' and '&' as well", () => {
    const out = toJsonLd({ v: "a > b && c" });
    expect(out).toContain("\\u003e");
    expect(out).toContain("\\u0026");
    expect(out).not.toContain(">");
    expect(out).not.toContain("&");
  });

  it("escapes U+2028 / U+2029 line separators", () => {
    const ls = String.fromCharCode(0x2028);
    const ps = String.fromCharCode(0x2029);
    const raw = `a${ls}b${ps}c`;
    const out = toJsonLd({ v: raw });
    expect(out).toContain("\\u2028");
    expect(out).toContain("\\u2029");
    expect(out).not.toContain(ls);
    expect(out).not.toContain(ps);
    expect(JSON.parse(out).v).toBe(raw);
  });
});
