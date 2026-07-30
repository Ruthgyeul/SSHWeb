import { describe, expect, it } from "vitest";
import {
  knownHostEntries,
  parseKnownHosts,
  removeKnownHost,
  serializeKnownHosts,
  splitHostId,
  type KnownHostMap,
} from "./knownHosts";

describe("parseKnownHosts", () => {
  it("parses a well-formed map", () => {
    const raw = JSON.stringify({ "example.com:22": "SHA256:abc" });
    expect(parseKnownHosts(raw)).toEqual({ "example.com:22": "SHA256:abc" });
  });

  it("returns an empty map for missing/blank/corrupt input", () => {
    expect(parseKnownHosts(null)).toEqual({});
    expect(parseKnownHosts(undefined)).toEqual({});
    expect(parseKnownHosts("")).toEqual({});
    expect(parseKnownHosts("not json")).toEqual({});
    expect(parseKnownHosts("[1,2,3]")).toEqual({}); // array, not an object
    expect(parseKnownHosts("42")).toEqual({});
  });

  it("drops non-string values but keeps the valid ones", () => {
    const raw = JSON.stringify({ "a:22": "SHA256:x", "b:22": 7, "c:22": null });
    expect(parseKnownHosts(raw)).toEqual({ "a:22": "SHA256:x" });
  });

  it("round-trips through serialize", () => {
    const map: KnownHostMap = { "h:2222": "SHA256:z" };
    expect(parseKnownHosts(serializeKnownHosts(map))).toEqual(map);
  });
});

describe("splitHostId", () => {
  it("splits host and port", () => {
    expect(splitHostId("example.com:2222")).toEqual({
      host: "example.com",
      port: 2222,
    });
  });

  it("defaults the port to 22 when absent or invalid", () => {
    expect(splitHostId("example.com")).toEqual({
      host: "example.com",
      port: 22,
    });
    expect(splitHostId("example.com:abc")).toEqual({
      host: "example.com",
      port: 22,
    });
  });
});

describe("knownHostEntries", () => {
  it("expands and sorts by host then port", () => {
    const map: KnownHostMap = {
      "b.example:22": "SHA256:2",
      "a.example:2222": "SHA256:1b",
      "a.example:22": "SHA256:1a",
    };
    expect(knownHostEntries(map)).toEqual([
      { id: "a.example:22", host: "a.example", port: 22, fingerprint: "SHA256:1a" },
      { id: "a.example:2222", host: "a.example", port: 2222, fingerprint: "SHA256:1b" },
      { id: "b.example:22", host: "b.example", port: 22, fingerprint: "SHA256:2" },
    ]);
  });

  it("is empty for an empty map", () => {
    expect(knownHostEntries({})).toEqual([]);
  });
});

describe("removeKnownHost", () => {
  it("removes an entry without mutating the input", () => {
    const map: KnownHostMap = { "a:22": "x", "b:22": "y" };
    const next = removeKnownHost(map, "a:22");
    expect(next).toEqual({ "b:22": "y" });
    expect(map).toEqual({ "a:22": "x", "b:22": "y" }); // unchanged
  });

  it("returns the same map when the id is absent", () => {
    const map: KnownHostMap = { "a:22": "x" };
    expect(removeKnownHost(map, "missing:22")).toBe(map);
  });
});
