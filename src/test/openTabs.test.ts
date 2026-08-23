import { describe, expect, it } from "vitest";

import {
  MAX_PERSISTED_TABS,
  parseOpenTabs,
  serializeOpenTabs,
  type PersistedTab,
} from "@/lib/openTabs";

describe("parseOpenTabs", () => {
  it("returns [] for empty / malformed input", () => {
    expect(parseOpenTabs(null)).toEqual([]);
    expect(parseOpenTabs("")).toEqual([]);
    expect(parseOpenTabs("not json")).toEqual([]);
    expect(parseOpenTabs("{}")).toEqual([]); // not an array
  });

  it("keeps name + sanitized connection identity", () => {
    const raw = JSON.stringify([
      {
        name: "prod",
        connect: {
          host: "example.com",
          port: "2222",
          username: "root",
          auth: "key",
        },
      },
    ]);
    expect(parseOpenTabs(raw)).toEqual([
      {
        name: "prod",
        connect: {
          host: "example.com",
          port: "2222",
          username: "root",
          auth: "key",
        },
      },
    ]);
  });

  it("never persists secrets even if present in input", () => {
    const raw = JSON.stringify([
      {
        name: "x",
        connect: {
          host: "h",
          port: "22",
          username: "u",
          auth: "password",
          password: "hunter2",
          privateKey: "-----BEGIN-----",
        },
      },
    ]);
    const [tab] = parseOpenTabs(raw);
    expect(tab.connect).toEqual({
      host: "h",
      port: "22",
      username: "u",
      auth: "password",
    });
    expect(JSON.stringify(tab)).not.toContain("hunter2");
    expect(JSON.stringify(tab)).not.toContain("BEGIN");
  });

  it("defaults an invalid port to 22 and unknown auth to password", () => {
    const raw = JSON.stringify([
      { connect: { host: "h", port: "abc", username: "u", auth: "weird" } },
    ]);
    expect(parseOpenTabs(raw)[0].connect).toEqual({
      host: "h",
      port: "22",
      username: "u",
      auth: "password",
    });
  });

  it("drops entries with neither a name nor a valid connection", () => {
    const raw = JSON.stringify([
      { connect: { host: "", username: "" } },
      { foo: "bar" },
      { name: "keep" },
    ]);
    expect(parseOpenTabs(raw)).toEqual([{ name: "keep", connect: undefined }]);
  });

  it("caps the list length", () => {
    const many: PersistedTab[] = Array.from({ length: 50 }, (_, i) => ({
      name: `t${i}`,
    }));
    expect(parseOpenTabs(serializeOpenTabs(many)).length).toBe(
      MAX_PERSISTED_TABS,
    );
  });
});
