// 外部コマンドをタイムアウト付きで実行して stdout を返す小さなヘルパー
export async function run(
  argv: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null }> {
  try {
    const proc = Bun.spawn(argv, {
      cwd: opts.cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const timer = setTimeout(() => proc.kill(), opts.timeoutMs ?? 5000);
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    return { ok: code === 0, stdout, stderr, code };
  } catch (e) {
    return { ok: false, stdout: "", stderr: String(e), code: null };
  }
}
