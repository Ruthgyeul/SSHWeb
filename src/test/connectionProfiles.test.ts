import { describe, expect, it } from "vitest";
import {
  parseConnectionProfiles,
  profileMatchKey,
  removeConnectionProfile,
  upsertProfile,
  type ConnectionProfile,
} from "@/lib/connectionProfiles";

const idSeq = () => {
  let n = 0;
  return () => `id-${++n}`;
};

describe("profileMatchKey", () => {
  it("is case-insensitive on host and includes port + user", () => {
    expect(
      profileMatchKey({ username: "root", host: "Example.COM", port: 22 }),
    ).toBe("root@example.com:22");
  });
});

describe("parseConnectionProfiles", () => {
  it("returns [] for null / malformed JSON", () => {
    expect(parseConnectionProfiles(null)).toEqual([]);
    expect(parseConnectionProfiles("not json")).toEqual([]);
    expect(parseConnectionProfiles('{"not":"array"}')).toEqual([]);
  });

  it("drops entries missing required fields and defaults label/auth", () => {
    const raw = JSON.stringify([
      { id: "a", host: "h", port: 22, username: "u" }, // no label/auth
      { id: "b", host: "", port: 22, username: "u" }, // empty host → dropped
      { id: "c", port: 22, username: "u" }, // no host → dropped
      { id: "d", host: "h2", port: 2222, username: "bob", auth: "key", label: "prod" },
    ]);
    const out = parseConnectionProfiles(raw);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      id: "a",
      host: "h",
      port: 22,
      username: "u",
      auth: "password",
      label: "u@h",
    });
    expect(out[1].label).toBe("prod");
    expect(out[1].auth).toBe("key");
  });
});

describe("upsertProfile", () => {
  it("prepends a new profile with a generated id and default label", () => {
    const out = upsertProfile(
      [],
      { host: "h", port: 22, username: "root", auth: "password" },
      idSeq(),
    );
    expect(out).toEqual([
      {
        id: "id-1",
        host: "h",
        port: 22,
        username: "root",
        auth: "password",
        label: "root@h",
      },
    ]);
  });

  it("updates the same server in place (no duplicate, keeps id/position)", () => {
    const list: ConnectionProfile[] = [
      { id: "x", host: "a", port: 22, username: "root", auth: "password", label: "a" },
      { id: "y", host: "b", port: 22, username: "root", auth: "password", label: "b" },
    ];
    // Re-save server "a" but switch to key auth.
    const out = upsertProfile(
      list,
      { host: "A", port: 22, username: "root", auth: "key" },
      idSeq(),
    );
    expect(out).toHaveLength(2);
    expect(out.map((p) => p.id)).toEqual(["x", "y"]); // order + id preserved
    expect(out[0].auth).toBe("key");
    expect(out[0].host).toBe("A");
  });

  it("honors an explicit label but ignores a blank one", () => {
    const withLabel = upsertProfile(
      [],
      { host: "h", port: 22, username: "u", auth: "password", label: "  prod  " },
      idSeq(),
    );
    expect(withLabel[0].label).toBe("prod");
    const blank = upsertProfile(
      [],
      { host: "h", port: 2222, username: "u", auth: "password", label: "   " },
      idSeq(),
    );
    expect(blank[0].label).toBe("u@h:2222");
  });
});

describe("removeConnectionProfile", () => {
  it("removes by id", () => {
    const list: ConnectionProfile[] = [
      { id: "x", host: "a", port: 22, username: "u", auth: "password", label: "a" },
      { id: "y", host: "b", port: 22, username: "u", auth: "password", label: "b" },
    ];
    expect(removeConnectionProfile(list, "x").map((p) => p.id)).toEqual(["y"]);
    expect(removeConnectionProfile(list, "nope")).toHaveLength(2);
  });
});
