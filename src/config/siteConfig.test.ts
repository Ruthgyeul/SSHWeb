import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * siteConfig resolves its constants from `process.env` at module-eval time, so
 * each case stubs the relevant vars and re-imports the module fresh
 * (`vi.resetModules`) to observe the resolved value.
 */
async function loadConfig() {
  vi.resetModules();
  return import("./siteConfig");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("env fallbacks", () => {
  it("falls back to the SSHWeb defaults when a var is empty", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SITE_NAME", "");
    const cfg = await loadConfig();
    expect(cfg.SITE_URL).toBe("http://localhost:5000");
    expect(cfg.SITE_NAME).toBe("SSHWeb");
  });

  it("uses the env value when one is provided", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_NAME", "My Real Site");
    expect((await loadConfig()).SITE_NAME).toBe("My Real Site");
  });
});

describe("SITE_URL normalization", () => {
  it("adds an https scheme when missing", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "mysite.dev");
    expect((await loadConfig()).SITE_URL).toBe("https://mysite.dev");
  });

  it("strips a trailing slash so path concatenation stays clean", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://mysite.dev/");
    expect((await loadConfig()).SITE_URL).toBe("https://mysite.dev");
  });

  it("preserves an explicit http scheme (e.g. localhost)", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://localhost:3000/");
    expect((await loadConfig()).SITE_URL).toBe("http://localhost:3000");
  });
});

describe("SITE_LANG", () => {
  it("derives the BCP-47 lang from the OG locale (underscore → hyphen)", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_LOCALE", "ko_KR");
    expect((await loadConfig()).SITE_LANG).toBe("ko-KR");
  });
});

describe("ALLOW_INDEXING", () => {
  it("is false only when set to 'false' (case-insensitive)", async () => {
    vi.stubEnv("NEXT_PUBLIC_ALLOW_INDEXING", "false");
    expect((await loadConfig()).ALLOW_INDEXING).toBe(false);
    vi.stubEnv("NEXT_PUBLIC_ALLOW_INDEXING", "FALSE");
    expect((await loadConfig()).ALLOW_INDEXING).toBe(false);
  });

  it("defaults to true when unset or any other value", async () => {
    vi.stubEnv("NEXT_PUBLIC_ALLOW_INDEXING", "");
    expect((await loadConfig()).ALLOW_INDEXING).toBe(true);
    vi.stubEnv("NEXT_PUBLIC_ALLOW_INDEXING", "yes");
    expect((await loadConfig()).ALLOW_INDEXING).toBe(true);
  });
});
