// 設定と実際の状態を突き合わせて、コマンドの状態とポートの重複・衝突を判定する
import { composeJob, matchContainers, processRunning } from "./runner";
import { type App, type Command, getConfig, getState } from "./store";
import { type Container, type Listener, isDockerForwarder, snapshot } from "./system";

export type CmdStatus =
  | "running" // このマネージャーから起動して稼働中 / compose のコンテナが稼働中
  | "starting" // compose up/down 実行中
  | "external" // 管理外だが、同じフォルダのプロセスが定義ポートで待ち受け中
  | "stopped"
  | "exited"; // 異常終了（exit code != 0）

export type Level = "ok" | "info" | "warn" | "error";

export interface Owner {
  kind: "process" | "docker";
  label: string; // プロセス名 / コンテナ名
  pid?: number;
  cwd?: string;
  command?: string;
  container?: string;
  ownerCmdId?: string; // 管理下のコマンドが使っている場合
  sameApp?: string; // 管理外だがアプリのフォルダ内で動いている場合の appId
  self?: boolean; // App Manager 自身
  project?: string; // compose プロジェクト名（コンテナのみ）
  configFiles?: string[]; // compose ファイル（コンテナのみ）
}

export interface PortRow {
  port: number;
  declared: { appId: string; appName: string; cmdId: string; cmdName: string }[];
  owners: Owner[];
  level: Level;
  messages: string[];
}

const within = (dir: string | undefined, root: string) =>
  !!dir && (dir === root || dir.startsWith(root.endsWith("/") ? root : root + "/"));

const LEVEL_ORDER: Level[] = ["ok", "info", "warn", "error"];
const maxLevel = (a: Level, b: Level) => (LEVEL_ORDER.indexOf(a) >= LEVEL_ORDER.indexOf(b) ? a : b);

export async function buildStatus(force = false) {
  const snap = await snapshot(force);
  const { apps } = getConfig();
  const runs = getState().runs;

  // 1. 各コマンドの実行状態
  const cmdInfo = new Map<
    string,
    { app: App; cmd: Command; status: CmdStatus; pid?: number; containers: Container[] }
  >();
  for (const app of apps) {
    for (const cmd of app.commands) {
      let status: CmdStatus = "stopped";
      let pid: number | undefined;
      let containers: Container[] = [];
      if (cmd.type === "compose") {
        containers = matchContainers(app, cmd, snap.containers);
        if (composeJob(cmd.id) && composeJob(cmd.id)!.action !== "pull") status = "starting";
        else if (containers.some((c) => c.state === "running")) status = "running";
        else if (containers.some((c) => c.state === "exited")) status = "exited";
      } else {
        pid = processRunning(cmd.id);
        if (pid) status = "running";
        else {
          const r = runs[cmd.id];
          if (r?.exitedAt && r.exitCode && r.exitCode !== 0 && !r.signal) status = "exited";
        }
      }
      cmdInfo.set(cmd.id, { app, cmd, status, pid, containers });
    }
  }

  // 2. ポートごとの使用者（プロセス / コンテナ）
  const ownersByPort = new Map<number, Owner[]>();
  const push = (port: number, o: Owner) => {
    const list = ownersByPort.get(port) ?? [];
    list.push(o);
    ownersByPort.set(port, list);
  };
  const dockerPorts = new Set<number>();
  for (const c of snap.containers) {
    if (c.state !== "running") continue;
    for (const port of c.ports) {
      dockerPorts.add(port);
      const owner = [...cmdInfo.values()].find((i) => i.containers.some((x) => x.id === c.id));
      push(port, {
        kind: "docker",
        label: c.name,
        container: c.id,
        command: c.image,
        cwd: c.workingDir,
        ownerCmdId: owner?.cmd.id,
        sameApp: owner ? undefined : apps.find((a) => within(c.workingDir, a.cwd))?.id,
        project: c.project,
        configFiles: c.configFiles,
      });
    }
  }
  for (const l of snap.listeners) {
    // Docker のポート転送プロセスはコンテナ側で表示するので省く
    if (dockerPorts.has(l.port) && isDockerForwarder(l.process)) continue;
    const owner = [...cmdInfo.values()].find((i) => i.pid && (l.pgid === i.pid || l.pid === i.pid));
    const sameApp = owner ? undefined : apps.find((a) => within(l.cwd, a.cwd))?.id;
    const existing = ownersByPort.get(l.port)?.find((o) => o.pid === l.pid);
    if (existing) continue;
    push(l.port, {
      kind: "process",
      label: l.process,
      pid: l.pid,
      cwd: l.cwd,
      command: l.command,
      ownerCmdId: owner?.cmd.id,
      sameApp,
      self: l.pid === process.pid,
    });
  }

  // 3. 管理外起動の検出（同じフォルダのプロセスが定義ポートを使っている）
  for (const info of cmdInfo.values()) {
    if (info.status !== "stopped" || info.cmd.type !== "process") continue;
    const hit = info.cmd.ports.some((p) =>
      (ownersByPort.get(p) ?? []).some((o) => !o.ownerCmdId && o.sameApp === info.app.id),
    );
    if (hit) info.status = "external";
  }

  // 4. ポート一覧と警告
  const declaredByPort = new Map<number, PortRow["declared"]>();
  for (const { app, cmd } of cmdInfo.values()) {
    for (const port of new Set(cmd.ports)) {
      const list = declaredByPort.get(port) ?? [];
      list.push({ appId: app.id, appName: app.name, cmdId: cmd.id, cmdName: cmd.name });
      declaredByPort.set(port, list);
    }
  }
  const allPorts = new Set([...declaredByPort.keys(), ...ownersByPort.keys()]);
  const rows: PortRow[] = [];
  for (const port of [...allPorts].sort((a, b) => a - b)) {
    const declared = declaredByPort.get(port) ?? [];
    const owners = ownersByPort.get(port) ?? [];
    let level: Level = "ok";
    const messages: string[] = [];
    const appIds = new Set(declared.map((d) => d.appId));
    const active = declared.filter((d) => {
      const s = cmdInfo.get(d.cmdId)!.status;
      return s === "running" || s === "starting" || s === "external";
    });

    if (appIds.size > 1) {
      level = maxLevel(level, "warn");
      messages.push(`Defined by multiple apps (${[...new Set(declared.map((d) => d.appName))].join(" / ")})`);
    } else if (declared.length > 1) {
      level = maxLevel(level, "info");
      messages.push("Shared by commands of the same app (they cannot run at the same time)");
    }
    if (active.length > 1) {
      level = maxLevel(level, "error");
      messages.push(`Running at the same time: ${active.map((d) => `${d.appName}/${d.cmdName}`).join(", ")}`);
    }
    const foreign = owners.filter(
      (o) => !o.ownerCmdId && !(o.sameApp && declared.some((d) => d.appId === o.sameApp)),
    );
    if (declared.length > 0 && foreign.length > 0) {
      level = maxLevel(level, "warn");
      messages.push(
        `Used by an unregistered process: ${foreign.map((o) => o.label + (o.pid ? `(PID ${o.pid})` : "")).join(", ")}` +
          (active.length === 0 ? " — starting will conflict" : ""),
      );
    }
    rows.push({ port, declared, owners, level, messages });
  }

  const portLevel = new Map(rows.map((r) => [r.port, r]));
  const appsOut = apps.map((app) => ({
    ...app,
    commands: app.commands.map((cmd) => {
      const info = cmdInfo.get(cmd.id)!;
      const run = runs[cmd.id];
      return {
        ...cmd,
        status: info.status,
        pid: info.pid,
        job: cmd.type === "compose" ? composeJob(cmd.id)?.action : undefined,
        startedAt: info.status === "running" && cmd.type === "process" ? run?.startedAt : undefined,
        lastExit:
          run?.exitedAt && info.status !== "running"
            ? { at: run.exitedAt, code: run.exitCode, signal: run.signal }
            : undefined,
        containers: info.containers.map((c) => ({ name: c.name, state: c.state, status: c.status, service: c.service })),
        portStates: cmd.ports.map((p) => {
          const row = portLevel.get(p);
          return { port: p, level: row?.level ?? "ok", messages: row?.messages ?? [], inUse: (row?.owners.length ?? 0) > 0 };
        }),
      };
    }),
  }));

  return {
    apps: appsOut,
    ports: rows,
    docker: { available: snap.dockerAvailable, error: snap.dockerError },
    summary: {
      running: appsOut.flatMap((a) => a.commands).filter((c) => c.status === "running").length,
      warnings: rows.filter((r) => r.level === "warn" || r.level === "error").length,
      errors: rows.filter((r) => r.level === "error").length,
    },
    at: snap.at,
  };
}

/** 起動前チェック: 定義ポートを別の何かが使っていないか */
export async function portConflictsBeforeStart(cmdId: string) {
  const status = await buildStatus(true);
  const row = (p: number) => status.ports.find((r) => r.port === p);
  const info = status.apps.flatMap((a) => a.commands.map((c) => ({ a, c }))).find((x) => x.c.id === cmdId);
  if (!info) return [];
  return info.c.ports
    .map((p) => ({ port: p, owners: (row(p)?.owners ?? []).filter((o) => o.ownerCmdId !== cmdId) }))
    .filter((x) => x.owners.length > 0);
}
