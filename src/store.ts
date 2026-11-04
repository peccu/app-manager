// 設定（アプリ・コマンド定義）と実行状態（PID 等）を JSON ファイルに保存する
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type CommandType = "process" | "compose";

export interface Command {
  id: string;
  name: string; // 例: "dev", "prod (compose)"
  type: CommandType;
  // process: シェルで実行するコマンド（例: "bun run dev"）
  command?: string;
  // compose: 対象ファイル（カンマ区切りで複数可）とオプション
  composeFile?: string;
  projectName?: string;
  build?: boolean;
  ports: number[];
  env?: Record<string, string>;
  note?: string;
}

export interface App {
  id: string;
  name: string;
  cwd: string;
  description?: string;
  commands: Command[];
}

export interface Config {
  apps: App[];
}

export interface RunState {
  pid: number;
  startedAt: string;
  exitedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
}

export interface State {
  runs: Record<string, RunState>; // key: command id
}

export const DATA_DIR = process.env.APP_MANAGER_DATA ?? join(import.meta.dir, "..", "data");
export const LOG_DIR = join(DATA_DIR, "logs");
const CONFIG_PATH = join(DATA_DIR, "apps.json");
const STATE_PATH = join(DATA_DIR, "state.json");

mkdirSync(LOG_DIR, { recursive: true });

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (e) {
    console.error(`[store] failed to read ${path}:`, e);
    return fallback;
  }
}

function writeJson(path: string, data: unknown) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, path);
}

export const newId = () => crypto.randomUUID().slice(0, 8);

let config: Config = readJson<Config>(CONFIG_PATH, { apps: [] });
let state: State = readJson<State>(STATE_PATH, { runs: {} });

export const getConfig = () => config;
export const getState = () => state;

export function saveConfig(next: Config) {
  config = next;
  writeJson(CONFIG_PATH, config);
}

export function saveState() {
  writeJson(STATE_PATH, state);
}

export function findCommand(cmdId: string): { app: App; cmd: Command } | undefined {
  for (const app of config.apps) {
    const cmd = app.commands.find((c) => c.id === cmdId);
    if (cmd) return { app, cmd };
  }
  return undefined;
}

export const logPath = (cmdId: string) => join(LOG_DIR, `${cmdId}.log`);
