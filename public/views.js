/* Views for the middle panel: Overview, Agents, Tasks, Runs, Approvals, Activity, Notifications.
   Each renders from the API into a root element; app.js wires clicks and live updates. */
(() => {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const icon = (name, cls = "") => `<svg class="ic ${cls}"><use href="#i-${name}"/></svg>`;
  const rel = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d)) return "";
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 0) return `in ${Math.round(-diff / 60)} min`;
    if (diff < 60) return "just now";
    if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
    if (diff < 86400 * 14) return `${Math.floor(diff / 86400)} d ago`;
    return d.toLocaleDateString();
  };
  const clock = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); };
  const when = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); };
  const dur = (from, to) => {
    const a = new Date(from).getTime(); const b = to ? new Date(to).getTime() : Date.now();
    if (isNaN(a) || isNaN(b)) return "";
    const s = Math.max(0, Math.round((b - a) / 1000));
    return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  };
  const statusCls = (s) => ({ success: "ok", failed: "bad", needs_attention: "warn", running: "run", cancelled: "", unknown: "" })[s] || "";
  const statusLabel = (s) => ({ success: "completed", failed: "failed", needs_attention: "needs you", running: "running", cancelled: "stopped", unknown: "unknown" })[s] || s || "";
  const kindLabel = (k) => ({ chat: "message", dispatch: "instruction", sync: "look", action: "action", task: "task", external: "reported", discovered: "captured", email: "email" })[k] || k;
  const empty = (title, body) => `<div class="view-empty"><strong>${esc(title)}</strong>${body ? `<span>${esc(body)}</span>` : ""}</div>`;

  const runRow = (r, { showAgent = true } = {}) => `<div class="lrow run-row s-${statusCls(r.status)}" data-open-run="${r.id}">
      <span class="dot ${statusCls(r.status)}"></span>
      <div class="body">
        <div class="title">${esc(r.label ?? r.task_name ?? r.kind)} <span class="muted">· ${esc(r.provider_name ?? r.provider ?? "control plane")}</span>${showAgent && r.agent_name ? ` <span class="muted">· ${esc(r.agent_name)}</span>` : ""}</div>
        <div class="sub">${r.status === "running" ? `${esc(r.current_step ?? "working")} · <span class="elapsed" data-since="${esc(r.started_at ?? r.created_at)}"></span>` : `${esc(statusLabel(r.status))}${r.summary ? " · " + esc(String(r.summary).slice(0, 140)) : r.error ? " · " + esc(String(r.error).slice(0, 140)) : ""} · ${rel(r.finished_at ?? r.started_at ?? r.created_at)}${r.started_at && r.finished_at ? ` · ${dur(r.started_at, r.finished_at)}` : ""}`}</div>
      </div>
      <span class="badge">${esc(kindLabel(r.kind))}</span>
      ${r.status === "running" ? `<button class="btn xs ghost" data-stop-run="${r.id}" title="Stop this run">${icon("stop", "sm")}</button>` : ""}
      ${r.output_url ? `<a class="btn xs ghost" href="${esc(r.output_url)}" target="_blank" rel="noopener" title="Open the result">${icon("popout", "sm")}</a>` : ""}
    </div>`;

  const attentionRow = (x, ctx) => {
    const local = x.action === "connect" && ctx?.conn?.(x.platform)?.signInMode === "local";
    const act = x.action === "decide" ? `<button class="btn small" data-approve-id="${x.id}" data-decision="reject">Reject</button><button class="btn small primary" data-approve-id="${x.id}" data-decision="approve">${icon("check", "sm")} Approve</button>`
      : x.action === "connect" ? `<button class="btn small primary" data-connect="${esc(x.platform)}">${local ? "Connect from this computer" : "Sign in"}</button>`
      : x.action === "open_chat" ? `<button class="btn small" data-nav="chat">Open command</button>`
      : x.action === "dismiss" ? `<button class="btn small ghost" data-read="${x.id}">Dismiss</button>` : "";
    return `<div class="notice ${x.kind === "approval" ? "warn" : x.kind === "session" ? "warn" : "bad"}"><div class="body"><strong>${esc(x.title)}</strong>${x.body ? `<div class="sub">${esc(String(x.body).slice(0, 200))}</div>` : ""}</div>${x.link ? `<a class="btn small" target="_blank" rel="noopener" href="${esc(x.link)}">Open</a>` : ""}${act}</div>`;
  };

  const V = {
    async overview(root, ctx) {
      const o = await ctx.api("/overview");
      ctx.overview = o;
      const c = o.counts;
      const tile = (n, label, cls = "", nav = "") => `<a class="stat ${cls}" ${nav ? `href="#${nav}" data-nav="${nav}"` : ""}><b>${n}</b><span>${esc(label)}</span></a>`;
      root.innerHTML = `
        <div class="stat-tiles">
          ${tile(c.agents, c.agents === 1 ? "agent active" : "agents active", "", "agents")}
          ${tile(c.running, c.running === 1 ? "task running" : "tasks running", c.running ? "run" : "", "runs")}
          ${tile(c.awaiting_approval, "awaiting approval", c.awaiting_approval ? "warn" : "", "approvals")}
          ${tile(c.failed_today, "failed today", c.failed_today ? "bad" : "", "runs")}
          ${tile(c.completed_today, "completed today", c.completed_today ? "ok" : "", "runs")}
          ${tile(c.scheduled, "scheduled", "", "tasks")}
        </div>
        <section class="vsec"><h3>Currently running</h3>${o.running.length ? `<div class="list">${o.running.map((r) => runRow(r)).join("")}</div>` : empty("Nothing is running", "Runs appear here the moment an agent starts working.")}</section>
        <section class="vsec"><h3>Requires attention</h3>${o.attention.length ? `<div class="attention">${o.attention.map((x) => attentionRow(x, ctx)).join("")}</div>` : empty("All quiet", "Nothing needs you right now.")}</section>
        ${o.upcoming.length ? `<section class="vsec"><h3>Coming up</h3><div class="list">${o.upcoming.map((t) => `<div class="lrow" data-open-task="${t.id}"><span class="dot"></span><div class="body"><div class="title">${esc(t.name)} <span class="muted">· ${esc(t.provider_name)}</span></div><div class="sub">next ${esc(when(t.next_run))}${t.schedule ? ` · ${esc(t.schedule)}` : ""}</div></div></div>`).join("")}</div></section>` : ""}
        <section class="vsec"><h3>Recent</h3>${o.recent.length ? `<div class="list">${o.recent.map((r) => runRow(r)).join("")}</div>` : empty("No runs yet", "Once your agents do something, it shows up here.")}</section>
        <p class="muted small vfoot">Providers: ${o.providers.map((p) => `${esc(p.name)} ${p.status === "logged_in" ? "connected" : p.status === "needs_login" ? "signed out" : p.kind === "custom" ? "via API" : "not connected"}`).join(" · ")}</p>`;
    },

    async agents(root, ctx) {
      const all = await ctx.api("/agents?all=1");
      const filter = ctx.filter;
      const agents = filter ? all.filter((a) => a.kind === filter || a.provider_id === filter) : all;
      const kinds = [["assistant", "Provider assistants"], ["custom", "Your own agents"], ["system", "Control plane"]];
      root.innerHTML = `<div class="vhead"><span class="muted small">${agents.length} agent${agents.length === 1 ? "" : "s"}${filter ? ` · filtered by ${esc(filter)} <button class="btn xs ghost" data-filter-clear>clear</button>` : ""}</span></div>` +
        (agents.length ? kinds.map(([k, label]) => {
          const list = agents.filter((a) => a.kind === k);
          if (!list.length) return "";
          return `<section class="vsec"><h3>${label}</h3><div class="cards">${list.map((a) => `<article class="card ${a.status !== "active" ? "dim" : ""}" data-open-agent="${a.id}">
            <div class="head"><span class="avatar ${esc(a.provider_id ?? "system")}">${a.kind === "system" ? icon("agents", "sm") : esc(a.name.slice(0, 1))}</span><div class="info"><div class="name">${esc(a.name)}</div><div class="sub">${a.provider_id ? esc(ctx.aiName(a.provider_id)) : "control plane"} · ${esc(a.status)}</div></div>${a.running ? `<span class="badge run">${a.running} running</span>` : ""}</div>
            ${a.description ? `<p class="desc">${esc(a.description)}</p>` : ""}
            <div class="kv"><span>Tasks</span><b>${a.task_count}</b><span>Last run</span><b>${a.last_run_at ? esc(rel(a.last_run_at)) : "never"}</b></div>
            ${a.capabilities ? `<div class="chips">${JSON.parse(a.capabilities).slice(0, 8).map((c) => `<span class="chip static">${esc(c)}</span>`).join("")}</div>` : ""}
            <div class="card-detail" id="agent-detail-${a.id}" hidden></div>
          </article>`).join("")}</div></section>`;
        }).join("") : empty("No agents yet", "Sign in to a provider, or register one of your own through the API."));
    },

    async agentDetail(el, id, ctx) {
      const a = await ctx.api(`/agents/${id}`);
      el.innerHTML = `<h4>Tasks</h4>${a.tasks.length ? `<div class="list compact">${a.tasks.map((t) => `<div class="lrow" data-open-task="${t.id}"><div class="body"><div class="title">${esc(t.name)}</div><div class="sub">${t.schedule ? esc(t.schedule) + " · " : ""}${t.last_run ? esc(statusLabel(t.last_run.status)) + " " + esc(rel(t.last_run.finished_at ?? t.last_run.started_at)) : "no runs yet"}</div></div></div>`).join("")}</div>` : `<p class="muted small">No tasks attached.</p>`}
        <h4>Recent runs</h4>${a.runs.length ? `<div class="list compact">${a.runs.slice(0, 8).map((r) => runRow({ ...r, provider_name: ctx.aiName(r.provider) }, { showAgent: false })).join("")}</div>` : `<p class="muted small">No runs yet.</p>`}`;
    },

    async tasks(root, ctx) {
      const tasks = await ctx.api("/tasks?all=1");
      if (!tasks.length) return (root.innerHTML = empty("No tasks known yet", "They appear when the control plane looks at each provider's tasks page, or when your agents register them."));
      const byProvider = new Map();
      for (const t of tasks) byProvider.set(t.provider.id, [...(byProvider.get(t.provider.id) ?? []), t]);
      root.innerHTML = `<div class="vhead"><span class="muted small">${tasks.length} task${tasks.length === 1 ? "" : "s"} across ${byProvider.size} provider${byProvider.size === 1 ? "" : "s"}</span><span class="spacer"></span><button class="btn xs ghost" data-sync-all title="Look at every provider's tasks page now">${icon("reload", "sm")} Refresh from providers</button></div>` +
        [...byProvider.entries()].map(([pid, list]) => `<section class="vsec"><h3>${esc(list[0].provider.name)} <span class="muted">${list.length}</span></h3><div class="list">${list.map((t) => `<div class="lrow task-row ${t.enabled ? "" : "dim"}" data-open-task="${t.id}">
          <span class="dot ${t.current_run ? "run" : t.last_run ? statusCls(t.last_run.status) : ""}"></span>
          <div class="body">
            <div class="title">${esc(t.name)}${t.agent ? ` <span class="muted">· ${esc(t.agent.name)}</span>` : ""}${t.enabled ? "" : ` <span class="badge">paused here</span>`}</div>
            <div class="sub">${t.schedule ? esc(t.schedule) + " · " : ""}${t.next_run ? "next " + esc(when(t.next_run)) + " · " : ""}${t.current_run ? `running: ${esc(t.current_run.label ?? "")} <span class="elapsed" data-since="${esc(t.current_run.started_at)}"></span>` : t.last_run ? `last ${esc(statusLabel(t.last_run.status))} ${esc(rel(t.last_run.finished_at ?? t.last_run.started_at))}${t.result ? " · " + esc(String(t.result).slice(0, 100)) : ""}` : "no runs yet"}</div>
            <div class="task-detail" id="task-detail-${t.id}" hidden></div>
          </div>
          <span class="history">${(t.recent_statuses ?? []).slice(0, 6).map((s) => `<i class="hdot ${statusCls(s)}" title="${esc(statusLabel(s))}"></i>`).join("")}</span>
          ${t.can.run ? `<button class="btn xs" data-run-task="${t.id}" title="Start it now">${icon("play", "sm")} Run</button>` : `<button class="btn xs ghost" disabled title="${esc(t.can.run_reason ?? "")}">${icon("play", "sm")} Run</button>`}
          <details class="menu"><summary class="btn icon ghost" style="width:24px;height:24px" aria-label="More">${icon("more", "sm")}</summary><div class="menu-list">
            ${t.native_url ? `<a class="btn small" href="${esc(t.native_url)}" target="_blank" rel="noopener">${icon("popout", "sm")} Open at ${esc(t.provider.name)}</a>` : ""}
            ${t.enabled ? `<button class="btn small" data-pause-task="${t.id}">${icon("pause", "sm")} Pause tracking here</button>` : `<button class="btn small" data-resume-task="${t.id}">${icon("play", "sm")} Resume tracking</button>`}
            ${t.can.pause_at_provider ? "" : `<div class="menu-note">${esc(t.can.unsupported.pause_at_provider ?? "")}</div>`}
          </div></details>
        </div>`).join("")}</div></section>`).join("");
    },

    async taskDetail(el, id, ctx) {
      const t = await ctx.api(`/tasks/${id}`);
      el.innerHTML = `<div class="kv wide">${t.prompt || t.purpose ? `<span>Prompt</span><b>${esc((t.prompt || t.purpose).slice(0, 400))}</b>` : ""}<span>Source</span><b>${esc(t.source)}</b><span>Key</span><b class="mono">${esc(t.key)}</b>${t.error ? `<span>Last error</span><b>${esc(t.error)}</b>` : ""}${!t.can.run && t.can.run_reason ? `<span>Start from here</span><b>${esc(t.can.run_reason)}</b>` : ""}</div>
        ${t.runs.length ? `<div class="list compact">${t.runs.slice(0, 10).map((r) => runRow({ ...r, provider_name: t.provider.name }, { showAgent: false })).join("")}</div>` : ""}`;
    },

    async runs(root, ctx) {
      const filter = ctx.filter;
      const runs = await ctx.api(`/runs?limit=80${filter ? `&status=${encodeURIComponent(filter)}` : ""}`);
      const list = runs.map((r) => ({ ...r, provider_name: ctx.aiName(r.provider) }));
      const running = list.filter((r) => r.status === "running");
      const rest = list.filter((r) => r.status !== "running");
      root.innerHTML = `<div class="vhead"><div class="seg">${[["", "All"], ["running", "Running"], ["failed,needs_attention", "Failed"], ["success", "Completed"]].map(([f, l]) => `<button class="seg-btn ${(filter ?? "") === f ? "active" : ""}" data-filter="${f}">${l}</button>`).join("")}</div><span class="spacer"></span><span class="muted small">${list.length} shown</span></div>` +
        (running.length ? `<section class="vsec"><h3>Running</h3><div class="list">${running.map((r) => runRow(r)).join("")}</div></section>` : "") +
        (rest.length ? `<section class="vsec"><h3>${filter ? "Matching" : "Finished"}</h3><div class="list">${rest.map((r) => runRow(r)).join("")}</div></section>` : running.length ? "" : empty("No runs yet", "Every message, sync, action and task leaves a run here."));
    },

    async runDetail(el, id, ctx) {
      const r = await ctx.api(`/runs/${id}`);
      el.innerHTML = `<div class="timeline">${r.steps.map((s) => `<div class="step ${s.status}"><span class="glyph ${s.status}"></span><span class="text"><span>${esc(s.label)}</span>${s.detail ? `<span class="detail">${esc(s.detail)}</span>` : ""}</span><span class="elapsed">${s.status === "running" || s.status === "waiting" ? `<span class="elapsed" data-since="${esc(s.at)}"></span>` : s.ended_at ? esc(dur(s.at, s.ended_at)) : ""}</span></div>`).join("")}
        ${r.events.filter((e) => e.type === "log" || e.type === "approval" || e.type === "error" || e.type === "result").map((e) => `<div class="step note"><span class="glyph ${e.type === "error" ? "failed" : e.type === "result" ? "done" : "skipped"}"></span><span class="text"><span>${esc(e.label)}</span>${e.detail ? `<span class="detail">${esc(e.detail)}</span>` : ""}</span><span class="elapsed">${clock(e.at)}</span></div>`).join("")}</div>
        ${r.summary || r.error ? `<p class="small ${r.error ? "bad" : ""}">${esc(r.error ?? r.summary)}</p>` : ""}`;
    },

    async approvals(root, ctx) {
      const a = await ctx.api("/approvals?limit=30");
      const card = (x) => `<div class="notice ${x.status === "pending" ? "warn" : ""}"><div class="body"><strong>${esc(x.summary)}</strong><div class="sub">${esc(x.action)}${x.run_label ? ` · ${esc(x.run_label)}` : ""}${x.provider ? ` · ${esc(ctx.aiName(x.provider))}` : ""} · asked ${esc(rel(x.requested_at))}${x.detail ? `<br><em>${esc(String(x.detail).slice(0, 240))}</em>` : ""}${x.status !== "pending" ? `<br>${esc(x.status)}${x.decided_by ? ` by ${esc(x.decided_by)}` : ""}${x.decided_at ? ` ${esc(rel(x.decided_at))}` : ""}${x.reason ? ` · ${esc(x.reason)}` : ""}` : ""}</div></div>${x.status === "pending" ? `<button class="btn small" data-approve-id="${x.id}" data-decision="reject">Reject</button><button class="btn small primary" data-approve-id="${x.id}" data-decision="approve">${icon("check", "sm")} Approve</button>` : `<span class="badge ${x.status === "approved" ? "ok" : x.status === "rejected" ? "bad" : "warn"}">${esc(x.status)}</span>`}</div>`;
      root.innerHTML = `<section class="vsec"><h3>Waiting for you</h3>${a.pending.length ? `<div class="attention">${a.pending.map(card).join("")}</div>` : empty("Nothing to approve", "Under “Ask me first”, the agent pauses here before it sends or acts.")}</section>
        <section class="vsec"><h3>Decided</h3>${a.recent.length ? `<div class="attention">${a.recent.map(card).join("")}</div>` : `<p class="muted small">No decisions yet.</p>`}</section>
        <p class="muted small vfoot">Which actions ask is set under Settings › Approvals.</p>`;
    },

    async activity(root, ctx) {
      const rows = await ctx.api("/activity?limit=150");
      if (!rows.length) return (root.innerHTML = empty("No activity yet", "Every step your agents take is written here as it happens."));
      let day = "";
      root.innerHTML = `<div class="feed">${rows.map((e) => {
        const d = new Date(e.at).toDateString();
        const head = d !== day ? `<div class="feed-day">${esc(d === new Date().toDateString() ? "Today" : d)}</div>` : "";
        day = d;
        const cls = e.type === "error" || e.status === "failed" ? "bad" : e.status === "waiting" || e.type === "approval" ? "warn" : e.status === "done" || e.type === "result" ? "ok" : e.status === "running" ? "run" : "";
        return `${head}<div class="feed-row" data-open-run="${e.run_id}"><span class="mono time">${esc(clock(e.at))}</span><span class="dot ${cls}"></span><div class="body"><div class="title">${esc(e.agent_name ?? e.provider_name ?? "Control plane")} <span class="muted">· ${esc(e.run_label ?? e.run_kind)}</span></div><div class="sub">${esc(e.label)}${e.detail ? ` · ${esc(String(e.detail).slice(0, 120))}` : ""}</div></div></div>`;
      }).join("")}</div>`;
    },

    async notifications(root, ctx) {
      const events = await ctx.api("/events?limit=100");
      const unread = events.filter((e) => !e.read).length;
      root.innerHTML = `<div class="vhead"><span class="muted small">${unread} unread</span><span class="spacer"></span>${unread ? `<button class="btn xs ghost" data-read-all>Mark all read</button>` : ""}</div>` +
        (events.length ? `<div class="list">${events.map((e) => `<div class="lrow ${e.read ? "dim" : ""}"><span class="dot ${e.kind === "run" || e.kind === "sync_error" ? "bad" : e.kind === "session" || e.kind === "approval" ? "warn" : ""}"></span><div class="body"><div class="title">${esc(e.title)}</div><div class="sub">${e.platform ? esc(ctx.aiName(e.platform)) + " · " : ""}${esc(rel(e.occurred_at))}${e.body ? " · " + esc(String(e.body).slice(0, 160)) : ""}</div></div>${e.link ? `<a class="btn xs ghost" href="${esc(e.link)}" target="_blank" rel="noopener">${icon("popout", "sm")}</a>` : ""}${e.read ? "" : `<button class="btn xs ghost" data-read="${e.id}" title="Mark read">${icon("check", "sm")}</button>`}</div>`).join("")}</div>` : empty("No notifications", "Failures, sign-outs and interrupted approvals land here."));
    },
  };

  /* ---------- the server log, tailed live ---------- */
  const LOG_RANK = { debug: 0, info: 1, warn: 2, error: 3 };
  const LOG_LEVELS = ["debug", "info", "warn", "error"];
  const stamp = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); };
  const logLine = (l) => `<div class="log-line lv-${esc(l.level)}" data-log-id="${l.id}"><span class="t" title="${esc(l.at)}">${esc(stamp(l.at))}</span><span class="lv">${esc(l.level)}</span><span class="sc">${esc(l.scope)}</span><span class="m">${esc(l.msg)}${l.extra ? `<span class="x">${esc(l.extra)}</span>` : ""}</span></div>`;
  const passes = (l, f) => LOG_RANK[l.level] >= (LOG_RANK[f.level] ?? 1) && (!f.scope || l.scope === f.scope);

  V.logs = async (root, ctx) => {
    const f = { level: ctx.store?.get("acp-log-level", "info") || "info", scope: ctx.store?.get("acp-log-scope", "") || "" };
    const r = await ctx.api(`/logs?limit=500&level=${f.level}${f.scope ? `&scope=${encodeURIComponent(f.scope)}` : ""}`);
    const sel = (attr, value, options, label) => `<select ${attr}>${options.map((o) => `<option value="${esc(o)}"${o === value ? " selected" : ""}>${esc(label(o))}</option>`).join("")}</select>`;
    root.innerHTML = `<div class="vhead wrap">
        <label class="muted small">Show ${sel("data-log-level", f.level, LOG_LEVELS, (l) => (l === "debug" ? "everything" : `${l} and above`))}</label>
        <label class="muted small">from ${sel("data-log-scope", f.scope, ["", ...r.scopes.filter((s) => s !== f.scope), ...(f.scope ? [f.scope] : [])].sort(), (s) => s || "every part")}</label>
        <span class="spacer"></span>
        <label class="muted small" title="What the server prints to its own console, which is what the host (Railway) shows. This view always keeps everything the server logged, whatever the console prints.">Console prints ${sel("data-console-level", r.level, LOG_LEVELS, (l) => `${l} and above`)}</label>
        <button class="btn xs ghost" data-log-clear title="Clear the screen; the server keeps its lines">Clear</button>
      </div>
      <div class="loglist" id="log-lines">${r.lines.map(logLine).join("")}</div>
      ${r.lines.length ? "" : empty("Nothing at this level yet", "New lines appear here live as the server works. Show everything to include debug lines.")}
      <p class="muted small vfoot">The server keeps its last 2000 lines in memory since it started; they are gone after a restart. Set LOG_LEVEL=debug in the deployment to print this much to the host's log as well.</p>`;
  };

  const TITLES = { overview: "Overview", agents: "Agents", tasks: "Tasks", runs: "Runs", approvals: "Approvals", activity: "Activity", notifications: "Notifications", logs: "Logs" };

  window.Views = {
    titles: TITLES,
    async render(view, root, ctx) {
      const fn = V[view];
      if (!fn) return (root.innerHTML = empty("Unknown view"));
      await fn(root, ctx);
    },
    detail: { agent: V.agentDetail, task: V.taskDetail, run: V.runDetail },
    /** A line from the live stream lands at the bottom of the open logs view, if it passes the filter. */
    appendLog(line, root, filter) {
      const list = root.querySelector("#log-lines");
      if (!list || !passes(line, filter)) return;
      const atBottom = root.scrollHeight - root.scrollTop - root.clientHeight < 48;
      list.insertAdjacentHTML("beforeend", logLine(line));
      while (list.children.length > 2000) list.firstElementChild.remove();
      root.querySelector(".view-empty")?.remove();
      if (atBottom) root.scrollTop = root.scrollHeight;
    },
  };
})();
