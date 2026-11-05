// App Manager: ローカルで起動するアプリ（bun/node/python/docker compose ...）を一元管理する Web UI
// 任意のコマンドを実行できるため、既定では 127.0.0.1 のみで待ち受ける。
import { join } from "node:path";
import { homedir } from "node:os";
import { inspectDir } from "./inspect";
import { HttpError, clearLog, logs, pull, start, stop } from "./runner";
import { buildStatus, portConflictsBeforeStart } from "./status";
import { type App, type Command, findCommand, getConfig, newId, saveConfig } from "./store";
import { invalidate } from "./system";

const PORT = Number(process.env.PORT ?? 4949);
const HOST = process.env.HOST ?? "127.0.0.1";
const PUBLIC_DIR = join(import.meta.dir, "..", "public");

const json = (data: unknown, status = 200) => Response.json(data, { status });

const expandHome = (p: string) => (p.startsWith("~") ? join(homedir(), p.slice(1)) : p);

function normalizeApp(body: any, existing?: App): App {
  const name = String(body?.name ?? "").trim();
  const cwd = expandHome(String(body?.cwd ?? "").trim()).replace(/\/+$/, "");
  if (!name) throw new HttpError(400, "Name is required");
  if (!cwd.startsWith("/")) throw new HttpError(400, "Folder must be an absolute path");
  const commands: Command[] = (Array.isArray(body?.commands) ? body.commands : []).map((c: any) => {
    const type = c?.type === "compose" ? "compose" : "process";
    const cmdName = String(c?.name ?? "").trim() || (type === "compose" ? "compose" : "dev");
    const ports = (Array.isArray(c?.ports) ? c.ports : String(c?.ports ?? "").split(/[,\s]+/))
      .map(Number)
      .filter((n: number) => Number.isInteger(n) && n > 0 && n < 65536);
    const env: Record<string, string> = {};
    if (c?.env && typeof c.env === "object") for (const [k, v] of Object.entries(c.env)) if (k) env[k] = String(v);
    const cmd: Command = {
      id: existing?.commands.some((x) => x.id === c?.id) ? c.id : newId(),
      name: cmdName,
      type,
      ports: [...new Set<number>(ports)],
      env: Object.keys(env).length ? env : undefined,
      note: c?.note ? String(c.note) : undefined,
    };
    if (type === "process") {
      cmd.command = String(c?.command ?? "").trim();
      if (!cmd.command) throw new HttpError(400, `Command "${cmdName}" is empty`);
    } else {
      cmd.composeFile = c?.composeFile ? String(c.composeFile).trim() : undefined;
      cmd.projectName = c?.projectName ? String(c.projectName).trim() : undefined;
      cmd.build = !!c?.build;
    }
    return cmd;
  });
  return {
    id: existing?.id ?? newId(),
    name,
    cwd,
    description: body?.description ? String(body.description) : undefined,
    commands,
  };
}

function cmdOr404(cmdId: string) {
  const found = findCommand(cmdId);
  if (!found) throw new HttpError(404, "Command not found");
  return found;
}

// 任意コマンドを実行できる API なので、他サイトからのリクエスト（CSRF / DNS rebinding）を拒否する
// ALLOWED_HOSTS には "host:port" か "host"（ポートを問わない）をカンマ区切りで指定する
const ALLOWED_HOSTS = new Set([
  `localhost:${PORT}`,
  `127.0.0.1:${PORT}`,
  `[::1]:${PORT}`,
  ...(process.env.ALLOWED_HOSTS?.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean) ?? []),
]);
const hostnameOf = (host: string) => host.replace(/:\d+$/, "");
function guard(req: Request) {
  const host = (req.headers.get("host") ?? "").toLowerCase();
  if (!ALLOWED_HOSTS.has(host) && !ALLOWED_HOSTS.has(hostnameOf(host))) {
    throw new HttpError(403, `Host not allowed: ${host} (add it to ALLOWED_HOSTS)`);
  }
  if (req.method !== "GET" && req.headers.get("x-app-manager") !== "1") {
    throw new HttpError(403, "x-app-manager header is required");
  }
}

async function handle(req: Request, fn: () => Promise<Response> | Response) {
  try {
    guard(req);
    // Bun.serve は既定で 10 秒無通信の接続を切る。docker compose down などは
    // それより長くかかるので、操作系（GET 以外）のリクエストではタイムアウトを無効にする
    if (req.method !== "GET") server.timeout(req, 0);
    const res = await fn();
    if (req.method !== "GET") invalidate();
    return res;
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, ...e.extra }, e.status);
    console.error(e);
    return json({ error: String(e) }, 500);
  }
}

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  routes: {
    "/api/status": (req) => handle(req, async () => json(await buildStatus())),

    "/api/apps": {
      POST: (req) =>
        handle(req, async () => {
          const app = normalizeApp(await req.json());
          const cfg = getConfig();
          saveConfig({ apps: [...cfg.apps, app] });
          return json(app, 201);
        }),
    },

    "/api/apps/:id": {
      PUT: (req) =>
        handle(req, async () => {
          const cfg = getConfig();
          const existing = cfg.apps.find((a) => a.id === req.params.id);
          if (!existing) throw new HttpError(404, "App not found");
          const app = normalizeApp(await req.json(), existing);
          saveConfig({ apps: cfg.apps.map((a) => (a.id === app.id ? app : a)) });
          return json(app);
        }),
      DELETE: (req) =>
        handle(req, async () => {
          const cfg = getConfig();
          saveConfig({ apps: cfg.apps.filter((a) => a.id !== req.params.id) });
          return json({ ok: true });
        }),
    },

    "/api/apps/reorder": {
      POST: (req) =>
        handle(req, async () => {
          const ids: string[] = (await req.json()).ids ?? [];
          const cfg = getConfig();
          const sorted = [...cfg.apps].sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
          saveConfig({ apps: sorted });
          return json({ ok: true });
        }),
    },

    "/api/commands/:id/start": {
      POST: (req) =>
        handle(req, async () => {
          const { app, cmd } = cmdOr404(req.params.id);
          const force = new URL(req.url).searchParams.get("force") === "1";
          if (!force) {
            const conflicts = await portConflictsBeforeStart(cmd.id);
            if (conflicts.length > 0) {
              throw new HttpError(409, "Port already in use", { conflicts });
            }
          }
          await start(app, cmd);
          return json({ ok: true });
        }),
    },

    "/api/commands/:id/stop": {
      POST: (req) =>
        handle(req, async () => {
          const { app, cmd } = cmdOr404(req.params.id);
          await stop(app, cmd);
          return json({ ok: true });
        }),
    },

    "/api/commands/:id/pull": {
      POST: (req) =>
        handle(req, () => {
          const { app, cmd } = cmdOr404(req.params.id);
          pull(app, cmd);
          return json({ ok: true });
        }),
    },

    "/api/commands/:id/restart": {
      POST: (req) =>
        handle(req, async () => {
          const { app, cmd } = cmdOr404(req.params.id);
          await stop(app, cmd);
          await start(app, cmd);
          return json({ ok: true });
        }),
    },

    "/api/commands/:id/logs": {
      GET: (req) =>
        handle(req, async () => {
          const { app, cmd } = cmdOr404(req.params.id);
          const since = new URL(req.url).searchParams.get("since");
          return json(await logs(app, cmd, since ? Number(since) : undefined));
        }),
      DELETE: (req) =>
        handle(req, () => {
          cmdOr404(req.params.id);
          clearLog(req.params.id);
          return json({ ok: true });
        }),
    },

    "/api/inspect": (req) =>
      handle(req, () => {
        const dir = expandHome(new URL(req.url).searchParams.get("cwd") ?? "");
        const result = inspectDir(dir);
        console.log(`[inspect] ${dir} → ${result.exists ? `${result.suggestions.length} suggestion(s)` : "folder not found"}`);
        return json(result);
      }),

    "/api/kill/:pid": {
      // 登録外のプロセス（ポートを塞いでいるもの）を止める
      POST: (req) =>
        handle(req, () => {
          const pid = Number(req.params.pid);
          if (!Number.isInteger(pid) || pid <= 1) throw new HttpError(400, "Invalid PID");
          process.kill(pid, "SIGTERM");
          return json({ ok: true });
        }),
    },
  },

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) return json({ error: "not found" }, 404);
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    if (path.includes("..")) return new Response("bad request", { status: 400 });
    const file = Bun.file(join(PUBLIC_DIR, path));
    if (await file.exists()) return new Response(file);
    return new Response("not found", { status: 404 });
  },
});

console.log(`App Manager: http://${server.hostname}:${server.port}`);
if (process.env.ALLOWED_HOSTS) console.log(`Allowed hosts: ${[...ALLOWED_HOSTS].join(", ")}`);
