import { type RefObject } from "react";

import { cn } from "@/lib/utils";
import { ChevronDownIcon } from "../icons";
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
 * steps. Clicking a tile jumps straight to that sibling. The strip itself can be
 * collapsed to a slim handle bar — `collapsed`/`onToggleCollapsed` are owned by
 * the parent (`SshSession`), since `FilePreview` remounts on every gallery step
 * and would otherwise lose the state.
 */
export function PreviewFilmstrip({
  entries,
  activePath,
  activeRef,
  collapsed,
  onToggleCollapsed,
  onJump,
}: {
  entries: FilmstripEntry[];
  activePath: string;
  /** Attached to the active tile so the parent can scroll it into view. */
  activeRef: RefObject<HTMLButtonElement | null>;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onJump?: (path: string) => void;
}) {
  if (collapsed) {
    return (
      <div className="flex shrink-0 justify-center border-t border-term-border bg-term-panel/90">
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-expanded={false}
          aria-label="Show filmstrip"
          title="Show filmstrip"
          className="flex w-full items-center justify-center py-1 text-term-muted hover:text-term-text"
        >
          <ChevronDownIcon className="h-4 w-4 rotate-180" />
        </button>
      </div>
    );
  }

  return (
    <div className="flex shrink-0 flex-col border-t border-term-border bg-term-panel/90">
      <button
        type="button"
        onClick={onToggleCollapsed}
        aria-expanded={true}
        aria-label="Hide filmstrip"
        title="Hide filmstrip"
        className="flex items-center justify-center py-0.5 text-term-muted hover:text-term-text"
      >
        <ChevronDownIcon className="h-3.5 w-3.5" />
      </button>
      <div className="flex gap-1.5 overflow-x-auto px-3 pb-2">
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
                  <FileIcon
                    kind={iconKindForName(f.name)}
                    className="h-5 w-5"
                  />
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
