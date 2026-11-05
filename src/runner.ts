// コマンドの起動・停止・ログ取得
// process 型: シェル経由で detached 起動し、出力はログファイルへ。
//             マネージャーを再起動してもプロセスは生き続け、PID で追跡を再開する。
// compose 型: docker compose up -d / down を実行し、状態は docker ps のラベルから判定する。
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  writeSync,
  fstatSync,
} from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { run } from "./exec";
import { type App, type Command, getState, logPath, saveState } from "./store";
import type { Container } from "./system";

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const SHELL = process.env.SHELL || "/bin/zsh";

// compose の up/down 実行中ジョブ（メモリ上のみ）
export type ComposeAction = "up" | "down" | "pull";
const composeJobs = new Map<string, { action: ComposeAction; startedAt: string }>();

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

function openLog(cmdId: string): number {
  const p = logPath(cmdId);
  if (existsSync(p) && statSync(p).size > MAX_LOG_BYTES) renameSync(p, `${p}.1`);
  return openSync(p, "a");
}

function banner(fd: number, text: string) {
  writeSync(fd, `\n===== [${new Date().toLocaleString()}] ${text} =====\n`);
}

export function assertCwd(app: App) {
  if (!existsSync(app.cwd) || !statSync(app.cwd).isDirectory()) {
    throw new HttpError(400, `Folder does not exist: ${app.cwd}`);
  }
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

// ---------- process 型 ----------

export function processRunning(cmdId: string): number | undefined {
  const r = getState().runs[cmdId];
  if (r && !r.exitedAt && isAlive(r.pid)) return r.pid;
  return undefined;
}

function startProcess(app: App, cmd: Command) {
  if (!cmd.command?.trim()) throw new HttpError(400, "Command is empty");
  if (processRunning(cmd.id)) throw new HttpError(409, "Already running");
  const fd = openLog(cmd.id);
  banner(fd, `start: ${cmd.command}  (cwd: ${app.cwd})`);
  const child = spawn(SHELL, ["-c", cmd.command], {
    cwd: app.cwd,
    detached: true, // 新しいプロセスグループ → まとめて kill できる / マネージャー終了後も残る
    stdio: ["ignore", fd, fd],
    env: { ...process.env, ...(cmd.env ?? {}) },
  });
  closeSync(fd);
  if (!child.pid) throw new HttpError(500, "Failed to spawn process");
  const pid = child.pid;
  getState().runs[cmd.id] = { pid, startedAt: new Date().toISOString() };
  saveState();
  child.on("exit", (code, signal) => {
    const r = getState().runs[cmd.id];
    if (r && r.pid === pid) {
      r.exitedAt = new Date().toISOString();
      r.exitCode = code;
      r.signal = signal;
      saveState();
    }
    const lfd = openSync(logPath(cmd.id), "a");
    banner(lfd, `exit: code=${code} signal=${signal ?? "-"}`);
    closeSync(lfd);
  });
  child.unref();
}

async function stopProcess(cmd: Command) {
  const pid = processRunning(cmd.id);
  if (!pid) return;
  const killGroup = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        process.kill(pid, sig);
      } catch {}
    }
  };
  killGroup("SIGTERM");
  for (let i = 0; i < 50; i++) {
    await Bun.sleep(100);
    if (!isAlive(pid)) break;
  }
  if (isAlive(pid)) killGroup("SIGKILL");
  const r = getState().runs[cmd.id];
  if (r && !r.exitedAt) {
    r.exitedAt = new Date().toISOString();
    r.signal = "SIGTERM";
    saveState();
  }
}

// ---------- compose 型 ----------

export function composeFiles(app: App, cmd: Command): string[] {
  return (cmd.composeFile ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((f) => (isAbsolute(f) ? f : resolve(app.cwd, f)));
}

function composeArgs(app: App, cmd: Command): string[] {
  const args = ["compose"];
  for (const f of composeFiles(app, cmd)) args.push("-f", f);
  if (cmd.projectName) args.push("-p", cmd.projectName);
  return args;
}

const normalizeProject = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]/g, "");

function realpathOr(p: string) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** docker ps の結果からこの compose コマンドのコンテナを探す */
export function matchContainers(app: App, cmd: Command, containers: Container[]): Container[] {
  const cwd = realpathOr(app.cwd);
  const project = cmd.projectName ? normalizeProject(cmd.projectName) : undefined;
  const files = composeFiles(app, cmd).map(realpathOr);
  return containers.filter((c) => {
    if (project) {
      if (c.project !== project) return false;
    } else {
      if (!c.workingDir || realpathOr(c.workingDir) !== cwd) {
        // working_dir ラベルが無い古い compose 向けにプロジェクト名でも判定
        if (c.project !== normalizeProject(basename(cwd))) return false;
      }
    }
    if (files.length > 0) {
      const cf = c.configFiles.map(realpathOr);
      if (!files.some((f) => cf.includes(f))) return false;
    }
    return true;
  });
}

export const composeJob = (cmdId: string) => composeJobs.get(cmdId);

function runCompose(app: App, cmd: Command, action: ComposeAction) {
  const job = composeJobs.get(cmd.id);
  if (job) throw new HttpError(409, `docker compose ${job.action} is already running for this command`);
  const args = composeArgs(app, cmd);
  if (action === "up") args.push("up", "-d", ...(cmd.build ? ["--build"] : []));
  else if (action === "pull") args.push("pull");
  else args.push("down");
  const fd = openLog(cmd.id);
  banner(fd, `docker ${args.join(" ")}  (cwd: ${app.cwd})`);
  const child = spawn("docker", args, {
    cwd: app.cwd,
    stdio: ["ignore", fd, fd],
    env: { ...process.env, ...(cmd.env ?? {}) },
  });
  closeSync(fd);
  composeJobs.set(cmd.id, { action, startedAt: new Date().toISOString() });
  return new Promise<void>((resolveP) => {
    const done = (code: number | null, err?: Error) => {
      composeJobs.delete(cmd.id);
      const lfd = openSync(logPath(cmd.id), "a");
      banner(lfd, err ? `error: ${err.message}` : `docker compose ${action} finished: code=${code}`);
      closeSync(lfd);
      resolveP();
    };
    child.on("exit", (code) => done(code));
    child.on("error", (err) => done(null, err));
  });
}

// ---------- 共通 API ----------

export async function start(app: App, cmd: Command) {
  assertCwd(app);
  if (cmd.type === "compose") {
    void runCompose(app, cmd, "up"); // ビルドは時間がかかるので待たない。進捗はログで確認
  } else {
    startProcess(app, cmd);
  }
}

/** docker compose pull（compose 型のみ）。時間がかかるので待たない。進捗はログで確認 */
export function pull(app: App, cmd: Command) {
  if (cmd.type !== "compose") throw new HttpError(400, "Pull is only available for docker compose commands");
  assertCwd(app);
  void runCompose(app, cmd, "pull");
}

export async function stop(app: App, cmd: Command) {
  if (cmd.type === "compose") {
    await runCompose(app, cmd, "down");
  } else {
    await stopProcess(cmd);
  }
}

function tailFile(path: string, since?: number, maxBytes = 64 * 1024): { text: string; offset: number } {
  if (!existsSync(path)) return { text: "", offset: 0 };
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    let from = since ?? Math.max(0, size - maxBytes);
    if (from > size) from = Math.max(0, size - maxBytes); // ローテーションされた
    const len = Math.min(size - from, 1024 * 1024);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, from);
    return { text: buf.toString("utf8"), offset: from + len };
  } finally {
    closeSync(fd);
  }
}

export async function logs(app: App, cmd: Command, since?: number) {
  if (cmd.type === "process") {
    return { mode: "append" as const, ...tailFile(logPath(cmd.id), since) };
  }
  // compose: 実行ログ（up/down/ビルド出力）＋ コンテナログ
  const action = tailFile(logPath(cmd.id), undefined, 16 * 1024).text;
  const res = await run([...["docker"], ...composeArgs(app, cmd), "logs", "--no-color", "--tail", "300"], {
    cwd: app.cwd,
    timeoutMs: 5000,
  });
  const containerLogs = res.ok ? res.stdout : res.stderr;
  return {
    mode: "replace" as const,
    text: `${action}\n\n──────── container logs (docker compose logs --tail 300) ────────\n${containerLogs}`,
    offset: 0,
  };
}

export function clearLog(cmdId: string) {
  const p = logPath(cmdId);
  if (existsSync(p)) closeSync(openSync(p, "w"));
}
