import { cn } from "@/lib/utils";

/**
 * Small UI action icons as inline SVGs (`currentColor`, stroke-based) — used in
 * place of pictographic emoji (🔍/👁/📂/…), which render inconsistently (often
 * broken or as color glyphs) across platforms and fonts.
 */

function Svg({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("h-4 w-4 shrink-0", className)}
      aria-hidden
    >
      {children}
    </svg>
  );
}

/** Magnifying glass — search/find affordances. */
export function SearchIcon({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </Svg>
  );
}

/** Eye — read-only "view" (as opposed to edit). */
export function EyeIcon({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  );
}

/** Open folder — empty-directory placeholder. */
export function FolderOpenIcon({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <path d="M3 7a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.7.9l.8 1.2a2 2 0 0 0 1.7.9H19a2 2 0 0 1 2 2H5.5a2 2 0 0 0-1.9 1.4L3 19z" />
      <path d="M3 19h15.3a2 2 0 0 0 1.9-1.4l1.6-5" />
    </Svg>
  );
}

/** Pencil — edit affordance. */
export function PencilIcon({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
    </Svg>
  );
}
