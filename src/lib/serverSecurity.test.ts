import { describe, expect, it } from "vitest";
import {
  accessTokenMatches,
  accessTokenRequired,
  clientIpFromHeaders,
  isForwardBindAllowed,
  isIdleExpired,
  isWebSocketOriginAllowed,
  normalizeOrigin,
  parseCookieHeader,
  SlidingWindowRateLimiter,
  uploadChunkInOrder,
  uploadExceedsCap,
} from "./serverSecurity";

describe("normalizeOrigin", () => {
  it("reduces an origin to scheme://host[:port], lowercased", () => {
    expect(normalizeOrigin("HTTPS://Example.COM")).toBe("https://example.com");
    expect(normalizeOrigin("http://example.com:3000/")).toBe(
      "http://example.com:3000",
    );
    expect(normalizeOrigin("https://example.com/some/path")).toBe(
      "https://example.com",
    );
  });

  it("returns null for a malformed origin", () => {
    expect(normalizeOrigin("not a url")).toBeNull();
    expect(normalizeOrigin("")).toBeNull();
  });
});

describe("isWebSocketOriginAllowed", () => {
  it("allows a request with no Origin header (non-browser client)", () => {
    expect(isWebSocketOriginAllowed({ host: "example.com" })).toBe(true);
    expect(isWebSocketOriginAllowed({ origin: undefined, host: "x" })).toBe(
      true,
    );
  });

  it("rejects a malformed Origin header", () => {
    expect(
      isWebSocketOriginAllowed({ origin: "://bad", host: "example.com" }),
    ).toBe(false);
  });

  it("allows same-origin requests by default (Origin host matches Host)", () => {
    expect(
      isWebSocketOriginAllowed({
        origin: "http://example.com:3000",
        host: "example.com:3000",
      }),
    ).toBe(true);
    expect(
      isWebSocketOriginAllowed({
        origin: "https://example.com",
        host: "example.com",
      }),
    ).toBe(true);
  });

  it("rejects a cross-site Origin by default", () => {
    expect(
      isWebSocketOriginAllowed({
        origin: "https://evil.example.net",
        host: "example.com",
      }),
    ).toBe(false);
    // Same host, different port is still cross-origin.
    expect(
      isWebSocketOriginAllowed({
        origin: "http://example.com:9999",
        host: "example.com:3000",
      }),
    ).toBe(false);
  });

  it("rejects when Host is absent and no allowlist is configured", () => {
    expect(isWebSocketOriginAllowed({ origin: "https://example.com" })).toBe(
      false,
    );
  });

  it("honors an explicit allowlist regardless of Host", () => {
    const allowedOrigins = ["https://app.example.com", "http://localhost:3000"];
    expect(
      isWebSocketOriginAllowed({
        origin: "https://app.example.com",
        host: "internal-proxy",
        allowedOrigins,
      }),
    ).toBe(true);
    expect(
      isWebSocketOriginAllowed({
        origin: "https://other.example.com",
        host: "internal-proxy",
        allowedOrigins,
      }),
    ).toBe(false);
  });
});

describe("clientIpFromHeaders", () => {
  it("uses the first X-Forwarded-For hop when trusting the proxy", () => {
    expect(
      clientIpFromHeaders("203.0.113.7, 10.0.0.1", "127.0.0.1", true),
    ).toBe("203.0.113.7");
    expect(clientIpFromHeaders(["198.51.100.2"], "127.0.0.1", true)).toBe(
      "198.51.100.2",
    );
  });

  it("ignores X-Forwarded-For when not trusting the proxy", () => {
    expect(
      clientIpFromHeaders("203.0.113.7", "192.168.1.5", false),
    ).toBe("192.168.1.5");
  });

  it("falls back to remoteAddress, then a stable sentinel", () => {
    expect(clientIpFromHeaders(undefined, "192.168.1.5", true)).toBe(
      "192.168.1.5",
    );
    expect(clientIpFromHeaders(undefined, undefined, true)).toBe("unknown");
    expect(clientIpFromHeaders("   ", undefined, true)).toBe("unknown");
  });
});

describe("SlidingWindowRateLimiter", () => {
  it("allows up to `max` attempts within the window, then blocks", () => {
    const rl = new SlidingWindowRateLimiter(3, 1000);
    expect(rl.check("ip", 0)).toBe(true);
    expect(rl.check("ip", 100)).toBe(true);
    expect(rl.check("ip", 200)).toBe(true);
    expect(rl.check("ip", 300)).toBe(false);
  });

  it("frees capacity as attempts age out of the window", () => {
    const rl = new SlidingWindowRateLimiter(2, 1000);
    expect(rl.check("ip", 0)).toBe(true);
    expect(rl.check("ip", 500)).toBe(true);
    expect(rl.check("ip", 900)).toBe(false);
    // The first attempt (t=0) leaves the 1000ms window at t=1001.
    expect(rl.check("ip", 1001)).toBe(true);
  });

  it("tracks keys independently", () => {
    const rl = new SlidingWindowRateLimiter(1, 1000);
    expect(rl.check("a", 0)).toBe(true);
    expect(rl.check("b", 0)).toBe(true);
    expect(rl.check("a", 1)).toBe(false);
  });

  it("is disabled when max <= 0", () => {
    const rl = new SlidingWindowRateLimiter(0, 1000);
    for (let i = 0; i < 100; i++) expect(rl.check("ip", i)).toBe(true);
  });

  it("sweeps expired buckets", () => {
    const rl = new SlidingWindowRateLimiter(5, 1000);
    rl.check("a", 0);
    rl.check("b", 0);
    expect(rl.size).toBe(2);
    rl.sweep(2000);
    expect(rl.size).toBe(0);
  });
});

describe("uploadExceedsCap", () => {
  it("flags an upload that would cross the cap", () => {
    expect(uploadExceedsCap(90, 20, 100)).toBe(true);
    expect(uploadExceedsCap(80, 20, 100)).toBe(false); // exactly at cap is OK
    expect(uploadExceedsCap(0, 101, 100)).toBe(true);
  });

  it("treats a cap of 0 or less as unlimited", () => {
    expect(uploadExceedsCap(1_000_000, 1_000_000, 0)).toBe(false);
    expect(uploadExceedsCap(5, 5, -1)).toBe(false);
  });
});

describe("uploadChunkInOrder", () => {
  it("accepts a chunk that continues exactly where the last ended", () => {
    expect(uploadChunkInOrder(0, 0)).toBe(true); // first chunk
    expect(uploadChunkInOrder(262144, 262144)).toBe(true); // next chunk
  });

  it("rejects a skipped, duplicated or reordered chunk", () => {
    expect(uploadChunkInOrder(512, 256)).toBe(false); // gap
    expect(uploadChunkInOrder(0, 256)).toBe(false); // duplicate/restart mid-stream
    expect(uploadChunkInOrder(256, 512)).toBe(false); // out of order
  });
});

describe("isIdleExpired", () => {
  it("reaps a session idle for at least the timeout", () => {
    expect(isIdleExpired(0, 60_000, 60_000)).toBe(true); // exactly at the limit
    expect(isIdleExpired(0, 90_000, 60_000)).toBe(true);
  });

  it("keeps a session that is still within the window", () => {
    expect(isIdleExpired(0, 59_999, 60_000)).toBe(false);
    expect(isIdleExpired(1000, 1500, 60_000)).toBe(false);
  });

  it("treats a timeout of 0 or less as disabled", () => {
    expect(isIdleExpired(0, 10_000_000, 0)).toBe(false);
    expect(isIdleExpired(0, 10_000_000, -1)).toBe(false);
  });
});

describe("accessTokenRequired", () => {
  it("is true only for a non-empty configured token", () => {
    expect(accessTokenRequired("s3cret")).toBe(true);
    expect(accessTokenRequired("  ")).toBe(false);
    expect(accessTokenRequired("")).toBe(false);
    expect(accessTokenRequired(undefined)).toBe(false);
  });
});

describe("accessTokenMatches", () => {
  it("authorizes only an exact match against a configured token", () => {
    expect(accessTokenMatches("s3cret", "s3cret")).toBe(true);
    expect(accessTokenMatches("s3cret", "nope")).toBe(false);
    expect(accessTokenMatches("s3cret", "S3cret")).toBe(false);
  });

  it("never authorizes when no token is configured", () => {
    expect(accessTokenMatches("", "")).toBe(false);
    expect(accessTokenMatches(undefined, "anything")).toBe(false);
    expect(accessTokenMatches("  ", "  ")).toBe(false);
  });
});

describe("parseCookieHeader", () => {
  it("parses name=value pairs, URL-decoding values", () => {
    expect(parseCookieHeader("a=1; b=two")).toEqual({ a: "1", b: "two" });
    expect(parseCookieHeader("sshweb_access=ab%20cd")).toEqual({
      sshweb_access: "ab cd",
    });
  });

  it("returns an empty map for an absent or empty header", () => {
    expect(parseCookieHeader(undefined)).toEqual({});
    expect(parseCookieHeader("")).toEqual({});
  });

  it("skips malformed pairs", () => {
    expect(parseCookieHeader("nonsense; good=1; =orphan")).toEqual({
      good: "1",
    });
  });
});

describe("isForwardBindAllowed", () => {
  it("permits loopback binds by default", () => {
    expect(isForwardBindAllowed("127.0.0.1", false)).toBe(true);
    expect(isForwardBindAllowed("::1", false)).toBe(true);
    expect(isForwardBindAllowed("localhost", false)).toBe(true);
    expect(isForwardBindAllowed("", false)).toBe(true);
    expect(isForwardBindAllowed(undefined, false)).toBe(true);
  });

  it("rejects a public bind unless explicitly allowed", () => {
    expect(isForwardBindAllowed("0.0.0.0", false)).toBe(false);
    expect(isForwardBindAllowed("192.168.1.5", false)).toBe(false);
  });

  it("permits any bind when public binds are allowed", () => {
    expect(isForwardBindAllowed("0.0.0.0", true)).toBe(true);
    expect(isForwardBindAllowed("192.168.1.5", true)).toBe(true);
  });
});
