# Deploying SSHWeb with systemd

SSHWeb runs a **custom Node server** (`server.mjs`) that serves the Next.js app
*and* bridges a WebSocket to a real SSH/SFTP connection. It is therefore a
long-lived Node process — not a static export, not an edge deployment, and
**not `next start`**.

> **The single most common startup failure** is a unit that runs
> `next start` (or `npx next start`). That command boots a plain Next server
> with no `/api/ssh` bridge, and — if there is no prior `next build` — exits
> immediately with status 1, which systemd shows as a crash/`auto-restart`
> loop. Always run the custom server: `node server.mjs` (what `npm run start`
> invokes).

## Prerequisites

- Node.js ≥ 20.9 (see [`.nvmrc`](../.nvmrc)).
- The app checked out on the host (e.g. under `/opt/sshweb`).
- A dedicated, unprivileged service account:

  ```bash
  sudo useradd --system --home /opt/sshweb --shell /usr/sbin/nologin sshweb
  ```

## 1. Build the app

`server.mjs` serves the prebuilt `.next/` output in production, so you must
build **before** starting the service (and again after every deploy):

```bash
cd /opt/sshweb
npm ci
npm run build      # runs `next build` — fails on type errors
```

## 2. Configure

Configuration is env-driven (see [`.env.example`](../.env.example)). You can
either drop a `.env.local` in the app directory (loaded automatically by
`server.mjs` via `@next/env`) or keep host/secret settings in a root-owned env
file referenced by the unit:

```bash
sudo install -d -m 0755 /etc/sshweb
sudo tee /etc/sshweb/sshweb.env >/dev/null <<'EOF'
PORT=3000
# Restrict which hosts the bridge may reach (empty = anywhere):
# SSH_ALLOWED_HOSTS=example.com,*.internal.example.com
# SSH_MAX_SESSIONS=25
# SSH_MAX_DOWNLOAD_BYTES=26214400
EOF
sudo chmod 0640 /etc/sshweb/sshweb.env
```

## 3. Install the service

Edit the placeholders in [`SSHWeb.service`](SSHWeb.service) (`User`/`Group`,
`WorkingDirectory`, the `node` path, `EnvironmentFile`) to match your host,
then:

```bash
sudo cp deploy/SSHWeb.service /etc/systemd/system/SSHWeb.service
sudo systemctl daemon-reload
sudo systemctl enable --now SSHWeb
sudo systemctl status SSHWeb
```

You should see `Active: active (running)` and, in the logs, the bridge's ready
line:

```bash
journalctl -u SSHWeb -f
# > Ready on http://127.0.0.1:3000 (SSH bridge at /api/ssh)
```

## 4. Terminate TLS in front of it

Run SSHWeb behind a reverse proxy (nginx, Caddy, …) that terminates HTTPS, so
credentials and session bytes travel over `wss://`. The proxy must forward the
WebSocket upgrade for the SSH bridge path (`/api/ssh` by default). Minimal nginx
`location` for the app + bridge:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;   # "upgrade" for WS, "" otherwise
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;   # keep long-lived terminals alive
}
```

## Updating a deployment

```bash
cd /opt/sshweb
git pull                 # or rsync the new build
npm ci && npm run build  # rebuild — server.mjs serves the built output
sudo systemctl restart SSHWeb
```

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `activating (auto-restart)`, `status=1`, restart loop | `ExecStart` runs `next start`/`npx next start`, or there is no `.next` build | Use `ExecStart=/usr/bin/env node server.mjs` and run `npm run build` first |
| Starts, page loads, but the terminal never connects | Running plain Next (no bridge), or the proxy isn't forwarding the WebSocket upgrade | Ensure the service runs `server.mjs`; forward `Upgrade`/`Connection` for `/api/ssh` |
| `status=203/EXEC` or `node: not found` | `node` isn't on the unit's PATH | Set `ExecStart` to the absolute node path (e.g. from `which node`) |
| `status=200/CHDIR` | `WorkingDirectory` doesn't exist / wrong owner | Point it at the deploy path and `chown` it to the service user |
| Permission denied writing under the app dir | Hardening (`ProtectSystem=strict`) blocks writes | Add the needed path to `ReadWritePaths=` in the unit |
