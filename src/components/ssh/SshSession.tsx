"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyKeyModifiers,
  compareHostKey,
  encodeMessage,
  hostKeyId,
  imageMimeType,
  joinPath,
  modeToOctal,
  parseMessage,
  parseOctalMode,
  type FileEntry,
  type ServerMessage,
} from "@/lib/sshProtocol";
import { getThemePreset } from "@/lib/terminalTheme";
import { SITE_NAME, SSH_WS_PATH } from "@/config/siteConfig";
import { cn } from "@/lib/utils";
import { XtermView, type XtermHandle } from "./XtermView";
import { ConnectForm, type ConnectDetails } from "./ConnectForm";
import { FileBrowser, type UploadItem } from "./FileBrowser";
import { FileEditor } from "./FileEditor";
import { FilePreview } from "./FilePreview";
import { PasteConfirm } from "./PasteConfirm";
import { MobileKeys } from "./MobileKeys";
import { TerminalSettings } from "./TerminalSettings";
import { useTerminalPrefs } from "./useTerminalPrefs";
import { AuthPromptModal, type AuthPromptState } from "./AuthPrompt";

/** Upload chunk size; each chunk is one `sftp-write` message (drives progress). */
const UPLOAD_CHUNK = 256 * 1024;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An open file in the inline editor. */
interface EditorState {
  path: string;
  name: string;
  content: string;
}

/** An image open in the preview modal. */
interface PreviewState {
  path: string;
  name: string;
  /** `data:` URL for the <img>. */
  src: string;
  /** Raw bytes, kept so "Download" doesn't need a second round-trip. */
  bytes: Uint8Array<ArrayBuffer>;
}

/** Lifecycle phase of a single SSH session. */
export type SessionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "dropped"
  | "error";

/** What a session reports up to the tab manager for its tab chip. */
export interface SessionMeta {
  label: string;
  status: SessionStatus;
}

type Tab = "terminal" | "files";

/** How many times to auto-reconnect a dropped session before giving up. */
const MAX_RECONNECT = 3;

/** localStorage key holding the trusted host-key fingerprints (TOFU store). */
const KNOWN_HOSTS_KEY = "sshweb.knownHosts";

/** Read the `host:port → fingerprint` map of trusted host keys. */
function loadKnownHosts(): Record<string, string> {
  try {
    const raw = localStorage.getItem(KNOWN_HOSTS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Remember (or update) the trusted fingerprint for a host. */
function saveKnownHost(id: string, fingerprint: string) {
  try {
    const hosts = loadKnownHosts();
    hosts[id] = fingerprint;
    localStorage.setItem(KNOWN_HOSTS_KEY, JSON.stringify(hosts));
  } catch {
    /* storage unavailable (private mode) — verification just won't persist */
  }
}

/** Decode a base64 string to raw bytes for writing into xterm. */
function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const buffer = new ArrayBuffer(bin.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Encode raw bytes to base64 in chunks (avoids call-stack limits on big files). */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Kick off a browser download of some bytes. */
function triggerDownload(name: string, bytes: Uint8Array<ArrayBuffer>) {
  const url = URL.createObjectURL(new Blob([bytes]));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * A single SSH session: owns one WebSocket to the bridge and the three pieces of
 * UI (connect form, xterm terminal, SFTP browser). Multiple of these run side by
 * side under the `SshClient` tab manager, so the terminal stays mounted even when
 * this session isn't the active tab (`active` toggles visibility, not mounting).
 *
 * If a live connection drops unexpectedly it auto-reconnects (a few times, with
 * backoff) using the credentials from the last connect, then offers a manual
 * "Reconnect" button.
 */
export function SshSession({
  active,
  onMeta,
}: {
  active: boolean;
  onMeta: (meta: SessionMeta) => void;
}) {
  const wsRef = useRef<WebSocket | null>(null);
  const xtermRef = useRef<XtermHandle>(null);

  const [status, setStatus] = useState<SessionStatus>("idle");
  const [statusMessage, setStatusMessage] = useState("");
  const [target, setTarget] = useState<{ user: string; host: string } | null>(
    null,
  );
  const [tab, setTab] = useState<Tab>("terminal");

  const [cwd, setCwd] = useState("~");
  // Mirror of cwd for the ws message handler, whose closure would otherwise go
  // stale (it's bound once when the socket opens).
  const cwdRef = useRef("~");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [authPrompt, setAuthPrompt] = useState<AuthPromptState | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [editorSaving, setEditorSaving] = useState(false);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [uploads, setUploads] = useState<Record<string, UploadItem>>({});
  const editorSaveTextRef = useRef("");

  // Round-trip latency (ms) to the SSH bridge, sampled while connected.
  const [latency, setLatency] = useState<number | null>(null);
  // A pending multi-line paste awaiting user confirmation before it runs.
  const [pastePending, setPastePending] = useState<string | null>(null);

  // Terminal appearance (font size + color theme), shared across all sessions.
  const [termPrefs, updateTermPrefs] = useTerminalPrefs();

  // Sticky on-screen modifiers (mobile key bar). State drives the button
  // highlight; refs let the terminal's own input handler read them synchronously.
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const [altArmed, setAltArmed] = useState(false);
  const ctrlRef = useRef(false);
  const altRef = useRef(false);
  // Whether we hold credentials from a prior connect (drives the Reconnect UI);
  // mirrors lastDetailsRef but is render-safe.
  const [hasLast, setHasLast] = useState(false);

  // Reconnection bookkeeping (refs so the ws close handler sees fresh values).
  const lastDetailsRef = useRef<ConnectDetails | null>(null);
  const userClosedRef = useRef(false);
  const wasConnectedRef = useRef(false);
  const reconnectingRef = useRef(false);
  const attemptRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);

  const send = useCallback((msg: Parameters<typeof encodeMessage>[0]) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(encodeMessage(msg));
  }, []);

  const listDir = useCallback(
    (path: string) => {
      setFilesLoading(true);
      send({ t: "sftp-list", path });
    },
    [send],
  );

  const handleServerMessage = useCallback(
    (msg: ServerMessage) => {
      switch (msg.t) {
        case "status":
          if (msg.state === "connected") {
            wasConnectedRef.current = true;
            reconnectingRef.current = false;
            attemptRef.current = 0;
            setStatus("connected");
            setStatusMessage("");
            xtermRef.current?.writeln(
              "\x1b[32m✓ Connected.\x1b[0m Type as you would in any shell.",
            );
            listDir(".");
          } else if (msg.state === "closed") {
            setStatusMessage(msg.message || "Connection closed.");
          } else if (msg.state === "error") {
            setStatusMessage(msg.message || "Connection error.");
          }
          break;

        case "data":
          xtermRef.current?.write(base64ToBytes(msg.data));
          break;

        case "pong":
          setLatency(Math.max(0, Date.now() - msg.ts));
          break;

        case "hostkey": {
          const id = hostKeyId(msg.host, msg.port);
          const verdict = compareHostKey(loadKnownHosts()[id], msg.fingerprint);
          if (verdict === "match") {
            send({ t: "hostkey-response", accept: true });
          } else {
            setAuthPrompt({
              kind: "hostkey",
              host: msg.host,
              port: msg.port,
              fingerprint: msg.fingerprint,
              keyType: msg.keyType,
              verdict,
            });
          }
          break;
        }

        case "kbd-interactive":
          setAuthPrompt({
            kind: "kbd",
            name: msg.name,
            instructions: msg.instructions,
            prompts: msg.prompts,
          });
          break;

        case "sftp-list":
          cwdRef.current = msg.path;
          setCwd(msg.path);
          setEntries(msg.entries);
          setFilesLoading(false);
          break;

        case "sftp-read":
          if (msg.edit) {
            const text = new TextDecoder().decode(base64ToBytes(msg.dataB64));
            setEditor({ path: msg.path, name: msg.name, content: text });
          } else if (msg.preview) {
            const bytes = base64ToBytes(msg.dataB64);
            const mime = imageMimeType(msg.name) ?? "application/octet-stream";
            setPreview({
              path: msg.path,
              name: msg.name,
              src: `data:${mime};base64,${msg.dataB64}`,
              bytes,
            });
          } else {
            triggerDownload(msg.name, base64ToBytes(msg.dataB64));
          }
          break;

        case "sftp-ok":
          if (msg.op === "write") {
            setUploads((u) => {
              const rest = { ...u };
              delete rest[msg.path];
              return rest;
            });
            setEditorSaving(false);
            setEditor((ed) =>
              ed && ed.path === msg.path
                ? { ...ed, content: editorSaveTextRef.current }
                : ed,
            );
          }
          listDir(cwdRef.current);
          break;

        case "error":
          if (msg.scope === "sftp") {
            setFilesLoading(false);
            setStatusMessage(`SFTP: ${msg.message}`);
          } else {
            xtermRef.current?.writeln(`\x1b[31m✗ ${msg.message}\x1b[0m`);
            setStatusMessage(msg.message);
          }
          break;
      }
    },
    [listDir, send],
  );

  // openSocket and scheduleReconnect reference each other; a ref breaks the
  // cycle (openSocket calls scheduleReconnect directly; scheduleReconnect calls
  // the latest openSocket via the ref).
  const openSocketRef = useRef<((details: ConnectDetails) => void) | null>(null);

  const scheduleReconnect = useCallback(() => {
    const next = attemptRef.current + 1;
    if (next > MAX_RECONNECT || !lastDetailsRef.current) {
      reconnectingRef.current = false;
      setStatus("dropped");
      setStatusMessage("Connection lost.");
      return;
    }
    attemptRef.current = next;
    reconnectingRef.current = true;
    setStatus("reconnecting");
    setStatusMessage(`Reconnecting… (attempt ${next}/${MAX_RECONNECT})`);
    const delay = Math.min(1000 * 2 ** (next - 1), 8000);
    reconnectTimerRef.current = window.setTimeout(() => {
      if (lastDetailsRef.current) openSocketRef.current?.(lastDetailsRef.current);
    }, delay);
  }, []);

  // Open a socket and start the handshake. Used for both the first connect and
  // each auto-reconnect attempt; `connect` (below) wraps it with fresh state.
  const openSocket = useCallback(
    (details: ConnectDetails) => {
      const scheme = window.location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(
        `${scheme}://${window.location.host}${SSH_WS_PATH}`,
      );
      wsRef.current = ws;

      ws.onopen = () => {
        const size = xtermRef.current?.fit() ?? { cols: 80, rows: 24 };
        send({
          t: "connect",
          host: details.host,
          port: details.port,
          username: details.username,
          password: details.password,
          privateKey: details.privateKey,
          passphrase: details.passphrase,
          cols: size.cols,
          rows: size.rows,
        });
      };
      ws.onmessage = (event) => {
        const msg = parseMessage<ServerMessage>(String(event.data));
        if (msg) handleServerMessage(msg);
      };
      ws.onclose = () => {
        wsRef.current = null;
        if (userClosedRef.current) return; // disconnect() owns the state
        if (wasConnectedRef.current || reconnectingRef.current) {
          // A live session dropped — try to bring it back.
          wasConnectedRef.current = false;
          scheduleReconnect();
        } else {
          // Never reached "connected" → auth/host failure; don't loop.
          setStatus("error");
        }
      };
      ws.onerror = () => {
        setStatusMessage("WebSocket error — is the SSH bridge running?");
      };
    },
    [handleServerMessage, send, scheduleReconnect],
  );

  // Keep the ref pointing at the latest openSocket for scheduleReconnect.
  useEffect(() => {
    openSocketRef.current = openSocket;
  }, [openSocket]);

  // Fresh, user-initiated connect: reset all reconnection state.
  const connect = useCallback(
    (details: ConnectDetails) => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      lastDetailsRef.current = details;
      setHasLast(true);
      userClosedRef.current = false;
      wasConnectedRef.current = false;
      reconnectingRef.current = false;
      attemptRef.current = 0;
      setStatus("connecting");
      setStatusMessage("");
      setAuthPrompt(null);
      setLatency(null);
      setTarget({ user: details.username, host: details.host });
      openSocket(details);
    },
    [openSocket],
  );

  const reconnectNow = useCallback(() => {
    if (!lastDetailsRef.current) return;
    attemptRef.current = 0;
    connect(lastDetailsRef.current);
  }, [connect]);

  const disconnect = useCallback(() => {
    userClosedRef.current = true;
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    reconnectingRef.current = false;
    send({ t: "disconnect" });
    wsRef.current?.close();
    wsRef.current = null;
    setStatus("idle");
    setTarget(null);
    setEntries([]);
    setStatusMessage("");
    setAuthPrompt(null);
    setEditor(null);
    setPreview(null);
    setPastePending(null);
    setLatency(null);
    setUploads({});
    setHasLast(false);
    ctrlRef.current = false;
    altRef.current = false;
    setCtrlArmed(false);
    setAltArmed(false);
    xtermRef.current?.clear();
  }, [send]);

  const decideHostKey = useCallback(
    (accept: boolean) => {
      if (accept && authPrompt?.kind === "hostkey") {
        saveKnownHost(
          hostKeyId(authPrompt.host, authPrompt.port),
          authPrompt.fingerprint,
        );
      }
      setAuthPrompt(null);
      send({ t: "hostkey-response", accept });
    },
    [authPrompt, send],
  );

  const submitKbd = useCallback(
    (responses: string[]) => {
      setAuthPrompt(null);
      send({ t: "kbd-response", responses });
    },
    [send],
  );

  // Tear down on unmount (session closed): stop reconnecting, drop the socket.
  useEffect(
    () => () => {
      userClosedRef.current = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
    },
    [],
  );

  const connected = status === "connected";

  // Report label + status to the tab manager whenever they change.
  useEffect(() => {
    onMeta({
      label: target ? `${target.user}@${target.host}` : "New session",
      status,
    });
  }, [target, status, onMeta]);

  // Refit the terminal when this session becomes active or its tab shows it
  // (a hidden xterm measures 0, so it needs a refit + resize on reveal).
  useEffect(() => {
    if (active && tab === "terminal" && connected) {
      const size = xtermRef.current?.fit();
      if (size) send({ t: "resize", cols: size.cols, rows: size.rows });
    }
  }, [active, tab, connected, send]);

  // Sample round-trip latency while connected (one probe now, then every 5s).
  // The chip is hidden whenever not connected, and disconnect()/reconnect reset
  // the value, so there's no stale read-out to clear here.
  useEffect(() => {
    if (!connected) return;
    send({ t: "ping", ts: Date.now() });
    const id = window.setInterval(
      () => send({ t: "ping", ts: Date.now() }),
      5000,
    );
    return () => window.clearInterval(id);
  }, [connected, send]);

  const connecting = status === "connecting" || status === "reconnecting";
  const showOverlay = !connected;
  const canReconnect = (status === "dropped" || status === "error") && hasLast;

  // --- On-screen modifier keys (mobile key bar) ---
  const disarmMods = () => {
    if (ctrlRef.current) {
      ctrlRef.current = false;
      setCtrlArmed(false);
    }
    if (altRef.current) {
      altRef.current = false;
      setAltArmed(false);
    }
  };
  // Terminal input (phone keyboard or a char key): apply armed modifiers, then
  // disarm them (one-shot). A multi-line paste is held back for confirmation
  // first (each newline would run as its own command).
  const sendInput = (data: string) => {
    if (!connected) return;
    if (data.length > 1 && data.includes("\n")) {
      setPastePending(data);
      return;
    }
    const out = applyKeyModifiers(data, {
      ctrl: ctrlRef.current,
      alt: altRef.current,
    });
    disarmMods();
    send({ t: "data", data: out });
  };
  // A fixed escape sequence (arrows / Esc / Fn / undo-redo): send raw, clear mods.
  const sendSeq = (seq: string) => {
    if (!connected) return;
    disarmMods();
    send({ t: "data", data: seq });
  };
  const toggleCtrl = () => {
    const v = !ctrlRef.current;
    ctrlRef.current = v;
    setCtrlArmed(v);
  };
  const toggleAlt = () => {
    const v = !altRef.current;
    altRef.current = v;
    setAltArmed(v);
  };
  const doCopy = async () => {
    const sel = xtermRef.current?.getSelection() ?? "";
    if (!sel) return;
    try {
      await navigator.clipboard.writeText(sel);
    } catch {
      setStatusMessage("Clipboard unavailable (needs HTTPS or localhost).");
    }
  };
  const doPaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) sendInput(text);
    } catch {
      setStatusMessage("Clipboard unavailable (needs HTTPS or localhost).");
    }
  };

  // --- File browser actions ---
  const onDelete = (entry: FileEntry) => {
    if (!window.confirm(`Delete "${entry.name}"?`)) return;
    send({
      t: "sftp-rm",
      path: joinPath(cwd, entry.name),
      dir: entry.type === "dir",
    });
  };
  // Chunked upload with progress: one sftp-write per chunk, throttled by the
  // socket's buffered amount so a big file doesn't flood the connection.
  const uploadFile = async (file: File, dir: string) => {
    const path = joinPath(dir, file.name);
    const total = file.size;
    const report = (sent: number) =>
      setUploads((u) => ({ ...u, [path]: { name: file.name, sent, total } }));
    report(0);
    const buf = new Uint8Array(await file.arrayBuffer());
    const ws = wsRef.current;
    let offset = 0;
    do {
      const end = Math.min(offset + UPLOAD_CHUNK, total);
      send({
        t: "sftp-write",
        path,
        dataB64: bytesToBase64(buf.subarray(offset, end)),
        offset,
        final: end >= total,
      });
      offset = end;
      report(offset);
      while (
        ws &&
        ws.readyState === WebSocket.OPEN &&
        ws.bufferedAmount > 4 * 1024 * 1024
      ) {
        await sleep(25);
      }
    } while (offset < total);
  };
  const onMkdir = () => {
    const name = window.prompt("New directory name:");
    if (name) send({ t: "sftp-mkdir", path: joinPath(cwd, name) });
  };
  const onTouch = () => {
    const name = window.prompt("New file name:");
    const trimmed = name?.trim();
    if (trimmed) send({ t: "sftp-write", path: joinPath(cwd, trimmed), dataB64: "" });
  };
  const onRename = (entry: FileEntry) => {
    const next = window.prompt(`Rename "${entry.name}" to:`, entry.name);
    if (next && next !== entry.name) {
      send({
        t: "sftp-rename",
        from: joinPath(cwd, entry.name),
        to: joinPath(cwd, next),
      });
    }
  };
  const onChmod = (entry: FileEntry) => {
    const input = window.prompt(
      `Permissions for "${entry.name}" (octal, e.g. 644):`,
      modeToOctal(entry.mode),
    );
    if (input === null) return;
    const mode = parseOctalMode(input);
    if (mode === null) {
      setStatusMessage("Invalid mode — use 3–4 octal digits like 644.");
      return;
    }
    send({ t: "sftp-chmod", path: joinPath(cwd, entry.name), mode });
  };
  const onSaveEdit = (text: string) => {
    if (!editor) return;
    editorSaveTextRef.current = text;
    setEditorSaving(true);
    send({
      t: "sftp-write",
      path: editor.path,
      dataB64: bytesToBase64(new TextEncoder().encode(text)),
    });
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-term-border bg-term-card">
      {/* Session header */}
      <div className="flex items-center gap-3 border-b border-term-border bg-term-panel/90 px-4 py-2.5">
        <StatusDot status={status} />
        <span className="truncate text-xs text-term-dim">
          {target ? `${target.user}@${target.host}` : "Not connected"}
        </span>
        {connected && latency !== null && <LatencyChip ms={latency} />}

        {connected && (
          <div className="ml-auto flex items-center gap-1">
            {tab === "terminal" && (
              <button
                type="button"
                onClick={() => {
                  setTab("terminal");
                  xtermRef.current?.openSearch();
                }}
                className="rounded px-2 py-1 text-xs text-term-muted transition-colors hover:text-term-text"
                title="Search terminal (Ctrl+F)"
                aria-label="Search terminal"
              >
                🔍
              </button>
            )}
            <TerminalSettings prefs={termPrefs} onChange={updateTermPrefs} />
            {(["terminal", "files"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={cn(
                  "rounded px-3 py-1 text-xs capitalize transition-colors",
                  tab === t
                    ? "bg-term-accent/15 text-term-accent"
                    : "text-term-muted hover:text-term-text",
                )}
              >
                {t}
              </button>
            ))}
            <button
              type="button"
              onClick={disconnect}
              className="ml-2 rounded border border-term-red/40 px-3 py-1 text-xs text-term-red hover:bg-term-red/10"
            >
              Disconnect
            </button>
          </div>
        )}
      </div>

      {/* Body */}
      <div className="relative min-h-0 flex-1">
        <div
          className={cn(
            "absolute inset-0 flex-col bg-term-bg",
            connected && tab === "files" ? "hidden" : "flex",
          )}
        >
          <div className="min-h-0 flex-1 p-2">
            <XtermView
              ref={xtermRef}
              onData={sendInput}
              onResize={(cols, rows) =>
                connected && send({ t: "resize", cols, rows })
              }
              fontSize={termPrefs.fontSize}
              theme={getThemePreset(termPrefs.themeId).theme}
            />
          </div>
          {connected && (
            <MobileKeys
              ctrlActive={ctrlArmed}
              altActive={altArmed}
              onToggleCtrl={toggleCtrl}
              onToggleAlt={toggleAlt}
              onChar={sendInput}
              onSeq={sendSeq}
              onCopy={doCopy}
              onPaste={doPaste}
            />
          )}
        </div>

        {connected && tab === "files" && (
          <div className="absolute inset-0">
            <FileBrowser
              cwd={cwd}
              entries={entries}
              loading={filesLoading}
              uploads={Object.values(uploads)}
              onNavigate={listDir}
              onRefresh={() => listDir(cwd)}
              onDownload={(path) => send({ t: "sftp-read", path })}
              onDownloadDir={(path) => send({ t: "sftp-download-dir", path })}
              onDelete={onDelete}
              onUpload={(file) => uploadFile(file, cwd)}
              onMkdir={onMkdir}
              onTouch={onTouch}
              onRename={onRename}
              onChmod={onChmod}
              onEdit={(path) => send({ t: "sftp-read", path, edit: true })}
              onPreview={(path) => send({ t: "sftp-read", path, preview: true })}
            />
            {editor && (
              <FileEditor
                key={editor.path}
                name={editor.name}
                path={editor.path}
                content={editor.content}
                saving={editorSaving}
                onSave={onSaveEdit}
                onClose={() => setEditor(null)}
              />
            )}
            {preview && (
              <FilePreview
                key={preview.path}
                name={preview.name}
                path={preview.path}
                src={preview.src}
                onDownload={() => triggerDownload(preview.name, preview.bytes)}
                onClose={() => setPreview(null)}
              />
            )}
          </div>
        )}

        {showOverlay && (
          <div className="absolute inset-0 overflow-auto bg-term-card p-5 sm:p-8">
            <div className="mx-auto max-w-md">
              {canReconnect ? (
                <div className="flex flex-col gap-4">
                  <div>
                    <h2 className="text-lg font-semibold text-term-text">
                      {status === "dropped"
                        ? "Connection lost"
                        : "Connection failed"}
                    </h2>
                    <p className="mt-1 text-xs leading-relaxed text-term-muted">
                      {statusMessage ||
                        "The session ended. Reconnect to the same host, or start a new connection."}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={reconnectNow}
                      className="rounded-md border border-term-accent/40 bg-term-accent/15 px-4 py-2 text-sm font-medium text-term-accent hover:bg-term-accent/25"
                    >
                      Reconnect →
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        lastDetailsRef.current = null;
                        setHasLast(false);
                        setStatus("idle");
                        setStatusMessage("");
                      }}
                      className="rounded-md border border-term-border px-4 py-2 text-sm text-term-muted hover:text-term-text"
                    >
                      New connection
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="term-fade-up mb-5 flex items-center gap-3 rounded-lg border border-term-border bg-term-panel/60 px-4 py-3">
                    <span
                      className="select-none font-mono text-2xl text-term-accent"
                      aria-hidden
                    >
                      &gt;<span className="term-cursor ml-0.5 align-middle" />
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-term-text">
                        {SITE_NAME}
                      </p>
                      <p className="truncate text-xs text-term-muted">
                        SSH &amp; SFTP, right in your browser
                      </p>
                    </div>
                  </div>
                  <h2 className="text-lg font-semibold text-term-text">
                    New SSH connection
                  </h2>
                  <p className="mt-1 mb-5 text-xs leading-relaxed text-term-muted">
                    Credentials are relayed straight to the target host to open
                    the session and are never stored or logged by this site. Only
                    connect to hosts you trust.
                  </p>
                  <ConnectForm onConnect={connect} connecting={connecting} />
                  {statusMessage && (
                    <p className="mt-4 rounded-md border border-term-red/40 bg-term-red/10 px-3 py-2 text-xs text-term-red">
                      {statusMessage}
                    </p>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {pastePending !== null && (
          <PasteConfirm
            text={pastePending}
            onConfirm={() => {
              const data = pastePending;
              setPastePending(null);
              disarmMods();
              if (connected) send({ t: "data", data });
              xtermRef.current?.focus();
            }}
            onCancel={() => {
              setPastePending(null);
              xtermRef.current?.focus();
            }}
          />
        )}

        {authPrompt && (
          <AuthPromptModal
            prompt={authPrompt}
            onHostKeyDecision={decideHostKey}
            onKbdSubmit={submitKbd}
          />
        )}
      </div>
    </div>
  );
}

/** The coloured status dot shared by the header and the manager's tabs. */
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

/** A small latency read-out (ms), colour-coded green/yellow/red by round-trip. */
function LatencyChip({ ms }: { ms: number }) {
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
