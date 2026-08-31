import { cn } from "@/lib/utils";

/**
 * Small UI action icons as inline SVGs (`currentColor`, stroke-based) — used in
 * place of pictographic emoji, which render inconsistently (often broken or as
 * color glyphs) across platforms and fonts.
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

/** Warning triangle — cautions/alerts. */
export function WarningIcon({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </Svg>
  );
}

/** Gear — settings. */
export function SettingsIcon({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </Svg>
  );
}

/** Clock — the session uptime read-out. */
export function ClockIcon({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </Svg>
  );
}

/** Circular arrow — refresh/reload. */
export function RefreshIcon({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v5h-5" />
    </Svg>
  );
}

/** Framed image with a corner rotate arrow — the image-preview rotate control
 * (distinct from the full-circle RefreshIcon). */
export function RotateIcon({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <rect x="3" y="9" width="12" height="12" rx="2" />
      <path d="M14 4a6 6 0 0 1 6 6" />
      <path d="M20 4v3h-3" />
    </Svg>
  );
}

/** Check mark — success / selected. */
export function CheckIcon({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <path d="m5 12 5 5L20 7" />
    </Svg>
  );
}

/** X mark — close / error / dismiss. */
export function XMarkIcon({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Svg>
  );
}

/** Plus — add / new. */
export function PlusIcon({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  );
}

/** Horizontal lines — list view. */
export function ListIcon({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <path d="M8 6h13M8 12h13M8 18h13" />
      <path d="M3 6h.01M3 12h.01M3 18h.01" />
    </Svg>
  );
}

/** Four squares — grid view. */
export function GridIcon({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </Svg>
  );
}

/** Up arrow into a tray — upload. */
export function UploadIcon({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M12 3v13" />
      <path d="m7 8 5-5 5 5" />
    </Svg>
  );
}

/** Down arrow into a tray — download. */
export function DownloadIcon({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M12 3v13" />
      <path d="m7 11 5 5 5-5" />
    </Svg>
  );
}

/** Trash can — delete. */
export function TrashIcon({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
    </Svg>
  );
}

/** Circled "i" — info / details. */
export function InfoIcon({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <path d="M12 8h.01" />
    </Svg>
  );
}

/** Folder with an arrow into it — move / rename (mv). */
export function MoveIcon({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <path d="M3 7a2 2 0 0 1 2-2h3.5a2 2 0 0 1 1.6.8l.9 1.2a2 2 0 0 0 1.6.8H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M8 14h6" />
      <path d="m11 11 3 3-3 3" />
    </Svg>
  );
}

/** Command-prompt window — "open terminal here". */
export function TerminalIcon({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 9 3 3-3 3" />
      <path d="M13 15h4" />
    </Svg>
  );
}

/** Stacked platters — disk usage (df). */
export function DiskIcon({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <ellipse cx="12" cy="6" rx="8" ry="3" />
      <path d="M4 6v6c0 1.66 3.58 3 8 3s8-1.34 8-3V6" />
      <path d="M4 12v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" />
    </Svg>
  );
}

/** Two overlapping sheets — copy (path / duplicate). */
export function CopyIcon({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </Svg>
  );
}

/** Crosshair on a ring — "go to path". */
export function TargetIcon({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
      <circle cx="12" cy="12" r="1.5" />
    </Svg>
  );
}

/** Document with a plus — create empty file (+file). */
export function FilePlusIcon({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M12 12v5M9.5 14.5h5" />
    </Svg>
  );
}

/** Folder with an up-arrow — upload a folder. */
export function FolderUploadIcon({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <path d="M3 7a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.7.9l.8 1.2a2 2 0 0 0 1.7.9H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M12 17v-5M9.5 14l2.5-2.5 2.5 2.5" />
    </Svg>
  );
}

/** Corner arrow — go to the parent directory (up). */
export function LevelUpIcon({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <path d="M5 19V9a2 2 0 0 1 2-2h12" />
      <path d="m15 3 4 4-4 4" />
    </Svg>
  );
}

/** Padlock with a keyhole — change permissions (chmod). */
export function LockIcon({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
      <circle cx="12" cy="15" r="1.3" />
      <path d="M12 16.2V18" />
    </Svg>
  );
}

/** Crown — elevated (sudo/root) access. */
export function CrownIcon({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <path d="M4 8.5 7.5 12 12 5.5 16.5 12 20 8.5 18.5 19h-13z" />
      <path d="M5.5 19h13" />
    </Svg>
  );
}

/** Two opposing arrows — compare / diff. */
export function DiffIcon({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <path d="M4 8h13m0 0-3-3m3 3-3 3" />
      <path d="M20 16H7m0 0 3-3m-3 3 3 3" />
    </Svg>
  );
}
