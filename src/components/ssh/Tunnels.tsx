"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import {
  forwardLabel,
  validateForward,
  type ForwardKind,
} from "@/lib/sshProtocol";

/** A port-forward as tracked by the session (mirrors the wire messages). */
export interface ForwardState {
  id: string;
  kind: ForwardKind;
  bindHost: string;
  bindPort: number;
  destHost: string;
  destPort: number;
  status: "opening" | "open" | "error" | "closed";
  /** Live count of connections tunnelled through this forward. */
  conns: number;
  error?: string;
}

/** What the add-form hands back when the user opens a new forward. */
export interface NewForward {
  kind: ForwardKind;
  bindHost: string;
  bindPort: number;
  destHost: string;
  destPort: number;
}

/** Per-kind copy for the tunnels form. */
const KIND_META: Record<
  ForwardKind,
  { label: string; blurb: string; portLabel: string }
> = {
  local: {
    label: "Local",
    blurb:
      "Forward a local port to a host reachable from the SSH server (ssh -L).",
    portLabel: "Local port",
  },
  remote: {
    label: "Remote",
    blurb:
      "Expose a local-reachable host on a port of the SSH server (ssh -R).",
    portLabel: "Remote port",
  },
  dynamic: {
    label: "Dynamic",
    blurb:
      "Run a SOCKS5 proxy on a local port, routed through the SSH server (ssh -D).",
    portLabel: "Local port",
  },
};

/**
 * The "tunnels" tab: open and manage local port-forwards (`ssh -L`). The bridge
 * listens on `localhost:<local port>` and tunnels each connection to
 * `<dest host>:<dest port>` reached from the *SSH server's* network — handy when
 * you run SSHWeb on your own machine and want to reach a remote-only service
 * (a database, an internal dashboard) with your local tools.
 *
 * Forwarding is off unless the server sets `SSH_ALLOW_PORT_FORWARD=true`; when it
 * is disabled the attempt comes back as an error on the forward, shown inline.
 */
export function Tunnels({
  forwards,
  onOpen,
  onClose,
}: {
  forwards: ForwardState[];
  onOpen: (f: NewForward) => void;
  onClose: (id: string) => void;
}) {
  const [kind, setKind] = useState<ForwardKind>("local");
  const [bindPort, setBindPort] = useState("");
  const [destHost, setDestHost] = useState("");
  const [destPort, setDestPort] = useState("");
  const [bindHost, setBindHost] = useState("127.0.0.1");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  const meta = KIND_META[kind];
  const needsDest = kind !== "dynamic";

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const input = { kind, bindHost, bindPort, destHost, destPort };
    const errs = validateForward(input);
    setErrors(errs);
    if (errs.length > 0) return;
    onOpen({
      kind,
      bindHost: bindHost.trim() || "127.0.0.1",
      bindPort: Number(bindPort),
      destHost: needsDest ? destHost.trim() : "",
      destPort: needsDest ? Number(destPort) : 0,
    });
    setBindPort("");
    setDestHost("");
    setDestPort("");
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-auto p-4">
      <form
        onSubmit={submit}
        className="rounded-lg border border-term-border bg-term-panel/60 p-4"
      >
        {/* Direction selector */}
        <div
          className="mb-3 inline-flex overflow-hidden rounded-md border border-term-border"
          role="group"
          aria-label="Forward type"
        >
          {(["local", "remote", "dynamic"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => {
                setKind(k);
                setErrors([]);
              }}
              aria-pressed={kind === k}
              className={cn(
                "border-l border-term-border px-3 py-1 text-xs transition-colors first:border-l-0",
                kind === k
                  ? "bg-term-accent/15 text-term-accent"
                  : "text-term-muted hover:bg-term-card hover:text-term-text",
              )}
            >
              {KIND_META[k].label}
            </button>
          ))}
        </div>
        <p className="mb-3 text-xs text-term-muted">{meta.blurb}</p>
        <div className="flex flex-wrap items-end gap-3">
          <Field label={meta.portLabel}>
            <input
              value={bindPort}
              onChange={(e) => setBindPort(e.target.value)}
              inputMode="numeric"
              placeholder={kind === "dynamic" ? "1080" : "8080"}
              className={inputCls}
            />
          </Field>
          {needsDest && (
            <>
              <span className="pb-2 text-term-faint" aria-hidden>
                →
              </span>
              <Field label="Destination host" grow>
                <input
                  value={destHost}
                  onChange={(e) => setDestHost(e.target.value)}
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="db.internal or 127.0.0.1"
                  className={inputCls}
                />
              </Field>
              <Field label="Dest port">
                <input
                  value={destPort}
                  onChange={(e) => setDestPort(e.target.value)}
                  inputMode="numeric"
                  placeholder="5432"
                  className={inputCls}
                />
              </Field>
            </>
          )}
          <button
            type="submit"
            className="rounded-md border border-term-accent/40 bg-term-accent/15 px-4 py-2 text-xs font-medium text-term-accent hover:bg-term-accent/25"
          >
            Open tunnel
          </button>
        </div>

        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className="mt-3 text-[11px] text-term-faint hover:text-term-muted"
        >
          {showAdvanced ? "▾" : "▸"} Advanced
        </button>
        {showAdvanced && (
          <div className="mt-2">
            <Field label="Bind address (default loopback)">
              <input
                value={bindHost}
                onChange={(e) => setBindHost(e.target.value)}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder="127.0.0.1"
                className={inputCls}
              />
            </Field>
            <p className="mt-1 text-[11px] text-term-faint">
              Binding beyond loopback (e.g. <span className="font-mono">0.0.0.0</span>)
              requires the server to allow public binds.
            </p>
          </div>
        )}

        {errors.length > 0 && (
          <ul className="mt-3 space-y-1">
            {errors.map((err) => (
              <li key={err} className="text-xs text-term-red">
                {err}
              </li>
            ))}
          </ul>
        )}
      </form>

      {forwards.length === 0 ? (
        <p className="px-1 text-xs text-term-faint">No active tunnels.</p>
      ) : (
        <ul className="space-y-2">
          {forwards.map((f) => (
            <li
              key={f.id}
              className="flex items-center gap-3 rounded-lg border border-term-border bg-term-panel/40 px-3 py-2"
            >
              <StatusDot status={f.status} />
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-xs text-term-text">
                  {forwardLabel(f)}
                </p>
                <p className="text-[11px] text-term-faint">
                  {f.status === "error"
                    ? f.error || "Failed"
                    : f.status === "opening"
                      ? "Opening…"
                      : f.status === "closed"
                        ? "Closed"
                        : `${f.conns} active connection${f.conns === 1 ? "" : "s"}`}
                </p>
              </div>
              <button
                type="button"
                onClick={() => onClose(f.id)}
                className="rounded border border-term-border px-2 py-1 text-[11px] text-term-muted hover:text-term-red"
                title="Close tunnel"
              >
                Close
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const inputCls =
  "w-full rounded border border-term-border bg-term-bg px-2 py-1.5 font-mono text-xs text-term-text outline-none placeholder:text-term-faint focus:border-term-accent";

function Field({
  label,
  children,
  grow,
}: {
  label: string;
  children: React.ReactNode;
  grow?: boolean;
}) {
  return (
    <label className={cn("flex flex-col gap-1", grow ? "min-w-[10rem] flex-1" : "w-24")}>
      <span className="text-[11px] text-term-muted">{label}</span>
      {children}
    </label>
  );
}

function StatusDot({ status }: { status: ForwardState["status"] }) {
  return (
    <span
      className={cn(
        "h-2.5 w-2.5 flex-none rounded-full",
        status === "open"
          ? "bg-term-green"
          : status === "error"
            ? "bg-term-red"
            : status === "opening"
              ? "bg-term-yellow term-pulse"
              : "bg-term-fainter",
      )}
      aria-hidden
    />
  );
}
