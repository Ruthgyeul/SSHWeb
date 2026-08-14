"use client";

import { useRef, useState } from "react";
import {
  isHostAllowed,
  parseAllowlist,
  validateConnectInput,
  type AuthMethod,
  type ConnectInput,
} from "@/lib/sshProtocol";
import { SSH_ALLOWED_HOSTS } from "@/config/siteConfig";
import { cn } from "@/lib/utils";

/** Resolved connection details ready to hand to the WebSocket layer. */
export interface ConnectDetails {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

/**
 * Values to pre-fill the form with. Deliberately has **no password** — after a
 * failed login we re-seed the form with the host/port/user (and key material) so
 * the user only has to retype the secret, never the whole connection. Applied at
 * mount, so the caller re-keys the form when it wants to re-seed.
 */
export interface ConnectFormInitial {
  host?: string;
  port?: string;
  username?: string;
  auth?: AuthMethod;
  privateKey?: string;
  passphrase?: string;
}

const inputClass =
  "w-full rounded-md border border-term-border bg-term-panel px-3 py-2 font-mono text-sm text-term-text outline-none placeholder:text-term-faint focus:border-term-accent";
const labelClass = "mb-1 block text-xs font-medium text-term-muted";

/**
 * The SSH login form: host, port, username and either a password or a private
 * key (with optional passphrase). Validation is shared with the server via
 * `validateConnectInput`, and an optional public allowlist lets us reject a
 * disallowed host before opening a socket.
 */
export function ConnectForm({
  onConnect,
  connecting,
  initial,
}: {
  onConnect: (details: ConnectDetails) => void;
  connecting: boolean;
  initial?: ConnectFormInitial;
}) {
  const [host, setHost] = useState(initial?.host ?? "");
  const [port, setPort] = useState(initial?.port ?? "22");
  const [username, setUsername] = useState(initial?.username ?? "");
  const [auth, setAuth] = useState<AuthMethod>(initial?.auth ?? "password");
  // The password is never pre-filled — a failed login clears exactly this field.
  const [password, setPassword] = useState("");
  const [privateKey, setPrivateKey] = useState(initial?.privateKey ?? "");
  const [passphrase, setPassphrase] = useState(initial?.passphrase ?? "");
  const [errors, setErrors] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const allowlist = parseAllowlist(SSH_ALLOWED_HOSTS);

  function handleKeyFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => setPrivateKey(String(reader.result ?? ""));
    reader.readAsText(file);
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const input: ConnectInput = {
      host,
      port,
      username,
      auth,
      password,
      privateKey,
    };
    const found = validateConnectInput(input);
    if (found.length === 0 && !isHostAllowed(host, allowlist)) {
      found.push(`Host "${host}" is not permitted by this server.`);
    }
    setErrors(found);
    if (found.length > 0) return;

    onConnect({
      host: host.trim(),
      port: Number(port),
      username: username.trim(),
      password: auth === "password" ? password : undefined,
      privateKey: auth === "key" ? privateKey : undefined,
      passphrase: auth === "key" && passphrase ? passphrase : undefined,
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_7rem]">
        <div>
          <label htmlFor="ssh-host" className={labelClass}>
            Host
          </label>
          <input
            id="ssh-host"
            className={inputClass}
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="example.com or 203.0.113.10"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            disabled={connecting}
          />
        </div>
        <div>
          <label htmlFor="ssh-port" className={labelClass}>
            Port
          </label>
          <input
            id="ssh-port"
            className={inputClass}
            value={port}
            onChange={(e) => setPort(e.target.value)}
            inputMode="numeric"
            disabled={connecting}
          />
        </div>
      </div>

      <div>
        <label htmlFor="ssh-user" className={labelClass}>
          Username
        </label>
        <input
          id="ssh-user"
          className={inputClass}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="root"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          disabled={connecting}
        />
      </div>

      {/* Auth method toggle */}
      <div>
        <span className={labelClass}>Authentication</span>
        <div className="inline-flex overflow-hidden rounded-md border border-term-border">
          {(["password", "key"] as const).map((method) => (
            <button
              key={method}
              type="button"
              onClick={() => setAuth(method)}
              disabled={connecting}
              className={cn(
                "px-4 py-1.5 text-sm capitalize transition-colors",
                auth === method
                  ? "bg-term-accent/15 text-term-accent"
                  : "bg-term-panel text-term-muted hover:text-term-text",
              )}
            >
              {method === "key" ? "Private key" : "Password"}
            </button>
          ))}
        </div>
      </div>

      {auth === "password" ? (
        <div>
          <label htmlFor="ssh-pass" className={labelClass}>
            Password
          </label>
          <input
            id="ssh-pass"
            type="password"
            className={inputClass}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="off"
            // Re-seeded after a failed login: focus the one field to retype.
            autoFocus={!!initial}
            disabled={connecting}
          />
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label htmlFor="ssh-key" className={labelClass}>
                Private key (PEM / OpenSSH)
              </label>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={connecting}
                className="text-xs text-term-accent hover:text-term-accent-soft"
              >
                Load from file…
              </button>
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleKeyFile(file);
                }}
              />
            </div>
            <textarea
              id="ssh-key"
              className={cn(inputClass, "h-28 resize-y")}
              value={privateKey}
              onChange={(e) => setPrivateKey(e.target.value)}
              placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n…"}
              spellCheck={false}
              disabled={connecting}
            />
          </div>
          <div>
            <label htmlFor="ssh-passphrase" className={labelClass}>
              Key passphrase (optional)
            </label>
            <input
              id="ssh-passphrase"
              type="password"
              className={inputClass}
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              autoComplete="off"
              disabled={connecting}
            />
          </div>
        </div>
      )}

      {errors.length > 0 && (
        <ul className="rounded-md border border-term-red/40 bg-term-red/10 px-3 py-2 text-xs text-term-red">
          {errors.map((error) => (
            <li key={error}>• {error}</li>
          ))}
        </ul>
      )}

      <button
        type="submit"
        disabled={connecting}
        className={cn(
          "mt-1 rounded-md border border-term-accent/40 bg-term-accent/15 px-4 py-2.5 text-sm font-medium text-term-accent transition-colors hover:bg-term-accent/25",
          connecting && "cursor-not-allowed opacity-60",
        )}
      >
        {connecting ? "Connecting…" : "Connect →"}
      </button>
    </form>
  );
}
