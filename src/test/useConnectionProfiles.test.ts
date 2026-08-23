// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useConnectionProfiles } from "@/components/ssh/hooks/useConnectionProfiles";

const STORAGE_KEY = "sshweb.connectionProfiles";

afterEach(() => {
  localStorage.clear();
  // The hook keeps a module-level snapshot cache; clearing storage makes the
  // next getSnapshot re-parse to [] because the raw value changed to null.
});

describe("useConnectionProfiles", () => {
  it("starts empty and persists a saved profile (identity only, no secret)", () => {
    const { result } = renderHook(() => useConnectionProfiles());
    expect(result.current.profiles).toEqual([]);

    act(() =>
      result.current.save({
        host: "example.com",
        port: 22,
        username: "alice",
        auth: "password",
      }),
    );
    expect(result.current.profiles).toHaveLength(1);
    expect(result.current.profiles[0]).toMatchObject({
      host: "example.com",
      port: 22,
      username: "alice",
      auth: "password",
    });
    // A generated label and id, and nothing secret in storage.
    expect(result.current.profiles[0].id).toBeTruthy();
    const raw = localStorage.getItem(STORAGE_KEY) ?? "";
    expect(raw).toContain("example.com");
    // No credential-bearing field is persisted (the "password" that appears is
    // only the `auth` method value, not a stored secret).
    expect(raw).not.toMatch(/"(password|privateKey|passphrase|secret)"\s*:/);
  });

  it("ignores a save with a blank host or username", () => {
    const { result } = renderHook(() => useConnectionProfiles());
    act(() =>
      result.current.save({
        host: "   ",
        port: 22,
        username: "alice",
        auth: "password",
      }),
    );
    act(() =>
      result.current.save({
        host: "example.com",
        port: 22,
        username: "  ",
        auth: "password",
      }),
    );
    expect(result.current.profiles).toEqual([]);
  });

  it("updates the same server in place instead of duplicating", () => {
    const { result } = renderHook(() => useConnectionProfiles());
    act(() =>
      result.current.save({
        host: "host.example",
        port: 22,
        username: "bob",
        auth: "password",
      }),
    );
    const firstId = result.current.profiles[0].id;
    // Same user@host:port → update (auth flips to key), no new entry.
    act(() =>
      result.current.save({
        host: "host.example",
        port: 22,
        username: "bob",
        auth: "key",
      }),
    );
    expect(result.current.profiles).toHaveLength(1);
    expect(result.current.profiles[0].id).toBe(firstId);
    expect(result.current.profiles[0].auth).toBe("key");
  });

  it("keeps distinct servers as separate profiles, newest first", () => {
    const { result } = renderHook(() => useConnectionProfiles());
    act(() =>
      result.current.save({
        host: "a.example",
        port: 22,
        username: "u",
        auth: "password",
      }),
    );
    act(() =>
      result.current.save({
        host: "b.example",
        port: 2222,
        username: "u",
        auth: "password",
      }),
    );
    expect(result.current.profiles.map((p) => p.host)).toEqual([
      "b.example",
      "a.example",
    ]);
  });

  it("removes a profile by id", () => {
    const { result } = renderHook(() => useConnectionProfiles());
    act(() =>
      result.current.save({
        host: "gone.example",
        port: 22,
        username: "u",
        auth: "password",
      }),
    );
    const id = result.current.profiles[0].id;
    act(() => result.current.remove(id));
    expect(result.current.profiles).toEqual([]);
  });

  it("shares state across hook instances (cross-tab sync)", () => {
    const a = renderHook(() => useConnectionProfiles());
    const b = renderHook(() => useConnectionProfiles());
    act(() =>
      a.result.current.save({
        host: "shared.example",
        port: 22,
        username: "u",
        auth: "password",
      }),
    );
    // The second instance sees it via the in-page sync event.
    expect(b.result.current.profiles).toHaveLength(1);
    expect(b.result.current.profiles[0].host).toBe("shared.example");
  });
});
