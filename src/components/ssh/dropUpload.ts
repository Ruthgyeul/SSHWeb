/**
 * Drag-and-drop folder traversal for the SFTP file browser.
 *
 * When a directory is dropped onto the listing, the browser exposes its tree
 * through the `FileSystemEntry` API. These helpers walk that tree into a flat
 * list of files tagged with their path relative to the drop root, so the upload
 * can recreate the subdirectories remotely. They touch DOM/browser APIs, so
 * they live alongside the SSH components rather than in `lib/`.
 */

/** A file gathered from a drop, tagged with its path relative to the drop root. */
export interface DroppedFile {
  file: File;
  /** e.g. `photos/2024/a.jpg`, or just `a.jpg` for a top-level file. */
  relPath: string;
}

/** Read a `FileSystemFileEntry` as a `File` (promisified callback API). */
function entryToFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

/** Drain a directory reader — `readEntries` yields at most ~100 items per call. */
function readAllDirEntries(
  reader: FileSystemDirectoryReader,
): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = [];
    const read = () =>
      reader.readEntries((batch) => {
        if (batch.length === 0) return resolve(all);
        all.push(...batch);
        read();
      }, reject);
    read();
  });
}

/** Recursively collect files under a dropped entry, preserving relative paths. */
async function walkEntry(
  entry: FileSystemEntry,
  prefix: string,
  out: DroppedFile[],
): Promise<void> {
  if (entry.isFile) {
    const file = await entryToFile(entry as FileSystemFileEntry);
    out.push({ file, relPath: prefix + entry.name });
  } else if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const children = await readAllDirEntries(reader);
    for (const child of children) {
      await walkEntry(child, `${prefix}${entry.name}/`, out);
    }
  }
}

/**
 * Extract the `FileSystemEntry` for each dropped item, synchronously. Must run
 * before any `await`, because the `DataTransferItemList` is emptied once the
 * drop handler returns. Returns an empty list on browsers without the entry API.
 */
export function droppedEntries(
  items: DataTransferItemList | undefined,
): FileSystemEntry[] {
  return Array.from(items ?? [])
    .filter((it) => it.kind === "file")
    .map((it) => it.webkitGetAsEntry?.() ?? null)
    .filter((entry): entry is FileSystemEntry => entry !== null);
}

/**
 * Walk a list of dropped entries (files and/or directories) into a flat list of
 * files, each tagged with its path relative to the drop root.
 */
export async function collectDroppedFiles(
  entries: FileSystemEntry[],
): Promise<DroppedFile[]> {
  const out: DroppedFile[] = [];
  for (const entry of entries) await walkEntry(entry, "", out);
  return out;
}
