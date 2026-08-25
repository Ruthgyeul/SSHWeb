"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import {
  parseOpenTabs,
  serializeOpenTabs,
  type PersistedTab,
} from "@/lib/openTabs";
import {
  SshSession,
  StatusDot,
  type SessionMeta,
  type ReusableConnection,
} from "./SshSession";
import type { ConnectDetails, ConnectFormInitial } from "./ConnectForm";
import { reusableConnectionsExcluding } from "@/lib/connections";
import { PromptDialog, type DialogRequest } from "./PromptDialog";

const OPEN_TABS_KEY = "sshweb.openTabs";

/** Build tab state from persisted tabs (#25), or null when there's nothing to
 * restore. Restoration runs in an effect (not during render) so the server and
 * the client's first render agree — avoiding a hydration mismatch. */
function restoreOpenTabs(): {
  ids: number[];
  names: Record<number, string>;
  pending: Record<number, ConnectFormInitial>;
  nextId: number;
} | null {
  if (typeof window === "undefined") return null;
  let tabs: PersistedTab[] = [];
  try {
    tabs = parseOpenTabs(localStorage.getItem(OPEN_TABS_KEY));
  } catch {
    return null;
  }
  if (tabs.length === 0) return null;
  // Allocate fresh ids starting at 1 so restored tabs never reuse the initial
  // render's id 0 — every restored tab is then a fresh mount that receives its
  // `initialConnect` prefill (a re-render of the pre-existing tab wouldn't).
  const ids: number[] = [];
  const names: Record<number, string> = {};
  const pending: Record<number, ConnectFormInitial> = {};
  tabs.forEach((tab, i) => {
    const id = i + 1;
    ids.push(id);
    if (tab.name) names[id] = tab.name;
    if (tab.connect) {
      pending[id] = {
        host: tab.connect.host,
        port: tab.connect.port,
        username: tab.connect.username,
        auth: tab.connect.auth,
      };
    }
  });
  return { ids, names, pending, nextId: tabs.length + 1 };
}

/**
 * Multi-session shell around {@link SshSession}. Each tab is an independent SSH
 * connection with its own WebSocket, terminal and file browser; sessions stay
 * mounted when they aren't the active tab so their connections keep running in
 * the background. Add tabs with "＋", close them with the ✕ on each tab.
 */
export function SshClient() {
  // Start from the same default state the server renders (one empty tab); the
  // persisted tab strip is restored in an effect after hydration (#25) so SSR
  // and the client's first render match.
  const nextIdRef = useRef(1);
  const [ids, setIds] = useState<number[]>([0]);
  const [activeId, setActiveId] = useState(0);
  const [metas, setMetas] = useState<Record<number, SessionMeta>>({});
  // Live connections per tab (in-memory only), so a new tab can offer a
  // one-click "same server" login without re-entering — or re-typing — anything.
  const [connections, setConnections] = useState<
    Record<number, ConnectDetails>
  >({});
  // User-assigned tab names (override the auto `user@host` label). Editing state
  // holds the id being renamed and the in-progress draft.
  const [names, setNames] = useState<Record<number, string>>({});
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  // Connect-form prefill for a freshly-duplicated tab (#83) or a restored tab
  // (#25), consumed on mount by that tab's connect form.
  const [pendingInitial, setPendingInitial] = useState<
    Record<number, ConnectFormInitial>
  >({});
  // A pending confirm dialog (e.g. "close a busy tab?", #85); null when idle.
  const [dialog, setDialog] = useState<DialogRequest | null>(null);
  // Gate persistence until after the post-hydration restore runs, so the first
  // (default-state) render doesn't clobber saved tabs before they're loaded.
  const [hydrated, setHydrated] = useState(false);

  // Restore persisted tabs once, after hydration (#25). Reading localStorage and
  // applying it here (rather than in a render-time initializer) is deliberate:
  // it keeps the server and the client's first render identical, avoiding a
  // hydration mismatch. The set-state-in-effect rule doesn't model this
  // client-only-data-after-hydration pattern, so it's disabled for this effect.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const r = restoreOpenTabs();
    if (r) {
      nextIdRef.current = r.nextId;
      setIds(r.ids);
      setActiveId(r.ids[0] ?? 0);
      setNames(r.names);
      setPendingInitial(r.pending);
    }
    setHydrated(true);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  const startRename = useCallback((id: number, current: string) => {
    setEditingId(id);
    setDraft(current);
  }, []);

  const commitRename = useCallback(
    (id: number) => {
      setNames((prev) => {
        const name = draft.trim();
        const next = { ...prev };
        if (name) next[id] = name;
        else delete next[id];
        return next;
      });
      setEditingId(null);
    },
    [draft],
  );

  // Record a session's reported label/status, bailing out when unchanged so a
  // child re-render doesn't cascade into a parent update loop.
  const updateMeta = useCallback((id: number, m: SessionMeta) => {
    setMetas((prev) =>
      prev[id]?.label === m.label &&
      prev[id]?.status === m.status &&
      prev[id]?.busy === m.busy
        ? prev
        : { ...prev, [id]: m },
    );
  }, []);

  // Record (or clear) a tab's live connection details.
  const reportConnection = useCallback(
    (id: number, details: ConnectDetails | null) => {
      setConnections((prev) => {
        if (!details) {
          if (!(id in prev)) return prev;
          const rest = { ...prev };
          delete rest[id];
          return rest;
        }
        if (prev[id] === details) return prev;
        return { ...prev, [id]: details };
      });
      // Keep the persisted seed in step with the latest real connection (#25):
      // otherwise, after the user edits a restored/duplicated prefill and
      // connects elsewhere, disconnecting would fall back to the stale original
      // seed and a reload would restore the wrong host.
      if (details) {
        setPendingInitial((prev) => ({
          ...prev,
          [id]: {
            host: details.host,
            port: String(details.port),
            username: details.username,
            auth: details.privateKey ? "key" : "password",
          },
        }));
      }
    },
    [],
  );

  // The reusable connections offered to tab `id`: every *other* tab's live
  // connection, de-duplicated by `user@host:port` so a server appears once.
  const reusableFor = useCallback(
    (id: number): ReusableConnection[] =>
      reusableConnectionsExcluding(connections, id),
    [connections],
  );

  const addSession = useCallback(() => {
    const id = nextIdRef.current++;
    setIds((prev) => [...prev, id]);
    setActiveId(id);
  }, []);

  const doClose = useCallback((id: number) => {
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
    setConnections((prev) => {
      if (!(id in prev)) return prev;
      const rest = { ...prev };
      delete rest[id];
      return rest;
    });
    setPendingInitial((prev) => {
      if (!(id in prev)) return prev;
      const rest = { ...prev };
      delete rest[id];
      return rest;
    });
  }, []);

  // #85: closing a tab with an open editor or an in-flight transfer confirms
  // first, so unsaved edits / interrupted transfers aren't lost silently.
  const closeSession = useCallback(
    (id: number) => {
      if (metas[id]?.busy) {
        const label = names[id] ?? metas[id]?.label ?? "this session";
        setDialog({
          title: "Close this session?",
          message: `"${label}" has an open editor or a transfer in progress. Closing it will interrupt that work.`,
          confirmLabel: "Close anyway",
          danger: true,
          onConfirm: () => doClose(id),
        });
        return;
      }
      doClose(id);
    },
    [metas, names, doClose],
  );

  // Persist the tab strip (identity only, no secrets) whenever it changes (#25).
  // Skipped until the post-hydration restore has run (above), so it can't write
  // the default state over saved tabs on first mount.
  useEffect(() => {
    if (!hydrated) return;
    const tabs: PersistedTab[] = ids.map((id) => {
      const conn = connections[id];
      const seed = pendingInitial[id];
      let connect;
      if (conn && conn.host && conn.username) {
        connect = {
          host: conn.host,
          port: String(conn.port),
          username: conn.username,
          auth: (conn.privateKey ? "key" : "password") as "key" | "password",
        };
      } else if (seed?.host && seed?.username) {
        connect = {
          host: seed.host,
          port: seed.port ?? "22",
          username: seed.username,
          auth: (seed.auth === "key" ? "key" : "password") as
            "key" | "password",
        };
      }
      return { name: names[id], connect };
    });
    try {
      localStorage.setItem(OPEN_TABS_KEY, serializeOpenTabs(tabs));
    } catch {
      /* storage unavailable (private mode) — tabs just won't persist */
    }
  }, [hydrated, ids, names, connections, pendingInitial]);

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
              reusableConnections={reusableFor(id)}
              onConnectionChange={(details) => reportConnection(id, details)}
              initialConnect={pendingInitial[id]}
            />
          </div>
        ))}
      </div>

      {dialog && (
        <PromptDialog request={dialog} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}
