# App Manager

English | [日本語](README.ja.md)

A small web UI for the apps you run locally — bun, node, python, docker compose and so on.
It keeps track of **which folder, which command and which ports** each app uses, and shows what is running right now.
Think of it as something between pm2 and Portainer. It runs on Bun with no runtime dependencies,
and the UI works on phone-sized screens too.

## Getting started

```bash
bun install   # type definitions only; not needed to run
bun start     # http://127.0.0.1:4949
```

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `4949` | Port to listen on |
| `HOST` | `127.0.0.1` | Address to listen on. App Manager can run arbitrary commands, so never expose it to an untrusted network |
| `APP_MANAGER_DATA` | `./data` | Where settings, state and logs are stored |
| `ALLOWED_HOSTS` | — | Extra `Host` headers to accept, comma-separated. Use `host:port`, or just `host` to accept any port |

> Commands started by App Manager inherit the environment (PATH etc.) of the shell where you ran `bun start`.
> Tools like nvm or pyenv need to be active in that shell.

## Using it from another machine (Tailscale)

App Manager has no authentication. To use it from another machine, put it behind a private network
such as Tailscale. There are two ways to do this.

### A. `tailscale serve` (recommended)

App Manager keeps listening on 127.0.0.1, and Tailscale proxies it over HTTPS to your tailnet only.
Because it is HTTPS, browser features such as the clipboard API work as usual.

```bash
# 1. Find your machine name (e.g. mymac.tail1234.ts.net)
tailscale status --self

# 2. Start App Manager with that name allowed
ALLOWED_HOSTS=mymac.tail1234.ts.net bun start

# 3. In another terminal, share it on your tailnet (runs in the background)
tailscale serve --bg 4949
```

Then open `https://mymac.tail1234.ts.net` from the other machine.

- The first time, Tailscale may ask you to enable HTTPS certificates for your tailnet. Follow the link it prints.
- To stop sharing, run `tailscale serve reset`.
- With the macOS Tailscale app, the CLI is at `/Applications/Tailscale.app/Contents/MacOS/Tailscale`.

### B. Listen on the Tailscale IP directly

If you don't use `tailscale serve`, bind App Manager to the Tailscale interface only (it is not exposed to your LAN):

```bash
TS_IP=$(tailscale ip -4)   # e.g. 100.64.0.1
HOST=$TS_IP ALLOWED_HOSTS=$TS_IP,mymac,mymac.tail1234.ts.net bun start
```

Then open `http://100.64.0.1:4949` (or `http://mymac:4949` with MagicDNS).
Traffic is encrypted by WireGuard, but the browser still treats the page as plain HTTP (the Copy buttons use a fallback that works without HTTPS).

### Things to keep in mind

- Everyone in your tailnet, including devices shared with you, can run arbitrary commands through App Manager.
  Use Tailscale ACLs to limit who can reach ports 443 / 4949 on this machine if needed.
- If you see `Host not allowed: ...`, add that host name to `ALLOWED_HOSTS`.
- Port links open on the same host name you used for App Manager (e.g. `http://mymac.tail1234.ts.net:3000`).
  They only work from another machine if the app itself listens on `0.0.0.0` or the Tailscale IP.

## Features

- Register an **app per folder**, each with **several start commands**
  (e.g. `dev` = `bun run dev`, `prod` = `docker compose -f compose.prod.yml up -d --build`)
- Command types
  - **Command**: started detached via `$SHELL -c`, with output written to `data/logs/<id>.log`.
    Processes keep running when App Manager restarts, and tracking resumes by PID. Stop sends SIGTERM to the whole process group, then SIGKILL after 5 seconds.
  - **docker compose**: `up -d [--build]` / `down`. **Pull** runs `docker compose pull`; its output appears in Logs. Status comes from the compose labels in `docker ps` (working folder, config files, project name).
- **Status at a glance**
  - Running / Working / Stopped / Crashed
  - **Running (external)**: detects processes started outside App Manager (e.g. from a terminal)
    when they run in the app's folder and use one of its ports
- **Ports** tab: every TCP port that is listening right now, from `lsof` and `docker ps`
  - Which process or container uses it, from which folder, with which command
  - Levels: `Note` shared by commands of the same app / `Warning` defined by several apps, or used by an unregistered process / `Conflict` running at the same time
  - Asks for confirmation before starting a command whose port is already taken
  - **Register as app**: opens the editor pre-filled with the folder, command and ports of an unregistered process or compose container.
    If the folder is already registered, it becomes **Add to app** (OS daemons whose working folder is `/` are skipped)
- **Inspect folder** suggests start commands from `package.json` scripts, ports in `compose*.yml`, `manage.py`, FastAPI apps and more
- Copy `cd <folder> && <command>` with one click
- Can be added to the Dock as a web app (Safari: File > Add to Dock / Chrome: Install App Manager), with its own icon

## Data

- `data/apps.json` — app and command definitions (you can edit it by hand; restart App Manager afterwards)
- `data/state.json` — PIDs of started processes, etc.
- `data/logs/` — logs (rotated to `.log.1` on start once they exceed 5 MB)

## Why not run it in Docker?

Inside a container, App Manager could not start bun / node / python on the host,
and it could not see the host's ports or processes (`lsof`). So it runs directly on the host with Bun.
To keep it running in the background, use launchd (`~/Library/LaunchAgents`) or just leave `bun start` running in a terminal.

## Requirements

Tested on macOS. It relies on `lsof` and `ps`, so Linux should work too, but this has not been tested. Windows is not supported.

## Project layout

```
src/
  server.ts   HTTP API and static files (with CSRF / DNS rebinding protection)
  store.ts    reads and writes apps.json / state.json
  runner.ts   start, stop and logs (process / compose)
  system.ts   snapshots from lsof, ps and docker ps
  status.ts   matches config against reality; port duplicate / conflict checks
  inspect.ts  guesses start commands from a folder
public/       UI (plain HTML/CSS/JS, no build step)
```
