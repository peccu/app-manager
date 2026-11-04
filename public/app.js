// App Manager UI（ビルド不要の素の JS）
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const shq = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");

let status = null;
let tab = "apps";
let editingId = null;
let log = null; // { cmdId, offset, timer }

// ---------- API ----------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "content-type": "application/json", "x-app-manager": "1", ...(opts.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error ?? res.statusText);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

function toast(msg, ms = 3500) {
  const t = $("#toast");
  t.textContent = msg;
  // popover はトップレイヤーに出るので、モーダルダイアログの上にも表示される（後から開いたものが上）
  if (t.matches(":popover-open")) t.hidePopover();
  t.showPopover();
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.hidePopover(), ms);
}

// ---------- 状態の取得と描画 ----------
async function refresh() {
  try {
    status = await api("/api/status");
    render();
  } catch (e) {
    $("#summary").innerHTML = `<span class="chip error">Cannot reach server</span>`;
  }
}

const STATUS_LABEL = {
  running: "Running",
  starting: "Working…",
  external: "Running (external)",
  stopped: "Stopped",
  exited: "Crashed",
};
const LEVEL_LABEL = { ok: "OK", info: "Note", warn: "Warning", error: "Conflict" };

function render() {
  if (!status) return;
  const { summary, docker, ports } = status;
  $("#summary").innerHTML = [
    `<span class="chip ok">Running ${summary.running}</span>`,
    summary.errors ? `<span class="chip error">Port conflicts ${summary.errors}</span>` : "",
    summary.warnings - summary.errors > 0 ? `<span class="chip warn">Port warnings ${summary.warnings - summary.errors}</span>` : "",
    docker.available ? `<span class="chip">Docker connected</span>` : `<span class="chip warn" title="${esc(docker.error)}">Docker unavailable</span>`,
  ].join("");
  $("#port-badge").innerHTML = summary.warnings ? `<span class="chip ${summary.errors ? "error" : "warn"}">${summary.warnings}</span>` : "";

  const problems = ports.filter((p) => p.level === "warn" || p.level === "error");
  const banner = $("#banner");
  if (problems.length) {
    banner.hidden = false;
    banner.className = `banner ${summary.errors ? "error" : ""}`;
    banner.innerHTML =
      `⚠ ${problems.length} port ${problems.length === 1 ? "issue" : "issues"}: ` +
      problems.map((p) => `<b>${p.port}</b>`).join(", ") +
      ` <button class="btn small" data-act="goto-ports" type="button">View ports</button>`;
  } else banner.hidden = true;

  if (tab === "apps") renderApps();
  else renderPorts();
}

function matchesFilter(text) {
  const q = $("#filter").value.trim().toLowerCase();
  return !q || text.toLowerCase().includes(q);
}

function cmdSummary(c) {
  if (c.type === "process") return c.command;
  const parts = ["docker compose"];
  if (c.composeFile) for (const f of c.composeFile.split(",")) parts.push("-f", f.trim());
  if (c.projectName) parts.push("-p", c.projectName);
  parts.push("up -d");
  if (c.build) parts.push("--build");
  return parts.join(" ");
}

function renderApps() {
  const el = $("#view-apps");
  const onlyRunning = $("#only-running").checked;
  if (!status.apps.length) {
    el.innerHTML = `<div class="empty">No apps registered yet.<br>Use “+ Add app” to register a folder and its start commands,<br>or open the Ports tab and register something that is already running.</div>`;
    return;
  }
  const html = status.apps
    .map((app) => {
      let cmds = app.commands;
      if (onlyRunning) cmds = cmds.filter((c) => c.status !== "stopped");
      const appText = [app.name, app.cwd, app.description, ...app.commands.map((c) => `${c.name} ${cmdSummary(c)} ${c.ports.join(" ")}`)].join(" ");
      if (!matchesFilter(appText) || (onlyRunning && !cmds.length)) return "";
      const rows = cmds.map((c) => cmdRow(app, c)).join("");
      return `<article class="app" data-app="${app.id}">
        <div class="app-head">
          <h2>${esc(app.name)}</h2>
          <span class="cwd" title="Folder">📁 ${esc(app.cwd)}</span>
          <button class="btn small" data-act="copy" data-text="${esc(`cd ${shq(app.cwd)}`)}" type="button">Copy cd</button>
          ${app.description ? `<span class="desc">${esc(app.description)}</span>` : ""}
          <div class="spacer"></div>
          <button class="btn small" data-act="edit" data-app="${app.id}" type="button">Edit</button>
        </div>
        ${
          app.commands.length
            ? `<table>
          <thead><tr><th style="width:150px">Status</th><th style="width:140px">Name</th><th>Command</th><th style="width:160px">Ports</th><th style="width:1%"></th></tr></thead>
          <tbody>${rows}</tbody></table>`
            : `<div class="empty">No start commands. Add one via “Edit”.</div>`
        }
      </article>`;
    })
    .join("");
  el.innerHTML = html || `<div class="empty">No apps match the filter.</div>`;
}

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function cmdRow(app, c) {
  const running = c.status === "running" || c.status === "starting";
  const busy = c.status === "starting";
  let sub = "";
  if (c.status === "running" && c.pid) sub = `PID ${c.pid} · since ${fmtTime(c.startedAt)}`;
  if (c.type === "compose" && c.containers.length)
    sub = c.containers.map((x) => `${esc(x.service ?? x.name)}: ${esc(x.status)}`).join("<br>");
  if (c.status === "external") sub = "A process in this folder is using the port (started from a terminal?)";
  if (c.lastExit && c.status !== "running" && c.type === "process")
    sub = `Last exit ${fmtTime(c.lastExit.at)} (${c.lastExit.signal ?? `code ${c.lastExit.code}`})`;
  const ports = c.portStates
    .map((p) => {
      const cls = [p.inUse ? "live" : "", p.level !== "ok" ? p.level : ""].join(" ");
      const title = [p.inUse ? "In use" : "Free", ...p.messages].join("\n");
      return `<a class="port ${cls}" href="http://localhost:${p.port}" target="_blank" rel="noopener" title="${esc(title)}">${p.level === "warn" || p.level === "error" ? "⚠ " : ""}${p.port}</a>`;
    })
    .join("");
  const full = `cd ${shq(app.cwd)} && ${cmdSummary(c)}`;
  return `<tr>
    <td data-label="Status"><span class="status ${c.status}"><span class="dot"></span>${STATUS_LABEL[c.status]}</span></td>
    <td data-label="Name">${esc(c.name)} <span class="type ${c.type}">${c.type === "compose" ? "compose" : "cmd"}</span></td>
    <td data-label="Command"><div class="cmdline">${esc(cmdSummary(c))}</div>${sub ? `<div class="sub">${sub}</div>` : ""}${c.note ? `<div class="sub">${esc(c.note)}</div>` : ""}</td>
    <td data-label="Ports">${ports || '<span class="muted">—</span>'}</td>
    <td class="actions">
      ${
        running
          ? `<button class="btn small stop" data-act="stop" data-cmd="${c.id}" ${busy ? "disabled" : ""} type="button">Stop</button>
             <button class="btn small" data-act="restart" data-cmd="${c.id}" ${busy ? "disabled" : ""} type="button">Restart</button>`
          : `<button class="btn small start" data-act="start" data-cmd="${c.id}" type="button">Start</button>`
      }
      <button class="btn small" data-act="logs" data-cmd="${c.id}" type="button">Logs</button>
      <button class="btn small" data-act="copy" data-text="${esc(full)}" title="${esc(full)}" type="button">Copy</button>
    </td>
  </tr>`;
}

function renderPorts() {
  const el = $("#view-ports");
  const cmdName = (id) => {
    for (const a of status.apps) for (const c of a.commands) if (c.id === id) return `${a.name} / ${c.name}`;
    return "";
  };
  const rows = status.ports
    .filter((r) => {
      const text = [r.port, ...r.declared.map((d) => `${d.appName} ${d.cmdName}`), ...r.owners.map((o) => `${o.label} ${o.cwd} ${o.command}`)].join(" ");
      if ($("#only-running").checked && !r.owners.length) return false;
      return matchesFilter(text);
    })
    .map((r) => {
      const declared = r.declared.length
        ? r.declared.map((d) => `<div>${esc(d.appName)} / ${esc(d.cmdName)}</div>`).join("")
        : `<span class="muted">(not registered)</span>`;
      const owners = r.owners.length
        ? r.owners
            .map((o, i) => {
              const managed = o.self
                ? `<span class="chip">App Manager</span> `
                : o.ownerCmdId
                  ? `<span class="chip ok">${esc(cmdName(o.ownerCmdId))}</span> `
                  : "";
              const kill =
                o.kind === "process" && !o.ownerCmdId && !o.self && o.pid
                  ? ` <button class="btn small danger" data-act="kill" data-pid="${o.pid}" data-label="${esc(o.label)}" type="button">Kill</button>`
                  : "";
              const register = canRegister(o)
                ? ` <button class="btn small primary" data-act="register" data-port="${r.port}" data-idx="${i}" type="button" title="Open the editor pre-filled with this process’s folder, command and ports">${o.sameApp ? "Add to app" : "Register as app"}</button>`
                : "";
              return `<div class="owner">${managed}${o.kind === "docker" ? "🐳" : "⚙️"} <b>${esc(o.label)}</b>${o.pid ? ` <span class="muted">PID ${o.pid}</span>` : ""}${register}${kill}
                ${o.cwd ? `<span class="cwd">📁 ${esc(o.cwd)}</span>` : ""}
                ${o.command ? `<span class="cwd" title="${esc(o.command)}">$ ${esc(o.command.length > 140 ? o.command.slice(0, 140) + "…" : o.command)}</span>` : ""}</div>`;
            })
            .join("")
        : `<span class="muted">Free</span>`;
      return `<tr class="${r.level}">
        <td data-label="Port"><a class="port ${r.owners.length ? "live" : ""}" href="http://localhost:${r.port}" target="_blank" rel="noopener">${r.port}</a></td>
        <td data-label="Level"><span class="level ${r.level}">${LEVEL_LABEL[r.level]}</span></td>
        <td data-label="Defined by">${declared}</td>
        <td data-label="Used by">${owners}</td>
        <td data-label="Notes">${r.messages.map((m) => `<div>${esc(m)}</div>`).join("")}</td>
      </tr>`;
    })
    .join("");
  el.innerHTML = `<p class="muted" style="margin:4px 0 10px">Ports defined by registered commands, together with every TCP port that is actually listening right now.</p>
    <table><thead><tr><th style="width:80px">Port</th><th style="width:80px">Level</th><th style="width:200px">Defined by</th><th>Used by (process / container)</th><th style="width:28%">Notes</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="5" class="empty">Nothing to show</td></tr>`}</tbody></table>`;
}

// ---------- 操作 ----------
async function startCmd(id, force = false) {
  try {
    await api(`/api/commands/${id}/start${force ? "?force=1" : ""}`, { method: "POST" });
    toast("Started");
  } catch (e) {
    if (e.status === 409 && e.body?.conflicts) {
      const detail = e.body.conflicts
        .map((c) => `• ${c.port}: ${c.owners.map((o) => `${o.label}${o.pid ? ` (PID ${o.pid})` : ""}${o.cwd ? ` @ ${o.cwd}` : ""}`).join(", ")}`)
        .join("\n");
      if (confirm(`These ports are already in use:\n\n${detail}\n\nStart anyway?`)) return startCmd(id, true);
      return;
    }
    toast(`Failed to start: ${e.message}`);
  }
  refresh();
}

document.addEventListener("click", async (ev) => {
  const btn = ev.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  const id = btn.dataset.cmd;
  try {
    if (act === "start") await startCmd(id);
    else if (act === "stop") {
      btn.disabled = true;
      await api(`/api/commands/${id}/stop`, { method: "POST" });
      toast("Stopped");
    } else if (act === "restart") {
      btn.disabled = true;
      await api(`/api/commands/${id}/restart`, { method: "POST" });
      toast("Restarted");
    } else if (act === "logs") openLog(id);
    else if (act === "copy") {
      await navigator.clipboard.writeText(btn.dataset.text);
      toast(`Copied:\n${btn.dataset.text}`);
    } else if (act === "edit") openEditor(btn.dataset.app);
    else if (act === "goto-ports") switchTab("ports");
    else if (act === "kill") {
      if (!confirm(`Send SIGTERM to ${btn.dataset.label} (PID ${btn.dataset.pid})?`)) return;
      await api(`/api/kill/${btn.dataset.pid}`, { method: "POST" });
      toast("SIGTERM sent");
    } else if (act === "remove") btn.closest(".cmd-edit").remove();
    else if (act === "suggest") {
      const sug = JSON.parse(btn.dataset.s);
      const node = addCmdEditor(sug);
      node.scrollIntoView({ block: "nearest", behavior: "smooth" });
      node.classList.add("flash");
      btn.disabled = true;
      btn.firstChild.textContent = "✓ Added ";
      toast(`Added command “${sug.name}” (click Save to keep it)`);
    }
    else if (act === "register") {
      const row = status.ports.find((r) => r.port === Number(btn.dataset.port));
      const owner = row?.owners[Number(btn.dataset.idx)];
      if (owner) openRegister(owner);
    }
    else return;
  } catch (e) {
    toast(`Error: ${e.message}`);
  }
  if (["stop", "restart", "kill"].includes(act)) refresh();
});

function switchTab(t) {
  tab = t;
  document.querySelectorAll(".tab").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === t);
    b.setAttribute("aria-selected", String(b.dataset.tab === t));
  });
  $("#view-apps").hidden = t !== "apps";
  $("#view-ports").hidden = t !== "ports";
  render();
}
document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));
$("#filter").addEventListener("input", render);
$("#only-running").addEventListener("change", render);

// ---------- ログ ----------
function openLog(cmdId) {
  closeLog();
  const app = status.apps.find((a) => a.commands.some((c) => c.id === cmdId));
  const cmd = app.commands.find((c) => c.id === cmdId);
  $("#log-title").textContent = `${app.name} / ${cmd.name}`;
  $("#log-sub").textContent = cmd.type === "compose" ? "(docker compose output + container logs)" : app.cwd;
  $("#log-body").textContent = "";
  $("#log-panel").hidden = false;
  log = { cmdId, offset: undefined, replace: false };
  const tick = async () => {
    if (!log || log.cmdId !== cmdId) return;
    try {
      const q = log.offset !== undefined && !log.replace ? `?since=${log.offset}` : "";
      const r = await api(`/api/commands/${cmdId}/logs${q}`);
      const body = $("#log-body");
      const text = stripAnsi(r.text);
      if (r.mode === "replace") {
        log.replace = true;
        if (body.textContent !== text) body.textContent = text;
      } else if (text) body.textContent += text;
      log.offset = r.offset;
      if (body.textContent.length > 400_000) body.textContent = body.textContent.slice(-300_000);
      if ($("#log-follow").checked) body.scrollTop = body.scrollHeight;
    } catch {}
    if (log && log.cmdId === cmdId) log.timer = setTimeout(tick, log.replace ? 3000 : 1000);
  };
  tick();
}
function closeLog() {
  if (log?.timer) clearTimeout(log.timer);
  log = null;
  $("#log-panel").hidden = true;
}
$("#log-close").addEventListener("click", closeLog);
$("#log-clear").addEventListener("click", async () => {
  if (!log) return;
  await api(`/api/commands/${log.cmdId}/logs`, { method: "DELETE" });
  $("#log-body").textContent = "";
  log.offset = 0;
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#dlg-app").open && log) closeLog();
});

// ---------- アプリ編集 ----------
const dlg = $("#dlg-app");
const form = $("#form-app");

function addCmdEditor(c = { type: "process", ports: [] }) {
  const node = $("#tpl-cmd").content.firstElementChild.cloneNode(true);
  node.dataset.id = c.id ?? "";
  node.dataset.type = c.type;
  const set = (k, v) => {
    const el = node.querySelector(`[data-k="${k}"]`);
    if (el.type === "checkbox") el.checked = !!v;
    else el.value = v ?? "";
  };
  set("name", c.name);
  set("type", c.type);
  set("ports", (c.ports ?? []).join(", "));
  set("command", c.command);
  set("composeFile", c.composeFile);
  set("projectName", c.projectName);
  set("build", c.build);
  set("env", Object.entries(c.env ?? {}).map(([k, v]) => `${k}=${v}`).join("\n"));
  node.querySelector('[data-k="type"]').addEventListener("change", (e) => (node.dataset.type = e.target.value));
  $("#cmd-list").append(node);
  return node;
}

function openEditor(appId) {
  editingId = appId ?? null;
  const app = appId ? status.apps.find((a) => a.id === appId) : null;
  $("#dlg-title").textContent = app ? `Edit app: ${app.name}` : "Add app";
  form.reset();
  form.name.value = app?.name ?? "";
  form.cwd.value = app?.cwd ?? "";
  form.description.value = app?.description ?? "";
  $("#cmd-list").innerHTML = "";
  $("#suggestions").innerHTML = "";
  $("#form-error").textContent = "";
  $("#btn-delete-app").hidden = !app;
  for (const c of app?.commands ?? []) addCmdEditor(c);
  dlg.showModal();
  form.name.focus();
}

// ---------- ポート一覧からの登録 ----------
// 登録外で動いているプロセス / compose コンテナを、起動フォルダ・コマンド・ポートを入力済みにして登録画面に渡す
// cwd が "/" のものは OS のデーモン（ControlCenter など）なので対象外
const canRegister = (o) =>
  !o.ownerCmdId && !o.self && !!o.cwd && o.cwd !== "/" && (o.kind === "process" ? !!o.pid : !!o.project);

const basename = (p) => p.replace(/\/+$/, "").split("/").pop() || p;
const relTo = (file, dir) => (file.startsWith(dir + "/") ? file.slice(dir.length + 1) : file);
const normalizeProject = (s) => s.toLowerCase().replace(/[^a-z0-9_-]/g, "");

function draftFromOwner(o) {
  // 同じプロセス / 同じ compose プロジェクトが使っている全ポートをまとめる
  const same = (x) =>
    o.kind === "process" ? x.kind === "process" && x.pid === o.pid : x.kind === "docker" && x.project === o.project && x.cwd === o.cwd;
  const ports = status.ports.filter((r) => r.owners.some(same)).map((r) => r.port);
  if (o.kind === "process") {
    return { name: "dev", type: "process", command: o.command ?? o.label, ports };
  }
  const files = (o.configFiles ?? []).map((f) => relTo(f, o.cwd));
  const isDefault = files.length === 1 && /^(docker-)?compose\.ya?ml$/.test(files[0]);
  return {
    name: "compose",
    type: "compose",
    composeFile: isDefault ? "" : files.join(", "),
    projectName: o.project !== normalizeProject(basename(o.cwd)) ? o.project : "",
    ports,
  };
}

function openRegister(o) {
  const draft = draftFromOwner(o);
  const existing = status.apps.find((a) => a.id === o.sameApp);
  if (existing) {
    openEditor(existing.id);
  } else {
    openEditor();
    form.cwd.value = o.cwd ?? "";
    form.name.value = o.cwd ? basename(o.cwd) : o.label;
  }
  const node = addCmdEditor(draft);
  node.scrollIntoView({ block: "nearest" });
  node.querySelector('[data-k="name"]').focus();
  $("#form-error").textContent = o.cwd
    ? ""
    : "Could not detect the working folder. Please enter it.";
  if (o.kind === "process") {
    node.insertAdjacentHTML(
      "afterbegin",
      `<p class="sub" style="margin:0">Pre-filled from the running process’s command line. Replacing it with the original command (e.g. <code>bun run dev</code>) makes it easier to manage — see the suggestions above.</p>`,
    );
  }
  if (o.cwd) inspectFolder();
}

function readForm() {
  const commands = [...document.querySelectorAll("#cmd-list .cmd-edit")].map((node) => {
    const v = (k) => node.querySelector(`[data-k="${k}"]`);
    const env = {};
    for (const line of v("env").value.split("\n")) {
      const i = line.indexOf("=");
      if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return {
      id: node.dataset.id || undefined,
      name: v("name").value,
      type: v("type").value,
      ports: v("ports").value,
      command: v("command").value,
      composeFile: v("composeFile").value,
      projectName: v("projectName").value,
      build: v("build").checked,
      env,
    };
  });
  return { name: form.name.value, cwd: form.cwd.value, description: form.description.value, commands };
}

form.addEventListener("submit", async (e) => {
  if (e.submitter?.value !== "save") return;
  e.preventDefault();
  try {
    const body = JSON.stringify(readForm());
    if (editingId) await api(`/api/apps/${editingId}`, { method: "PUT", body });
    else await api("/api/apps", { method: "POST", body });
    dlg.close();
    toast("Saved");
    refresh();
  } catch (err) {
    $("#form-error").textContent = err.message;
  }
});

$("#btn-add").addEventListener("click", () => openEditor());
$("#btn-add-cmd").addEventListener("click", () => addCmdEditor({ type: "process", ports: [] }).querySelector("input").focus());
$("#btn-add-compose").addEventListener("click", () => addCmdEditor({ type: "compose", name: "compose", ports: [] }).querySelector("input").focus());
$("#btn-delete-app").addEventListener("click", async () => {
  if (!editingId || !confirm("Remove this app? (Running processes are not stopped.)")) return;
  await api(`/api/apps/${editingId}`, { method: "DELETE" });
  dlg.close();
  refresh();
});
$("#btn-inspect").addEventListener("click", () => inspectFolder());
async function inspectFolder() {
  const btn = $("#btn-inspect");
  const box = $("#suggestions");
  const cwd = form.cwd.value.trim();
  if (!cwd) {
    box.innerHTML = `<span class="error">Enter a folder (absolute path) first</span>`;
    form.cwd.focus();
    return;
  }
  btn.disabled = true;
  btn.textContent = "Inspecting…";
  box.innerHTML = `<span class="muted">Inspecting ${esc(cwd)}…</span>`;
  try {
    const r = await api(`/api/inspect?cwd=${encodeURIComponent(cwd)}`);
    console.info("[inspect]", cwd, r);
    if (!r.exists) {
      box.innerHTML = `<span class="error">Folder not found: ${esc(cwd)}</span>`;
      return;
    }
    if (!form.name.value) form.name.value = r.name;
    const checked = r.found?.length
      ? `<span class="muted">Checked: ${r.found.map(esc).join(", ")}</span>`
      : r.found
        ? `<span class="muted">No package.json, compose*.yml, manage.py or main.py found.</span>`
        : "";
    box.innerHTML = r.suggestions.length
      ? `<span class="muted">✓ Found ${r.suggestions.length} ${r.suggestions.length === 1 ? "suggestion" : "suggestions"} (click to add):</span>` +
        r.suggestions
          .map(
            (s) =>
              `<button class="btn small suggestion" type="button" data-act="suggest" data-s="${esc(JSON.stringify(s))}" title="${esc(s.source)}">+ ${esc(s.name)} <span class="muted">${esc(s.command ?? s.composeFile ?? "compose.yml")}${s.ports.length ? ` :${s.ports.join(",")}` : ""}</span></button>`,
          )
          .join("") +
        `<div class="sub" style="width:100%">${checked}</div>`
      : `<span class="muted">No suggestions found. Add a command manually with “+ Command”.</span><div class="sub" style="width:100%">${checked}</div>`;
  } catch (e) {
    console.error("[inspect]", e);
    box.innerHTML = `<span class="error">Inspection failed: ${esc(e.message)}</span>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Inspect folder";
  }
}

refresh();
setInterval(() => {
  if (!document.hidden) refresh();
}, 3000);
