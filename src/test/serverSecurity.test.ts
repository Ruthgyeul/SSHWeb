import { describe, expect, it } from "vitest";
import {
  accessTokenMatches,
  accessTokenRequired,
  buildSudoSftpCommand,
  clientIpFromHeaders,
  computeMaxPayloadBytes,
  DEFAULT_SFTP_SERVER_PATHS,
  isBlockedPrivateHost,
  isIdleExpired,
  isSecureRequest,
  isWebSocketOriginAllowed,
  normalizeOrigin,
  parseCookieHeader,
  SlidingWindowRateLimiter,
  uploadChunkInOrder,
  resumeUploadStart,
  uploadExceedsCap,
} from "@/lib/serverSecurity";

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
  it("takes the right-most (proxy-appended) X-Forwarded-For hop by default", () => {
    // A client can forge the left-most hop; our own proxy appends the real peer
    // to the right. With one trusted proxy that right-most hop is the client.
    expect(
      clientIpFromHeaders("203.0.113.7, 10.0.0.1", "127.0.0.1", true),
    ).toBe("10.0.0.1");
    // A single-hop XFF is unchanged (left-most and right-most coincide).
    expect(clientIpFromHeaders(["198.51.100.2"], "127.0.0.1", true)).toBe(
      "198.51.100.2",
    );
  });

  it("counts trustedHops in from the right for chained proxies", () => {
    // Two trusted proxies: the real client is the 2nd hop from the right.
    expect(
      clientIpFromHeaders(
        "1.1.1.1, 203.0.113.7, 10.0.0.1",
        "127.0.0.1",
        true,
        2,
      ),
    ).toBe("203.0.113.7");
    // More trusted hops than present clamps to the left-most hop.
    expect(
      clientIpFromHeaders("203.0.113.7, 10.0.0.1", "127.0.0.1", true, 9),
    ).toBe("203.0.113.7");
    // A non-positive / non-finite hop count falls back to a single hop.
    expect(
      clientIpFromHeaders("203.0.113.7, 10.0.0.1", "127.0.0.1", true, 0),
    ).toBe("10.0.0.1");
  });

  it("ignores X-Forwarded-For when not trusting the proxy", () => {
    expect(clientIpFromHeaders("203.0.113.7", "192.168.1.5", false)).toBe(
      "192.168.1.5",
    );
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

describe("resumeUploadStart", () => {
  it("continues from the remote partial's size", () => {
    expect(resumeUploadStart(262144, 1_000_000)).toEqual({
      offset: 262144,
      done: false,
    });
  });

  it("restarts from 0 when the remote file is missing", () => {
    expect(resumeUploadStart(0, 1_000_000)).toEqual({
      offset: 0,
      done: false,
    });
  });

  it("reports done when the remote already holds every byte", () => {
    expect(resumeUploadStart(500, 500)).toEqual({ offset: 500, done: true });
  });

  it("clamps a stale partial larger than the source into range", () => {
    // A mismatched/larger remote file can't drive an over-long remaining range.
    expect(resumeUploadStart(999, 500)).toEqual({ offset: 500, done: true });
  });

  it("treats a zero-byte source as immediately done", () => {
    expect(resumeUploadStart(0, 0)).toEqual({ offset: 0, done: true });
  });

  it("floors a fractional remote size and never goes negative", () => {
    expect(resumeUploadStart(100.7, 1000)).toEqual({
      offset: 100,
      done: false,
    });
    expect(resumeUploadStart(-5, 1000)).toEqual({ offset: 0, done: false });
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

describe("computeMaxPayloadBytes", () => {
  it("returns 0 (unbounded) when uploads are unlimited", () => {
    expect(computeMaxPayloadBytes(0)).toBe(0);
    expect(computeMaxPayloadBytes(-1)).toBe(0);
  });

  it("bounds a large upload cap to base64 size plus headroom", () => {
    const cap = 25 * 1024 * 1024;
    const bound = computeMaxPayloadBytes(cap);
    // Must admit the base64-inflated payload of a max-size upload…
    expect(bound).toBeGreaterThanOrEqual(Math.ceil(cap * (4 / 3)));
    // …but stay well under the library's 100 MiB default.
    expect(bound).toBeLessThan(100 * 1024 * 1024);
  });

  it("enforces an 8 MiB floor so a tiny cap still admits control frames", () => {
    expect(computeMaxPayloadBytes(1024)).toBe(8 * 1024 * 1024);
  });
});

describe("isSecureRequest", () => {
  it("treats a directly-encrypted socket as HTTPS", () => {
    expect(isSecureRequest(undefined, true)).toBe(true);
    expect(isSecureRequest("http", true)).toBe(true);
  });

  it("honors X-Forwarded-Proto from a TLS-terminating proxy", () => {
    expect(isSecureRequest("https", false)).toBe(true);
    expect(isSecureRequest("https,http", false)).toBe(true);
    expect(isSecureRequest(["https", "http"], false)).toBe(true);
    expect(isSecureRequest("HTTPS", false)).toBe(true);
  });

  it("is not secure for plain HTTP with no TLS anywhere", () => {
    expect(isSecureRequest(undefined, false)).toBe(false);
    expect(isSecureRequest("http", false)).toBe(false);
    expect(isSecureRequest("", false)).toBe(false);
  });
});

describe("buildSudoSftpCommand", () => {
  it("uses non-interactive sudo (-n) when no password is provided", () => {
    const cmd = buildSudoSftpCommand(false);
    expect(cmd.startsWith("sudo -n ")).toBe(true);
    expect(cmd).not.toContain("-S");
  });

  it("reads the password from stdin (-S) and clears the cache (-k) with a password", () => {
    const cmd = buildSudoSftpCommand(true);
    expect(cmd.startsWith("sudo -k -S -p '' ")).toBe(true);
  });

  it("searches the default sftp-server locations in order and execs the first", () => {
    const cmd = buildSudoSftpCommand(false);
    for (const p of DEFAULT_SFTP_SERVER_PATHS) expect(cmd).toContain(p);
    expect(cmd).toContain('[ -x "$p" ] && exec "$p"');
    // Debian/Ubuntu path is tried before the RHEL one.
    expect(cmd.indexOf("/usr/lib/openssh/sftp-server")).toBeLessThan(
      cmd.indexOf("/usr/libexec/openssh/sftp-server"),
    );
  });

  it("fails loudly when no sftp-server is found", () => {
    const cmd = buildSudoSftpCommand(false);
    expect(cmd).toContain('echo "sftp-server not found" >&2');
    expect(cmd).toContain("exit 127");
  });

  it("honors a custom path list and falls back to the defaults when empty", () => {
    expect(buildSudoSftpCommand(false, ["/opt/sftp"])).toContain(
      "for p in /opt/sftp;",
    );
    // An empty override collapses back to the built-in list.
    expect(buildSudoSftpCommand(false, [])).toContain(
      DEFAULT_SFTP_SERVER_PATHS[0],
    );
  });

  it("never interpolates the password into the command string", () => {
    // The password travels on stdin, not in the command; the builder only takes
    // a boolean, so a secret can never leak into the argv it produces.
    expect(buildSudoSftpCommand(true)).not.toMatch(/hunter2|password/i);
  });
});

describe("isBlockedPrivateHost", () => {
  it("blocks the cloud-metadata endpoint and link-local range", () => {
    expect(isBlockedPrivateHost("169.254.169.254")).toBe(true);
    expect(isBlockedPrivateHost("169.254.0.1")).toBe(true);
  });

  it("blocks loopback, private and shared IPv4 ranges", () => {
    for (const ip of [
      "127.0.0.1",
      "127.1.2.3",
      "10.0.0.5",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "100.64.0.1",
      "0.0.0.0",
    ]) {
      expect(isBlockedPrivateHost(ip), ip).toBe(true);
    }
  });

  it("blocks the localhost name and IPv6 loopback/ULA/link-local", () => {
    expect(isBlockedPrivateHost("localhost")).toBe(true);
    expect(isBlockedPrivateHost("db.localhost")).toBe(true);
    expect(isBlockedPrivateHost("::1")).toBe(true);
    expect(isBlockedPrivateHost("[::1]")).toBe(true);
    expect(isBlockedPrivateHost("fe80::1%eth0")).toBe(true);
    expect(isBlockedPrivateHost("fd00::1234")).toBe(true);
    expect(isBlockedPrivateHost("::ffff:169.254.169.254")).toBe(true);
  });

  it("allows public IPs and hostnames", () => {
    for (const host of [
      "203.0.113.10",
      "8.8.8.8",
      "172.32.0.1", // just outside 172.16/12
      "192.169.0.1", // just outside 192.168/16
      "example.com",
      "ssh.example.org",
      "2606:4700:4700::1111", // public IPv6 (Cloudflare)
    ]) {
      expect(isBlockedPrivateHost(host), host).toBe(false);
    }
  });
});
