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
  previewKind,
  videoMimeType,
  type FileEntry,
  type PreviewKind,
  type ServerMessage,
} from "@/lib/sshProtocol";
import { getThemePreset } from "@/lib/terminalTheme";
import {
  KNOWN_HOSTS_KEY,
  parseKnownHosts,
  serializeKnownHosts,
  type KnownHostMap,
} from "@/lib/knownHosts";
import { SITE_NAME, SSH_WS_PATH } from "@/config/siteConfig";
import { cn } from "@/lib/utils";
import { XtermView, type XtermHandle } from "./XtermView";
import { ConnectForm, type ConnectDetails } from "./ConnectForm";
import { FileBrowser, type UploadItem, type DownloadItem } from "./FileBrowser";
import { FileEditor, type EditorFile } from "./FileEditor";
import { Tunnels, type ForwardState, type NewForward } from "./Tunnels";
import { FilePreview } from "./FilePreview";
import { PasteConfirm } from "./PasteConfirm";
import { PromptDialog, type DialogRequest } from "./PromptDialog";
import { MobileKeys } from "./MobileKeys";
import { SnippetsBar } from "./SnippetsBar";
import { ShortcutsHelp } from "./ShortcutsHelp";
import { TerminalSettings } from "./TerminalSettings";
import { useTerminalPrefs } from "./useTerminalPrefs";
import { AuthPromptModal, type AuthPromptState } from "./AuthPrompt";
import { ToastStack, useToasts } from "./Toast";

/** Upload chunk size; each chunk is one `sftp-write` message (drives progress). */
const UPLOAD_CHUNK = 256 * 1024;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An image or video open in the preview modal. */
interface PreviewState {
  path: string;
  name: string;
  /** Which media surface to render (`<img>` vs `<video>`). */
  kind: PreviewKind;
  /** `data:` URL for the <img>/<video>. */
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

type Tab = "terminal" | "files" | "tunnels";

/** How many times to auto-reconnect a dropped session before giving up. */
const MAX_RECONNECT = 3;

/** Read the `host:port → fingerprint` map of trusted host keys (TOFU store). */
function loadKnownHosts(): KnownHostMap {
  try {
    return parseKnownHosts(localStorage.getItem(KNOWN_HOSTS_KEY));
  } catch {
    return {};
  }
}

/** Remember (or update) the trusted fingerprint for a host. */
function saveKnownHost(id: string, fingerprint: string) {
  try {
    const hosts = loadKnownHosts();
    hosts[id] = fingerprint;
    localStorage.setItem(KNOWN_HOSTS_KEY, serializeKnownHosts(hosts));
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

/** Concatenate a list of byte chunks into one contiguous buffer. */
function concatBytes(chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
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
  // Files open in the inline editor (tabs), plus which one is shown and which
  // (if any) is being saved right now.
  const [editors, setEditors] = useState<EditorFile[]>([]);
  const [activeEditor, setActiveEditor] = useState<string | null>(null);
  const [savingPath, setSavingPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  // Active local port-forwards, keyed by their client-generated id.
  const [forwards, setForwards] = useState<Record<string, ForwardState>>({});
  const [uploads, setUploads] = useState<Record<string, UploadItem>>({});
  const [downloads, setDownloads] = useState<Record<string, DownloadItem>>({});
  // Accumulated download chunks (bytes), keyed by remote path. A ref so pushing
  // chunks doesn't re-render; the `downloads` state above drives the progress UI.
  const downloadBuffersRef = useRef<
    Record<string, { name: string; chunks: Uint8Array[] }>
  >({});
  // Text captured at save time per path, so `sftp-ok` can reconcile the editor's
  // saved content (marking that file clean) without a re-read.
  const editorSaveTextRef = useRef<Record<string, string>>({});

  // Round-trip latency (ms) to the SSH bridge, sampled while connected.
  const [latency, setLatency] = useState<number | null>(null);
  // Epoch ms when the session first reached "connected" (drives the uptime clock).
  const [connectedAt, setConnectedAt] = useState<number | null>(null);
  // A pending multi-line paste awaiting user confirmation before it runs.
  const [pastePending, setPastePending] = useState<string | null>(null);
  // The active in-app prompt/confirm dialog (replaces window.prompt/confirm).
  const [dialog, setDialog] = useState<DialogRequest | null>(null);
  // Whether the keyboard-shortcuts cheat sheet is open.
  const [showShortcuts, setShowShortcuts] = useState(false);

  // Transient error/notice toasts (surface failures that would otherwise leave
  // the UI silent — e.g. an over-cap upload or download the bridge rejects).
  const { toasts, notify, dismiss } = useToasts();
  // Render-safe mirror of "am I connected?" for the ws message handler, whose
  // closure can't read the `connected` derived value directly.
  const connectedRef = useRef(false);

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
            setConnectedAt((at) => at ?? Date.now());
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
            setEditors((prev) =>
              prev.some((e) => e.path === msg.path)
                ? prev // already open — just focus it (don't clobber edits)
                : [...prev, { path: msg.path, name: msg.name, content: text }],
            );
            setActiveEditor(msg.path);
          } else if (msg.preview) {
            const bytes = base64ToBytes(msg.dataB64);
            const kind = previewKind(msg.name) ?? "image";
            const mime =
              (kind === "video"
                ? videoMimeType(msg.name)
                : imageMimeType(msg.name)) ?? "application/octet-stream";
            setPreview({
              path: msg.path,
              name: msg.name,
              kind,
              src: `data:${mime};base64,${msg.dataB64}`,
              bytes,
            });
          } else {
            triggerDownload(msg.name, base64ToBytes(msg.dataB64));
          }
          break;

        case "sftp-download-begin":
          downloadBuffersRef.current[msg.path] = { name: msg.name, chunks: [] };
          setDownloads((d) => ({
            ...d,
            [msg.path]: { name: msg.name, received: 0, total: msg.size },
          }));
          break;

        case "sftp-download-chunk": {
          const buf = downloadBuffersRef.current[msg.path];
          if (!buf) break;
          const bytes = base64ToBytes(msg.dataB64);
          buf.chunks.push(bytes);
          setDownloads((d) => {
            const cur = d[msg.path];
            if (!cur) return d;
            return {
              ...d,
              [msg.path]: { ...cur, received: cur.received + bytes.length },
            };
          });
          break;
        }

        case "sftp-download-end": {
          const buf = downloadBuffersRef.current[msg.path];
          delete downloadBuffersRef.current[msg.path];
          setDownloads((d) => {
            const rest = { ...d };
            delete rest[msg.path];
            return rest;
          });
          if (buf) triggerDownload(buf.name, concatBytes(buf.chunks));
          break;
        }

        case "sftp-ok":
          if (msg.op === "write") {
            setUploads((u) => {
              const rest = { ...u };
              delete rest[msg.path];
              return rest;
            });
            setSavingPath((cur) => (cur === msg.path ? null : cur));
            const saved = editorSaveTextRef.current[msg.path];
            if (saved !== undefined) {
              setEditors((prev) =>
                prev.map((e) =>
                  e.path === msg.path ? { ...e, content: saved } : e,
                ),
              );
              delete editorSaveTextRef.current[msg.path];
            }
          }
          listDir(cwdRef.current);
          break;

        case "forward-opened":
          setForwards((f) => ({
            ...f,
            [msg.id]: {
              id: msg.id,
              bindHost: msg.bindHost,
              bindPort: msg.bindPort,
              destHost: msg.destHost,
              destPort: msg.destPort,
              status: "open",
              conns: f[msg.id]?.conns ?? 0,
            },
          }));
          break;

        case "forward-closed":
          setForwards((f) => {
            const rest = { ...f };
            delete rest[msg.id];
            return rest;
          });
          break;

        case "forward-error":
          notify("error", `Port forward failed: ${msg.message}`);
          setForwards((f) => {
            const cur = f[msg.id];
            if (!cur) return f; // error for a forward we already dropped
            return {
              ...f,
              [msg.id]: { ...cur, status: "error", error: msg.message },
            };
          });
          break;

        case "forward-conn":
          setForwards((f) => {
            const cur = f[msg.id];
            if (!cur) return f;
            return { ...f, [msg.id]: { ...cur, conns: msg.count } };
          });
          break;

        case "error":
          if (msg.scope === "sftp") {
            // SFTP errors only happen while connected, where the overlay's
            // status text is hidden — a toast is the only visible channel.
            // Clear any in-flight spinners so a failed list/save doesn't hang.
            setFilesLoading(false);
            setSavingPath(null);
            notify("error", msg.message);
          } else {
            // Shell/auth errors: echo into the terminal, and while connected
            // also toast so the user sees it even away from the terminal tab.
            // Before connecting, the overlay shows the status text instead.
            xtermRef.current?.writeln(`\x1b[31m✗ ${msg.message}\x1b[0m`);
            if (connectedRef.current) notify("error", msg.message);
            else setStatusMessage(msg.message);
          }
          break;
      }
    },
    [listDir, send, notify],
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
      setConnectedAt(null);
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
    setEditors([]);
    setActiveEditor(null);
    setSavingPath(null);
    editorSaveTextRef.current = {};
    setForwards({});
    setPreview(null);
    setPastePending(null);
    setDialog(null);
    setShowShortcuts(false);
    setLatency(null);
    setConnectedAt(null);
    setUploads({});
    setDownloads({});
    downloadBuffersRef.current = {};
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

  // Mirror `connected` into a ref the ws message handler can read synchronously.
  useEffect(() => {
    connectedRef.current = connected;
  }, [connected]);

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
      notify("error", "Clipboard unavailable (needs HTTPS or localhost).");
    }
  };
  const doPaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) sendInput(text);
    } catch {
      notify("error", "Clipboard unavailable (needs HTTPS or localhost).");
    }
  };

  // Inject a saved snippet's command into the shell (no trailing newline — the
  // user reviews and presses Enter, matching the paste-confirm posture).
  const runSnippet = (command: string) => {
    if (!connected) return;
    disarmMods();
    send({ t: "data", data: command });
    xtermRef.current?.focus();
  };

  // --- File browser actions (in-app dialogs, not window.prompt/confirm) ---
  const onDelete = (entry: FileEntry) => {
    setDialog({
      title: `Delete “${entry.name}”?`,
      message:
        entry.type === "dir"
          ? "The directory must be empty. This cannot be undone."
          : "This cannot be undone.",
      confirmLabel: "Delete",
      danger: true,
      onConfirm: () =>
        send({
          t: "sftp-rm",
          path: joinPath(cwd, entry.name),
          dir: entry.type === "dir",
        }),
    });
  };
  // Bulk delete: one confirm for the whole selection, then a `sftp-rm` per
  // entry (same per-item semantics as a single delete — directories must be
  // empty). Each ok refreshes the listing, which prunes the selection.
  const onDeleteMany = (items: FileEntry[]) => {
    if (items.length === 0) return;
    const hasDir = items.some((e) => e.type === "dir");
    setDialog({
      title: `Delete ${items.length} item${items.length > 1 ? "s" : ""}?`,
      message: hasDir
        ? "Selected directories must be empty. This cannot be undone."
        : "This cannot be undone.",
      confirmLabel: "Delete",
      danger: true,
      onConfirm: () => {
        for (const entry of items) {
          send({
            t: "sftp-rm",
            path: joinPath(cwd, entry.name),
            dir: entry.type === "dir",
          });
        }
      },
    });
  };
  // Chunked upload with progress: one sftp-write per chunk, throttled by the
  // socket's buffered amount so a big file doesn't flood the connection. A
  // `relPath` (folder upload) preserves subdirectories; the opening chunk asks
  // the server to `mkdir -p` the parents.
  const uploadFile = async (file: File, dir: string, relPath?: string) => {
    const rel = relPath && relPath.trim() !== "" ? relPath : file.name;
    const path = joinPath(dir, rel);
    const needsDir = rel.includes("/");
    const total = file.size;
    const report = (sent: number) =>
      setUploads((u) => ({ ...u, [path]: { name: rel, sent, total } }));
    const clearUpload = () =>
      setUploads((u) => {
        const rest = { ...u };
        delete rest[path];
        return rest;
      });
    report(0);
    try {
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
          // Only the opening chunk carries the mkdirp request (that's when the
          // server opens the write stream and can create the parents first).
          mkdirp: offset === 0 && needsDir ? true : undefined,
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
    } catch {
      // Reading the local file failed — drop the stuck progress row and tell
      // the user (a server-side reject arrives separately as an sftp error).
      clearUpload();
      notify("error", `Upload failed: ${rel}`);
    }
  };
  const onMkdir = () => {
    setDialog({
      title: "New directory",
      input: { label: "Directory name", placeholder: "e.g. logs" },
      confirmLabel: "Create",
      validate: (v) => (v.trim() ? null : "Please enter a name."),
      onConfirm: (v) => send({ t: "sftp-mkdir", path: joinPath(cwd, v.trim()) }),
    });
  };
  const onTouch = () => {
    setDialog({
      title: "New file",
      input: { label: "File name", placeholder: "e.g. notes.txt" },
      confirmLabel: "Create",
      validate: (v) => (v.trim() ? null : "Please enter a name."),
      onConfirm: (v) =>
        send({ t: "sftp-write", path: joinPath(cwd, v.trim()), dataB64: "" }),
    });
  };
  const onRename = (entry: FileEntry) => {
    setDialog({
      title: `Rename “${entry.name}”`,
      input: { label: "New name", initialValue: entry.name },
      confirmLabel: "Rename",
      validate: (v) => (v.trim() ? null : "Please enter a name."),
      onConfirm: (v) => {
        const next = v.trim();
        if (next && next !== entry.name) {
          send({
            t: "sftp-rename",
            from: joinPath(cwd, entry.name),
            to: joinPath(cwd, next),
          });
        }
      },
    });
  };
  const onChmod = (entry: FileEntry) => {
    setDialog({
      title: `Permissions for “${entry.name}”`,
      input: { label: "Octal mode (e.g. 644)", initialValue: modeToOctal(entry.mode) },
      confirmLabel: "Apply",
      validate: (v) =>
        parseOctalMode(v) === null ? "Use 3–4 octal digits like 644." : null,
      onConfirm: (v) => {
        const mode = parseOctalMode(v);
        if (mode !== null) {
          send({ t: "sftp-chmod", path: joinPath(cwd, entry.name), mode });
        }
      },
    });
  };
  const onSaveEdit = (path: string, text: string) => {
    editorSaveTextRef.current[path] = text;
    setSavingPath(path);
    send({
      t: "sftp-write",
      path,
      dataB64: bytesToBase64(new TextEncoder().encode(text)),
    });
  };
  // Close one editor tab; if it was active, fall back to the last remaining file.
  const closeEditorFile = (path: string) => {
    const remaining = editors.filter((e) => e.path !== path);
    setEditors(remaining);
    setActiveEditor((cur) =>
      cur !== path ? cur : remaining.length ? remaining[remaining.length - 1].path : null,
    );
  };
  const closeAllEditors = () => {
    setEditors([]);
    setActiveEditor(null);
  };

  // --- Port-forward actions ---
  const openForward = (nf: NewForward) => {
    const id =
      globalThis.crypto?.randomUUID?.() ??
      `fwd-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    // Optimistic "opening" entry so the tunnel shows immediately; forward-opened
    // / forward-error will resolve its status.
    setForwards((f) => ({
      ...f,
      [id]: { id, ...nf, status: "opening", conns: 0 },
    }));
    send({ t: "forward-open", id, ...nf });
  };
  const closeForward = (id: string) => {
    send({ t: "forward-close", id });
    setForwards((f) => {
      const rest = { ...f };
      delete rest[id];
      return rest;
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
        {connected && connectedAt !== null && <Uptime since={connectedAt} />}
        {connected && latency !== null && <LatencyChip ms={latency} />}

        {connected && (
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => setShowShortcuts(true)}
              className="rounded px-2 py-1 text-xs text-term-muted transition-colors hover:text-term-text"
              title="Keyboard shortcuts"
              aria-label="Keyboard shortcuts"
            >
              ?
            </button>
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
            {(["terminal", "files", "tunnels"] as const).map((t) => (
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
            connected && tab !== "terminal" ? "hidden" : "flex",
          )}
        >
          <div className="min-h-0 flex-1 p-2">
            <XtermView
              ref={xtermRef}
              onData={sendInput}
              onResize={(cols, rows) =>
                connected && send({ t: "resize", cols, rows })
              }
              theme={getThemePreset(termPrefs.themeId).theme}
            />
          </div>
          {connected && <SnippetsBar onRun={runSnippet} />}
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
              downloads={Object.values(downloads)}
              onNavigate={listDir}
              onRefresh={() => listDir(cwd)}
              onDownload={(path) => send({ t: "sftp-read", path })}
              onDownloadDir={(path) => send({ t: "sftp-download-dir", path })}
              onDownloadMany={(paths) => send({ t: "sftp-download-many", paths })}
              onDelete={onDelete}
              onDeleteMany={onDeleteMany}
              onUpload={(file, relPath) => uploadFile(file, cwd, relPath)}
              onMkdir={onMkdir}
              onTouch={onTouch}
              onRename={onRename}
              onChmod={onChmod}
              onEdit={(path) => send({ t: "sftp-read", path, edit: true })}
              onPreview={(path) => send({ t: "sftp-read", path, preview: true })}
            />
            {preview && (
              <FilePreview
                key={preview.path}
                name={preview.name}
                path={preview.path}
                src={preview.src}
                kind={preview.kind}
                onDownload={() => triggerDownload(preview.name, preview.bytes)}
                onClose={() => setPreview(null)}
              />
            )}
          </div>
        )}

        {connected && tab === "tunnels" && (
          <div className="absolute inset-0 bg-term-bg">
            <Tunnels
              forwards={Object.values(forwards)}
              onOpen={openForward}
              onClose={closeForward}
            />
          </div>
        )}

        {/* Inline editor overlays every tab so switching tabs keeps unsaved
            buffers alive; it's only populated while connected. */}
        {activeEditor && editors.length > 0 && (
          <FileEditor
            files={editors}
            activePath={activeEditor}
            savingPath={savingPath}
            onSave={onSaveEdit}
            onSelect={setActiveEditor}
            onCloseFile={closeEditorFile}
            onCloseAll={closeAllEditors}
          />
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

        {dialog && (
          <PromptDialog request={dialog} onClose={() => setDialog(null)} />
        )}

        {showShortcuts && (
          <ShortcutsHelp onClose={() => setShowShortcuts(false)} />
        )}

        {authPrompt && (
          <AuthPromptModal
            prompt={authPrompt}
            onHostKeyDecision={decideHostKey}
            onKbdSubmit={submitKbd}
          />
        )}

        {/* Transient notifications — sit above every tab and modal so a failed
            action is always visible, even with the editor or a dialog open. */}
        <ToastStack toasts={toasts} onDismiss={dismiss} />
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

/** Live "connected for" clock, ticking once a second (mm:ss, or h:mm:ss). */
function Uptime({ since }: { since: number }) {
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
