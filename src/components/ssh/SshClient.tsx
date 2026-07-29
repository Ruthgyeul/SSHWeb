"use client";

import { useCallback, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import {
  SshSession,
  StatusDot,
  type SessionMeta,
} from "./SshSession";

/**
 * Multi-session shell around {@link SshSession}. Each tab is an independent SSH
 * connection with its own WebSocket, terminal and file browser; sessions stay
 * mounted when they aren't the active tab so their connections keep running in
 * the background. Add tabs with "＋", close them with the ✕ on each tab.
 */
export function SshClient() {
  const nextIdRef = useRef(1);
  const [ids, setIds] = useState<number[]>([0]);
  const [activeId, setActiveId] = useState(0);
  const [metas, setMetas] = useState<Record<number, SessionMeta>>({});
  // User-assigned tab names (override the auto `user@host` label). Editing state
  // holds the id being renamed and the in-progress draft.
  const [names, setNames] = useState<Record<number, string>>({});
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState("");

  const startRename = useCallback((id: number, current: string) => {
    setEditingId(id);
    setDraft(current);
  }, []);

  const commitRename = useCallback((id: number) => {
    setNames((prev) => {
      const name = draft.trim();
      const next = { ...prev };
      if (name) next[id] = name;
      else delete next[id];
      return next;
    });
    setEditingId(null);
  }, [draft]);

  // Record a session's reported label/status, bailing out when unchanged so a
  // child re-render doesn't cascade into a parent update loop.
  const updateMeta = useCallback((id: number, m: SessionMeta) => {
    setMetas((prev) =>
      prev[id]?.label === m.label && prev[id]?.status === m.status
        ? prev
        : { ...prev, [id]: m },
    );
  }, []);

  const addSession = useCallback(() => {
    const id = nextIdRef.current++;
    setIds((prev) => [...prev, id]);
    setActiveId(id);
  }, []);

  const closeSession = useCallback(
    (id: number) => {
      setIds((prev) => {
        if (prev.length <= 1) return prev; // keep at least one tab
        const idx = prev.indexOf(id);
        const next = prev.filter((x) => x !== id);
        setActiveId((cur) =>
          cur === id ? next[Math.min(idx, next.length - 1)] : cur,
        );
        return next;
      });
      setMetas((prev) => {
        const rest = { ...prev };
        delete rest[id];
        return rest;
      });
      setNames((prev) => {
        const rest = { ...prev };
        delete rest[id];
        return rest;
      });
    },
    [],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {/* Session tab strip */}
      <div className="flex items-center gap-1.5 overflow-x-auto">
        {ids.map((id) => {
          const meta = metas[id];
          const isActive = id === activeId;
          const label = names[id] ?? meta?.label ?? "New session";
          return (
            <div
              key={id}
              className={cn(
                "group flex flex-none items-center gap-2 rounded-lg border px-3 py-1.5 text-xs transition-colors",
                isActive
                  ? "border-term-accent/40 bg-term-accent/10 text-term-text"
                  : "border-term-border bg-term-panel text-term-muted hover:text-term-text",
              )}
            >
              {editingId === id ? (
                <input
                  value={draft}
                  autoFocus
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => commitRename(id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commitRename(id);
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      setEditingId(null);
                    }
                  }}
                  placeholder={meta?.label ?? "Tab name"}
                  className="w-32 rounded border border-term-accent/40 bg-term-panel px-1.5 py-0.5 text-xs text-term-text outline-none"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setActiveId(id)}
                  onDoubleClick={() => startRename(id, label)}
                  title="Double-click to rename"
                  className="flex items-center gap-2"
                >
                  <StatusDot status={meta?.status ?? "idle"} />
                  <span className="max-w-[12rem] truncate">{label}</span>
                </button>
              )}
              {ids.length > 1 && (
                <button
                  type="button"
                  onClick={() => closeSession(id)}
                  className="text-term-faint hover:text-term-red"
                  title="Close session"
                  aria-label="Close session"
                >
                  ✕
                </button>
              )}
            </div>
          );
        })}
        <button
          type="button"
          onClick={addSession}
          className="flex-none rounded-lg border border-term-border bg-term-panel px-3 py-1.5 text-xs text-term-muted hover:text-term-accent"
          title="New session"
          aria-label="New session"
        >
          ＋
        </button>
      </div>

      {/* Session panels — all mounted; only the active one is visible. */}
      <div className="relative min-h-0 flex-1">
        {ids.map((id) => (
          <div
            key={id}
            className={cn(
              "absolute inset-0",
              id === activeId ? "block" : "hidden",
            )}
          >
            <SshSession
              active={id === activeId}
              onMeta={(m) => updateMeta(id, m)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
