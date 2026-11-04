// OS とDocker から「いま実際に動いているもの」を集める
// - lsof: LISTEN 中の TCP ポートと PID / プロセス名
// - ps:   PGID とコマンドライン（管理下のプロセスか判定するため）
// - lsof -d cwd: プロセスのカレントディレクトリ（どのフォルダで起動したか）
// - docker ps: コンテナと公開ポート、compose ラベル
import { run } from "./exec";

export interface Listener {
  kind: "process";
  port: number;
  pid: number;
  pgid?: number;
  process: string;
  command?: string;
  cwd?: string;
  address: string;
}

export interface Container {
  id: string;
  name: string;
  image: string;
  state: string; // running / exited / ...
  status: string;
  ports: number[];
  project?: string;
  workingDir?: string;
  configFiles: string[];
  service?: string;
}

export interface Snapshot {
  at: number;
  listeners: Listener[];
  containers: Container[];
  dockerAvailable: boolean;
  dockerError?: string;
}

async function scanListeners(): Promise<Listener[]> {
  const res = await run(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"]);
  // lsof は該当なしでも exit 1 を返すことがあるので stdout だけ見る
  const out: Listener[] = [];
  const seen = new Set<string>();
  let pid = 0;
  let name = "";
  for (const line of res.stdout.split("\n")) {
    const tag = line[0];
    const val = line.slice(1);
    if (tag === "p") pid = Number(val);
    else if (tag === "c") name = val;
    else if (tag === "n") {
      const idx = val.lastIndexOf(":");
      const port = Number(val.slice(idx + 1));
      if (!Number.isFinite(port) || port <= 0) continue;
      const key = `${pid}:${port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: "process", port, pid, process: name, address: val.slice(0, idx) });
    }
  }
  if (out.length === 0) return out;

  const pids = [...new Set(out.map((l) => l.pid))];
  const [ps, cwd] = await Promise.all([
    run(["ps", "-o", "pid=,pgid=,command=", "-p", pids.join(",")]),
    run(["lsof", "-a", "-d", "cwd", "-p", pids.join(","), "-Fpn"]),
  ]);
  const psMap = new Map<number, { pgid: number; command: string }>();
  for (const line of ps.stdout.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (m) psMap.set(Number(m[1]), { pgid: Number(m[2]), command: m[3]! });
  }
  const cwdMap = new Map<number, string>();
  let cur = 0;
  for (const line of cwd.stdout.split("\n")) {
    if (line[0] === "p") cur = Number(line.slice(1));
    else if (line[0] === "n") cwdMap.set(cur, line.slice(1));
  }
  for (const l of out) {
    const p = psMap.get(l.pid);
    l.pgid = p?.pgid;
    l.command = p?.command;
    l.cwd = cwdMap.get(l.pid);
  }
  return out.sort((a, b) => a.port - b.port);
}

function parseLabels(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  // "a=b,c=d" 形式。値にカンマを含む config_files があるため key= の出現位置で分割する
  const re = /(?:^|,)([\w.\-\/]+)=/g;
  const marks: { key: string; start: number; valStart: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) marks.push({ key: m[1]!, start: m.index, valStart: re.lastIndex });
  marks.forEach((mk, i) => {
    const end = i + 1 < marks.length ? marks[i + 1]!.start : s.length;
    out[mk.key] = s.slice(mk.valStart, end);
  });
  return out;
}

async function scanContainers(): Promise<{ containers: Container[]; ok: boolean; error?: string }> {
  const res = await run(["docker", "ps", "-a", "--no-trunc", "--format", "{{json .}}"], { timeoutMs: 4000 });
  if (!res.ok) return { containers: [], ok: false, error: (res.stderr || "docker is not available").trim() };
  const containers: Container[] = [];
  for (const line of res.stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      const labels = parseLabels(j.Labels ?? "");
      const ports = [...String(j.Ports ?? "").matchAll(/:(\d+)->/g)].map((x) => Number(x[1]));
      containers.push({
        id: String(j.ID).slice(0, 12),
        name: j.Names,
        image: j.Image,
        state: j.State,
        status: j.Status,
        ports: [...new Set(ports)],
        project: labels["com.docker.compose.project"],
        workingDir: labels["com.docker.compose.project.working_dir"],
        configFiles: (labels["com.docker.compose.project.config_files"] ?? "").split(",").filter(Boolean),
        service: labels["com.docker.compose.service"],
      });
    } catch {
      /* ignore */
    }
  }
  return { containers, ok: true };
}

let cache: Snapshot | undefined;
let inflight: Promise<Snapshot> | undefined;

/** 2 秒間キャッシュしたシステムのスナップショットを返す */
export async function snapshot(force = false): Promise<Snapshot> {
  if (!force && cache && Date.now() - cache.at < 2000) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    const [listeners, docker] = await Promise.all([scanListeners(), scanContainers()]);
    cache = {
      at: Date.now(),
      listeners,
      containers: docker.containers,
      dockerAvailable: docker.ok,
      dockerError: docker.error,
    };
    return cache;
  })().finally(() => (inflight = undefined));
  return inflight;
}

/** Docker のポートフォワーダー（ホスト側で LISTEN しているだけのプロセス）か */
export const isDockerForwarder = (name: string) =>
  /docker|vpnkit|lima|colima|orbstack|rancher|podman|gvproxy|^ssh$/i.test(name);

/** 起動・停止の直後に古い状態を返さないようキャッシュを捨てる */
export const invalidate = () => {
  cache = undefined;
};
