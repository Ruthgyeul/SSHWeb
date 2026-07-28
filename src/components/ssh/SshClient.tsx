"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  encodeMessage,
  joinPath,
  parseMessage,
  type FileEntry,
  type ServerMessage,
} from "@/lib/sshProtocol";
import { SSH_WS_PATH } from "@/config/siteConfig";
import { cn } from "@/lib/utils";
import { XtermView, type XtermHandle } from "./XtermView";
import { ConnectForm, type ConnectDetails } from "./ConnectForm";
import { FileBrowser } from "./FileBrowser";

type Status = "idle" | "connecting" | "connected" | "error" | "closed";
type Tab = "terminal" | "files";

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
 * Top-level web SSH client. Owns the single WebSocket to the server-side bridge
 * and coordinates the three pieces of UI: the connection form, the xterm.js
 * terminal, and the SFTP file browser. The connect form is shown as an overlay
 * so the terminal stays mounted underneath and its size is known the moment the
 * socket opens.
 */
export function SshClient() {
  const wsRef = useRef<WebSocket | null>(null);
  const xtermRef = useRef<XtermHandle>(null);

  const [status, setStatus] = useState<Status>("idle");
  const [statusMessage, setStatusMessage] = useState("");
  const [target, setTarget] = useState<{ user: string; host: string } | null>(
    null,
  );
  const [tab, setTab] = useState<Tab>("terminal");

  const [cwd, setCwd] = useState("~");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);

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
            setStatus("connected");
            xtermRef.current?.writeln(
              "\x1b[32m✓ Connected.\x1b[0m Type as you would in any shell.",
            );
            listDir(".");
          } else if (msg.state === "closed") {
            setStatus("closed");
            setStatusMessage(msg.message || "Connection closed.");
          } else if (msg.state === "error") {
            setStatus("error");
            setStatusMessage(msg.message || "Connection error.");
          }
          break;

        case "data":
          xtermRef.current?.write(base64ToBytes(msg.data));
          break;

        case "sftp-list":
          setCwd(msg.path);
          setEntries(msg.entries);
          setFilesLoading(false);
          break;

        case "sftp-read":
          triggerDownload(msg.name, base64ToBytes(msg.dataB64));
          break;

        case "sftp-ok":
          // A mutating op succeeded — refresh the current directory.
          listDir(cwd);
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
    [cwd, listDir],
  );

  const connect = useCallback(
    (details: ConnectDetails) => {
      setStatus("connecting");
      setStatusMessage("");
      setTarget({ user: details.username, host: details.host });

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
        setStatus((s) => (s === "connecting" ? "error" : "closed"));
      };
      ws.onerror = () => {
        setStatusMessage("WebSocket error — is the SSH bridge running?");
      };
    },
    [handleServerMessage, send],
  );

  const disconnect = useCallback(() => {
    send({ t: "disconnect" });
    wsRef.current?.close();
    wsRef.current = null;
    setStatus("idle");
    setTarget(null);
    setEntries([]);
    setStatusMessage("");
    xtermRef.current?.clear();
  }, [send]);

  // Close the socket if the component unmounts mid-session.
  useEffect(() => () => wsRef.current?.close(), []);

  // Refit the terminal whenever we switch back to its tab (it may have been
  // display:none, which zeroes xterm's measured size).
  useEffect(() => {
    if (tab === "terminal" && status === "connected") {
      const size = xtermRef.current?.fit();
      if (size) send({ t: "resize", cols: size.cols, rows: size.rows });
    }
  }, [tab, status, send]);

  const connected = status === "connected";
  const connecting = status === "connecting";
  const showOverlay = !connected;

  // --- File browser actions (delegated from FileBrowser) ---
  const onDelete = (entry: FileEntry) => {
    if (!window.confirm(`Delete "${entry.name}"?`)) return;
    send({
      t: "sftp-rm",
      path: joinPath(cwd, entry.name),
      dir: entry.type === "dir",
    });
  };
  const onUpload = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const bytes = new Uint8Array(reader.result as ArrayBuffer);
      send({
        t: "sftp-write",
        path: joinPath(cwd, file.name),
        dataB64: bytesToBase64(bytes),
      });
    };
    reader.readAsArrayBuffer(file);
  };
  const onMkdir = () => {
    const name = window.prompt("New directory name:");
    if (name) send({ t: "sftp-mkdir", path: joinPath(cwd, name) });
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-term-border bg-term-card">
      {/* Session header */}
      <div className="flex items-center gap-3 border-b border-term-border bg-term-panel/90 px-4 py-2.5">
        <span
          className={cn(
            "h-2.5 w-2.5 rounded-full",
            connected
              ? "bg-term-green"
              : status === "error"
                ? "bg-term-red"
                : status === "connecting"
                  ? "bg-term-yellow"
                  : "bg-term-fainter",
          )}
          aria-hidden
        />
        <span className="truncate text-xs text-term-dim">
          {target ? `${target.user}@${target.host}` : "Not connected"}
        </span>

        {connected && (
          <div className="ml-auto flex items-center gap-1">
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
        {/* Terminal — always mounted so its handle/size are ready on connect. */}
        <div
          className={cn(
            "absolute inset-0 bg-term-bg p-2",
            connected && tab === "terminal" ? "block" : "hidden",
          )}
        >
          <XtermView
            onData={(data) => connected && send({ t: "data", data })}
            onResize={(cols, rows) =>
              connected && send({ t: "resize", cols, rows })
            }
          />
        </div>

        {/* File browser */}
        {connected && tab === "files" && (
          <div className="absolute inset-0">
            <FileBrowser
              cwd={cwd}
              entries={entries}
              loading={filesLoading}
              onNavigate={listDir}
              onRefresh={() => listDir(cwd)}
              onDownload={(path) => send({ t: "sftp-read", path })}
              onDelete={onDelete}
              onUpload={onUpload}
              onMkdir={onMkdir}
            />
          </div>
        )}

        {/* Connection overlay */}
        {showOverlay && (
          <div className="absolute inset-0 overflow-auto bg-term-card p-5 sm:p-8">
            <div className="mx-auto max-w-md">
              <h2 className="text-lg font-semibold text-term-text">
                New SSH connection
              </h2>
              <p className="mt-1 mb-5 text-xs leading-relaxed text-term-muted">
                Credentials are relayed straight to the target host to open the
                session and are never stored or logged by this site. Only
                connect to hosts you trust.
              </p>
              <ConnectForm onConnect={connect} connecting={connecting} />
              {statusMessage && (
                <p className="mt-4 rounded-md border border-term-red/40 bg-term-red/10 px-3 py-2 text-xs text-term-red">
                  {statusMessage}
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
