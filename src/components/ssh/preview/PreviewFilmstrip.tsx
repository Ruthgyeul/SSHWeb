import { type RefObject } from "react";

import { cn } from "@/lib/utils";
import { FileIcon, iconKindForName } from "../FileIcon";

/** One tile in the gallery filmstrip. */
export interface FilmstripEntry {
  path: string;
  name: string;
  thumb?: string;
}

/**
 * The bottom thumbnail filmstrip of the preview gallery, extracted from
 * `FilePreview`. Renders a scrollable row of sibling tiles; the active tile is
 * ringed and (via `activeRef`) scrolled into view by the parent when the gallery
 * steps. Clicking a tile jumps straight to that sibling.
 */
export function PreviewFilmstrip({
  entries,
  activePath,
  activeRef,
  onJump,
}: {
  entries: FilmstripEntry[];
  activePath: string;
  /** Attached to the active tile so the parent can scroll it into view. */
  activeRef: RefObject<HTMLButtonElement | null>;
  onJump?: (path: string) => void;
}) {
  return (
    <div className="flex shrink-0 gap-1.5 overflow-x-auto border-t border-term-border bg-term-panel/90 px-3 py-2">
      {entries.map((f) => {
        const activeTile = f.path === activePath;
        return (
          <button
            key={f.path}
            ref={activeTile ? activeRef : undefined}
            type="button"
            onClick={() => onJump?.(f.path)}
            title={f.name}
            aria-current={activeTile}
            className={cn(
              "h-12 w-12 shrink-0 overflow-hidden rounded border",
              activeTile
                ? "border-term-accent"
                : "border-term-border opacity-60 hover:opacity-100",
            )}
          >
            {f.thumb ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={f.thumb}
                alt={f.name}
                className="h-full w-full object-cover"
              />
            ) : (
              <span className="flex h-full w-full items-center justify-center text-term-muted">
                <FileIcon kind={iconKindForName(f.name)} className="h-5 w-5" />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
