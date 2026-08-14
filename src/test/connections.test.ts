import { describe, expect, it } from "vitest";
import {
  connectionLabel,
  reusableConnectionsExcluding,
} from "@/lib/connections";

describe("connectionLabel", () => {
  it("omits the port for the default 22", () => {
    expect(connectionLabel({ username: "root", host: "example.com", port: 22 })).toBe(
      "root@example.com",
    );
  });

  it("appends a non-default port", () => {
    expect(
      connectionLabel({ username: "alice", host: "10.0.0.1", port: 2222 }),
    ).toBe("alice@10.0.0.1:2222");
  });
});

describe("reusableConnectionsExcluding", () => {
  const a = { username: "root", host: "a.example", port: 22 };
  const b = { username: "alice", host: "b.example", port: 2222 };

  it("excludes the calling tab's own connection", () => {
    const out = reusableConnectionsExcluding({ 0: a, 1: b }, 0);
    expect(out).toEqual([{ label: "alice@b.example:2222", details: b }]);
  });

  it("de-duplicates the same server across tabs (first wins)", () => {
    const a2 = { username: "root", host: "a.example", port: 22 };
    const out = reusableConnectionsExcluding({ 0: a, 1: a2, 2: b }, 5);
    expect(out.map((o) => o.label)).toEqual([
      "root@a.example",
      "alice@b.example:2222",
    ]);
    // The first occurrence's details object is the one offered.
    expect(out[0].details).toBe(a);
  });

  it("returns an empty list when only the calling tab is connected", () => {
    expect(reusableConnectionsExcluding({ 3: a }, 3)).toEqual([]);
  });
});
