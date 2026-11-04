// フォルダを調べて起動コマンドの候補を提案する（package.json の scripts / compose ファイル など）
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

export interface Suggestion {
  name: string;
  type: "process" | "compose";
  command?: string;
  composeFile?: string;
  ports: number[];
  source: string;
}

const PORT_PATTERNS = [
  /--port[= ](\d{2,5})/g,
  /\bPORT=(\d{2,5})/g,
  /(?:^|\s)-p\s+(\d{2,5})\b/g,
  /localhost:(\d{2,5})/g,
  /0\.0\.0\.0:(\d{2,5})/g,
];

function guessPorts(s: string): number[] {
  const ports = new Set<number>();
  for (const re of PORT_PATTERNS) for (const m of s.matchAll(re)) ports.add(Number(m[1]));
  return [...ports].filter((p) => p > 0 && p < 65536);
}

function composePorts(text: string): number[] {
  const ports = new Set<number>();
  try {
    const doc = Bun.YAML.parse(text) as any;
    for (const svc of Object.values<any>(doc?.services ?? {})) {
      for (const p of svc?.ports ?? []) {
        if (typeof p === "object" && p?.published) ports.add(Number(p.published));
        else {
          // "8080:80", "127.0.0.1:8080:80", "3000"
          const parts = String(p).split("/")[0]!.split(":");
          const host = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
          const n = Number(String(host).split("-")[0]);
          if (n) ports.add(n);
        }
      }
    }
  } catch {
    for (const m of text.matchAll(/["'\s-](\d{2,5}):\d{2,5}/g)) ports.add(Number(m[1]));
  }
  return [...ports];
}

function packageManager(dir: string): string {
  if (existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb"))) return "bun";
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn";
  return "npm";
}

export function inspectDir(dir: string) {
  if (!existsSync(dir)) return { exists: false, suggestions: [] as Suggestion[] };
  if (!statSync(dir).isDirectory()) return { exists: false, suggestions: [] as Suggestion[] };
  const suggestions: Suggestion[] = [];
  const files = readdirSync(dir);

  if (files.includes("package.json")) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      const pm = packageManager(dir);
      const preferred = ["dev", "start", "serve", "preview", "watch"];
      const scripts = Object.entries<string>(pkg.scripts ?? {}).filter(
        ([k]) => preferred.includes(k) || /dev|start|serve/.test(k),
      );
      for (const [k, v] of scripts) {
        suggestions.push({
          name: k,
          type: "process",
          command: `${pm} run ${k}`,
          ports: guessPorts(v),
          source: `package.json: ${v}`,
        });
      }
    } catch {}
  }

  const composeFiles = files.filter((f) => /^(docker-)?compose([.-][\w-]+)?\.ya?ml$/.test(f)).sort();
  for (const f of composeFiles) {
    const text = readFileSync(join(dir, f), "utf8");
    const isDefault = /^(docker-)?compose\.ya?ml$/.test(f);
    suggestions.push({
      name: isDefault ? "compose" : `compose (${f.replace(/^(docker-)?compose[.-]?|\.ya?ml$/g, "") || f})`,
      type: "compose",
      composeFile: isDefault ? undefined : f,
      ports: composePorts(text),
      source: f,
    });
  }

  if (files.includes("manage.py")) {
    suggestions.push({ name: "django", type: "process", command: "python manage.py runserver 8000", ports: [8000], source: "manage.py" });
  }
  if (files.includes("pyproject.toml") || files.includes("requirements.txt")) {
    const main = ["main.py", "app.py"].find((f) => files.includes(f));
    if (main) {
      const src = readFileSync(join(dir, main), "utf8");
      if (/FastAPI\(/.test(src))
        suggestions.push({ name: "uvicorn", type: "process", command: `uvicorn ${main.replace(".py", "")}:app --reload --port 8000`, ports: [8000], source: main });
      else suggestions.push({ name: "python", type: "process", command: `python ${main}`, ports: guessPorts(src), source: main });
    }
  }

  const found = files.filter(
    (f) => f === "package.json" || f === "manage.py" || f === "pyproject.toml" || f === "requirements.txt" || composeFiles.includes(f),
  );
  return { exists: true, name: basename(dir), found, suggestions };
}
