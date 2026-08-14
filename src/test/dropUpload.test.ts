// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  collectDroppedFiles,
  droppedEntries,
} from "@/components/ssh/dom/dropUpload";

/* Minimal fakes for the FileSystemEntry API (jsdom has no drag-drop entries). */
function fileEntry(name: string, contents = "x"): FileSystemEntry {
  const file = new File([contents], name);
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (resolve: (f: File) => void) => resolve(file),
  } as unknown as FileSystemEntry;
}

function dirEntry(name: string, children: FileSystemEntry[]): FileSystemEntry {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => {
      let drained = false;
      return {
        // readEntries yields the whole batch once, then an empty batch to signal
        // the end — matching the real API the helper drains in a loop.
        readEntries: (resolve: (batch: FileSystemEntry[]) => void) => {
          if (drained) return resolve([]);
          drained = true;
          resolve(children);
        },
      };
    },
  } as unknown as FileSystemEntry;
}

describe("collectDroppedFiles", () => {
  it("flattens a nested tree into files tagged with their relative path", async () => {
    const tree = [
      fileEntry("a.txt"),
      dirEntry("photos", [
        fileEntry("b.jpg"),
        dirEntry("2024", [fileEntry("c.png")]),
      ]),
    ];

    const result = await collectDroppedFiles(tree);
    const relPaths = result.map((r) => r.relPath).sort();

    expect(relPaths).toEqual(["a.txt", "photos/2024/c.png", "photos/b.jpg"]);
    expect(result.every((r) => r.file instanceof File)).toBe(true);
  });

  it("returns an empty list for no entries", async () => {
    expect(await collectDroppedFiles([])).toEqual([]);
  });
});

describe("droppedEntries", () => {
  it("maps file items through webkitGetAsEntry and drops non-files/nulls", () => {
    const entryA = fileEntry("a.txt");
    const items = [
      { kind: "file", webkitGetAsEntry: () => entryA },
      { kind: "string", webkitGetAsEntry: () => null }, // not a file → dropped
      { kind: "file", webkitGetAsEntry: () => null }, // null entry → dropped
    ] as unknown as DataTransferItemList;

    expect(droppedEntries(items)).toEqual([entryA]);
  });

  it("returns an empty list when the list is undefined", () => {
    expect(droppedEntries(undefined)).toEqual([]);
  });
});
