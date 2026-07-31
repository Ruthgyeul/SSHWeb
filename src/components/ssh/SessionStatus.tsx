"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/** Lifecycle phase of a single SSH session. */
export type SessionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "dropped"
  | "error";

/** The coloured status dot shared by the session header and the manager's tabs. */
export function StatusDot({ status }: { status: SessionStatus }) {
  const busy = status === "connecting" || status === "reconnecting";
  return (
    <span
      className={cn(
        "h-2.5 w-2.5 flex-none rounded-full",
        status === "connected"
          ? "bg-term-green term-pulse-soft"
          : status === "error" || status === "dropped"
            ? "bg-term-red"
            : busy
              ? "bg-term-yellow term-pulse"
              : "bg-term-fainter",
      )}
      aria-hidden
    />
  );
}

/** Live "connected for" clock, ticking once a second (mm:ss, or h:mm:ss). */
export function Uptime({ since }: { since: number }) {
  // Seed with `since` (elapsed 0) so render stays pure; the interval advances it
  // to real time on the first tick (~1s later — an unnoticeable initial delay).
  const [now, setNow] = useState(since);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const total = Math.max(0, Math.floor((now - since) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  const label = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  return (
    <span
      className="flex-none tabular-nums text-[11px] text-term-faint"
      title="Connected for"
    >
      ⏱ {label}
    </span>
  );
}

/** A small latency read-out (ms), colour-coded green/yellow/red by round-trip. */
export function LatencyChip({ ms }: { ms: number }) {
  const color =
    ms < 100 ? "text-term-green" : ms < 300 ? "text-term-yellow" : "text-term-red";
  return (
    <span
      className={cn("flex-none tabular-nums text-[11px]", color)}
      title="Round-trip latency to the SSH bridge"
    >
      {ms} ms
    </span>
  );
}
