// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { triggerDownload } from "@/components/ssh/dom/download";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("triggerDownload", () => {
  it("saves bytes via an object-URL anchor click and cleans up", () => {
    const objectUrl = "blob:mock-url";
    const createObjectURL = vi.fn(() => objectUrl);
    const revokeObjectURL = vi.fn();
    // jsdom doesn't implement the object-URL APIs; stub them.
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL,
      revokeObjectURL,
    });

    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    const appendSpy = vi.spyOn(document.body, "appendChild");

    triggerDownload("report.bin", new Uint8Array([1, 2, 3]));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    const anchor = appendSpy.mock.calls[0][0] as HTMLAnchorElement;
    expect(anchor.download).toBe("report.bin");
    expect(anchor.href).toContain(objectUrl);
    // The anchor is removed and the object URL revoked afterwards.
    expect(document.querySelector("a[download]")).toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledWith(objectUrl);

    vi.unstubAllGlobals();
  });
});
