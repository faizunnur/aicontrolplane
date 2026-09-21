/* AI Control Plane console. Vanilla JS over /api. */
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  let state = { overview: null, agents: [], runs: [], events: [], platforms: [], messages: [], stats: [] };

  /* ---------- theme ---------- */
  const THEMES = ["system", "light", "dark"];
  const themeLabel = { system: "system", light: "light", dark: "dark" };
  function applyTheme(t) {
    if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
    else document.documentElement.removeAttribute("data-theme");
    $("#btn-theme").title = `Theme: ${themeLabel[t]}`;
    $("#btn-theme").textContent = t === "light" ? "☀" : t === "dark" ? "☾" : "◐";
  }
  let theme = "system";
  try {
    theme = localStorage.getItem("acp-theme") || "system";
  } catch {
    theme = "system";
  }
  applyTheme(theme);
  $("#btn-theme").addEventListener("click", () => {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    try {
      localStorage.setItem("acp-theme", theme);
    } catch {
      /* per-viewer convenience only */
    }
    applyTheme(theme);
    renderChart();
  });

  /* ---------- api ---------- */
  async function api(path, opts = {}) {
    const res = await fetch("/api" + path, {
      headers: { "content-type": "application/json", ...(opts.headers || {}) },
      credentials: "same-origin",
      ...opts,
      body: opts.body !== undefined && typeof opts.body !== "string" ? JSON.stringify(opts.body) : opts.body,
    });
    if (res.status === 401) {
      showLogin();
      throw new Error("unauthorized");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  function toast(msg, kind = "") {
    const t = $("#toast");
    t.textContent = msg;
    t.className = `toast ${kind}`;
    t.hidden = false;
    clearTimeout(t._h);
    t._h = setTimeout(() => (t.hidden = true), kind === "bad" ? 7000 : 3500);
  }
  const fail = (err) => {
    if (err && err.message !== "unauthorized") toast(err.message || String(err), "bad");
  };
  /** Run an async action with a spinner on the triggering button. */
  async function busy(btn, fn) {
    if (btn) btn.classList.add("busy");
    try {
      return await fn();
    } finally {
      if (btn) btn.classList.remove("busy");
    }
  }

  /* ---------- login ---------- */
  function showLogin() {
    $("#login").hidden = false;
    $("#login-token").focus();
  }
  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const token = $("#login-token").value.trim();
    try {
      await api("/session", { method: "POST", body: { token } });
      $("#login").hidden = true;
      $("#login-error").hidden = true;
      $("#login-token").value = "";
      refresh();
    } catch {
      $("#login-error").hidden = false;
    }
  });
  $("#btn-logout").addEventListener("click", async () => {
    await fetch("/api/session", { method: "DELETE" });
    showLogin();
  });

  /* ---------- helpers ---------- */
  const rel = (iso) => {
    if (!iso) return "never";
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 45) return "just now";
    if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
    if (diff < 86400 * 14) return `${Math.floor(diff / 86400)} d ago`;
    return d.toLocaleDateString();
  };
  const abs = (iso) => (iso ? new Date(iso).toLocaleString() : "");
  const when = (iso) => `<time class="meta" datetime="${esc(iso || "")}" title="${esc(abs(iso))}">${rel(iso)}</time>`;
  const platformName = (id) => state.platforms.find((p) => p.id === id)?.name || id || "";

  const SESSION = {
    logged_in: ["ok", "signed in"],
    needs_login: ["warn", "login required"],
    error: ["bad", "error"],
    unknown: ["", "not synced"],
  };
  const sessionBadge = (s) => {
    const [cls, label] = SESSION[s] || SESSION.unknown;
    return `<span class="badge ${cls}">${label}</span>`;
  };
  const RUN = {
    success: ["ok", "success"],
    failed: ["bad", "failed"],
    needs_attention: ["warn", "needs attention"],
    running: ["run", "running"],
  };
  const runCls = (s) => (RUN[s] || ["", s])[0];
  const runBadge = (s) => {
    const [cls, label] = RUN[s] || ["", s || "unknown"];
    return `<span class="badge ${cls}">${esc(label)}</span>`;
  };
  const MSG = {
    needs_assignment: ["warn", "needs assignee"],
    assigned: ["run", "assigned"],
    delivered: ["run", "delivered"],
    acknowledged: ["run", "acknowledged"],
    done: ["ok", "done"],
    failed: ["bad", "failed"],
  };
  const msgBadge = (s) => {
    const [cls, label] = MSG[s] || ["", s];
    return `<span class="badge ${cls}">${esc(label)}</span>`;
  };

  /* ---------- render: header ---------- */
  function renderHealth() {
    const syncable = state.platforms.filter((p) => p.syncable);
    $("#health").innerHTML = syncable
      .map((p) => {
        const s = p.state.session_status;
        const cls = s === "logged_in" ? "ok" : s === "needs_login" ? "warn" : s === "error" ? "bad" : "";
        const label = (SESSION[s] || SESSION.unknown)[1];
        return `<a href="#platform-${p.id}" title="${esc(p.name)}: ${label}, last sync ${rel(p.state.last_sync_at)}"><span class="dot ${cls}"></span>${esc(p.name)}</a>`;
      })
      .join("");
    const r = state.overview.router;
    $("#router-status").textContent = r.llm ? `routed by ${r.model} · auto-assign from ${Math.round(r.autoThreshold * 100)}%` : `keyword routing · auto-assign from ${Math.round(r.autoThreshold * 100)}%`;
    const s = state.overview.scheduler;
    $("#scheduler-status").textContent = !s.enabled ? "auto-sync off" : s.running ? "syncing now…" : `auto-sync every ${s.intervalMin} min`;
    $("#btn-sync-all").disabled = !state.overview.browser.enabled || s.running;
    $("#btn-vnc").hidden = !state.overview.browser.enabled || state.overview.browser.headless;
  }

  /* ---------- render: summary ---------- */
  function renderStats() {
    const c = state.overview.counts;
    const attention = state.overview.attention;
    const open = (c.openMessages || 0) + c.unreadEvents + attention.sessions.length;
    const tot = state.stats.reduce((n, d) => n + d.success + d.running + d.needs_attention + d.failed, 0);
    const okRate = tot ? Math.round((state.stats.reduce((n, d) => n + d.success, 0) / tot) * 100) : null;
    $("#stats").innerHTML = [
      stat("Agents", c.agents, `${state.platforms.filter((p) => p.state.session_status === "logged_in").length} platforms signed in`),
      stat("Runs · 24 h", c.runs24h, okRate === null ? "no runs in 14 days" : `${okRate}% succeeded over 14 d`),
      stat("Failed · 7 d", c.failed7d, c.failed7d ? "open the attention list" : "nothing failed", c.failed7d ? "bad" : ""),
      stat("Needs you", open, open ? `${c.openMessages || 0} messages · ${c.unreadEvents} events` : "all clear", open ? "warn" : ""),
    ].join("");
  }
  const stat = (label, value, sub, cls = "") =>
    `<div class="stat ${cls}"><span class="stat-label">${esc(label)}</span><span class="stat-value">${esc(value)}</span><span class="stat-sub">${esc(sub)}</span></div>`;

  const SERIES = [
    ["success", "Succeeded", "--ok"],
    ["running", "Running", "--run"],
    ["needs_attention", "Needs attention", "--warn"],
    ["failed", "Failed", "--bad"],
  ];
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function renderChart() {
    $("#chart-legend").innerHTML = SERIES.map(([, label, v]) => `<li><i style="background:${cssVar(v)}"></i>${label}</li>`).join("");
    const days = state.stats;
    const host = $("#chart");
    const total = days.reduce((n, d) => n + d.success + d.running + d.needs_attention + d.failed, 0);
    if (!days.length || !total) {
      host.innerHTML = `<div class="chart-empty">No runs recorded in the last 14 days. Sync a platform or report a run.</div>`;
      return;
    }
    const W = 640;
    const H = 150;
    const padL = 26;
    const padR = 6;
    const padT = 8;
    const padB = 22;
    const innerW = W - padL - padR;
    const innerH = H - padT - padB;
    const maxDay = Math.max(...days.map((d) => d.success + d.running + d.needs_attention + d.failed));
    const yMax = Math.max(4, Math.ceil(maxDay / 2) * 2);
    const slot = innerW / days.length;
    const barW = Math.min(28, slot * 0.62);
    const y = (v) => padT + innerH - (v / yMax) * innerH;
    const ticks = [0, yMax / 2, yMax];
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Stacked bars of runs per day by outcome">`;
    for (const t of ticks) {
      svg += `<line class="grid" x1="${padL}" x2="${W - padR}" y1="${y(t)}" y2="${y(t)}" />`;
      svg += `<text class="axis" x="${padL - 6}" y="${y(t) + 3.5}" text-anchor="end">${t}</text>`;
    }
    days.forEach((d, i) => {
      const x = padL + i * slot + (slot - barW) / 2;
      let acc = 0;
      let bars = "";
      const segs = SERIES.map(([k, , v]) => [k, d[k], cssVar(v)]).filter(([, n]) => n > 0);
      segs.forEach(([k, n, color], si) => {
        const y1 = y(acc + n);
        const y0 = y(acc);
        const h = Math.max(0, y0 - y1 - (si < segs.length - 1 ? 2 : 0));
        const top = si === segs.length - 1;
        bars += top
          ? `<path fill="${color}" d="M${x},${y0} v${-(h - 3)} a3,3 0 0 1 3,-3 h${barW - 6} a3,3 0 0 1 3,3 v${h - 3} z"><title>${k}</title></path>`
          : `<rect fill="${color}" x="${x}" y="${y1}" width="${barW}" height="${h}" />`;
        acc += n;
      });
      const date = new Date(d.day + "T00:00:00Z");
      const label = i === days.length - 1 ? "today" : i % 2 === 0 ? String(date.getUTCDate()) : "";
      svg += `<g class="col" data-i="${i}"><rect class="hit" x="${padL + i * slot}" y="${padT}" width="${slot}" height="${innerH}" />${bars}
        ${label ? `<text class="axis" x="${padL + i * slot + slot / 2}" y="${H - 6}" text-anchor="middle">${label}</text>` : ""}</g>`;
    });
    svg += `<line class="grid" x1="${padL}" x2="${W - padR}" y1="${y(0)}" y2="${y(0)}" style="stroke:var(--border-strong)" /></svg>`;
    host.innerHTML = svg;

    const tip = $("#chart-tip");
    host.onmousemove = (e) => {
      const col = e.target.closest(".col");
      if (!col) {
        tip.hidden = true;
        return;
      }
      const d = days[Number(col.dataset.i)];
      const sum = d.success + d.running + d.needs_attention + d.failed;
      tip.innerHTML =
        `<b>${new Date(d.day + "T00:00:00Z").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })} · ${sum} run${sum === 1 ? "" : "s"}</b>` +
        SERIES.map(([k, label, v]) => `<div class="tr"><span><i style="background:${cssVar(v)}"></i>${label}</span><span>${d[k]}</span></div>`).join("");
      tip.hidden = false;
      const fig = host.closest(".chart").getBoundingClientRect();
      const tw = tip.offsetWidth || 150;
      let left = e.clientX - fig.left + 14;
      if (left + tw > fig.width - 8) left = e.clientX - fig.left - tw - 14;
      tip.style.left = `${Math.max(4, left)}px`;
      tip.style.top = `${Math.max(4, e.clientY - fig.top - 10)}px`;
    };
    host.onmouseleave = () => (tip.hidden = true);
  }

  /* ---------- render: setup stepper ---------- */
  function renderSetup() {
    const signedIn = state.platforms.some((p) => p.state.session_status === "logged_in");
    const synced = state.platforms.some((p) => p.state.last_sync_at);
    const registered = state.agents.length > 0;
    const allDone = signedIn && synced && registered;
    $("#setup").hidden = allDone;
    if (allDone) return;
    const steps = [
      [signedIn, "Sign in once", state.overview.browser.enabled && !state.overview.browser.headless ? 'Open the <a href="/vnc/" target="_blank" rel="noopener">browser screen</a> and log in to each platform tab. Sessions persist on disk.' : "Run with the browser enabled to mirror web platforms, or register agents by hand."],
      [synced, "Sync", "Press <em>Sync all</em>. Each platform gets a live screenshot, its session state, and any tasks it exposes."],
      [registered, "Register the rest", "Add agents that run elsewhere with <em>Add agent</em>, or have them report in with one HTTP call."],
    ];
    $("#stepper").innerHTML = steps
      .map(([done, title, sub], i) => `<li class="${done ? "done" : ""}"><span class="step-n">${done ? "✓" : i + 1}</span><div><div class="step-title">${title}</div><div class="step-sub">${sub}</div></div></li>`)
      .join("");
  }

  /* ---------- render: attention ---------- */
  function renderAttention() {
    const a = state.overview.attention;
    const items = [];
    for (const s of a.sessions) {
      items.push(
        `<div class="rowitem s-warn"><div class="body"><div class="title">${esc(s.name)} needs login</div><div class="sub">Open the browser screen, sign in, then sync.</div></div>
         <div class="actions"><a class="btn small" href="/vnc/" target="_blank" rel="noopener">Browser screen</a><button class="btn small ghost" data-sync="${esc(s.platform)}">Sync</button></div></div>`,
      );
    }
    for (const m of a.messages || []) {
      const cls = m.status === "failed" ? "s-bad" : "s-accent";
      items.push(
        `<div class="rowitem ${cls}"><div class="body"><div class="title">${m.status === "failed" ? "Instruction could not be delivered" : "Instruction needs an assignee"} ${msgBadge(m.status)}</div>
         <div class="sub">“${esc(m.text.slice(0, 140))}”${m.error ? ` · ${esc(m.error)}` : ""}</div></div>
         <div class="actions"><a class="btn small" href="#message-${m.id}">Open</a></div></div>`,
      );
    }
    // A failed run that already raised an unread event is shown once, as the dismissible event.
    const covered = new Set(a.events.filter((e) => e.kind === "run").map((e) => e.title));
    for (const r of a.runs) {
      if (covered.has(`${r.agent_name}: ${r.status.replace("_", " ")}`)) continue;
      items.push(
        `<div class="rowitem ${runCls(r.status) === "bad" ? "s-bad" : "s-warn"}"><div class="body"><div class="title">${esc(r.agent_name)} ${runBadge(r.status)}</div><div class="sub">${esc(r.summary || "")} · ${esc(platformName(r.platform))} · ${when(r.finished_at || r.started_at || r.created_at)}</div></div>
         <div class="actions">${r.output_url || r.agent_native_url ? `<a class="btn small" target="_blank" rel="noopener" href="${esc(r.output_url || r.agent_native_url)}">Open</a>` : ""}</div></div>`,
      );
    }
    for (const e of a.events) {
      if (e.kind === "message") continue;
      items.push(
        `<div class="rowitem ${e.kind === "session" ? "s-warn" : e.kind === "sync_error" ? "s-bad" : "s-accent"}"><div class="body"><div class="title">${esc(e.title)}</div><div class="sub">${esc((e.body || "").slice(0, 160))} · ${esc(platformName(e.platform || ""))} · ${when(e.occurred_at)}</div></div>
         <div class="actions">${e.link ? `<a class="btn small" target="_blank" rel="noopener" href="${esc(e.link)}">Open</a>` : ""}<button class="btn small ghost" data-read="${e.id}">Dismiss</button></div></div>`,
      );
    }
    $("#attention-count").textContent = items.length ? items.length : "";
    $("#btn-read-all").hidden = !a.events.length;
    $("#attention-list").innerHTML = items.join("") || `<p class="empty">Nothing needs you right now.</p>`;
  }

  /* ---------- render: messages ---------- */
  function renderMessages() {
    const sel = $("#message-agent");
    const cur = sel.value;
    const agentOptions = state.agents.filter((a) => a.enabled).map((a) => `<option value="${a.id}">${esc(a.name)} · ${esc(platformName(a.platform))}</option>`).join("");
    sel.innerHTML = '<option value="">Auto-route</option>' + agentOptions;
    sel.value = cur;

    $("#messages").innerHTML =
      state.messages
        .slice(0, 15)
        .map((m) => {
          const cls = { needs_assignment: "s-warn", failed: "s-bad", done: "s-ok" }[m.status] || "s-run";
          const who = m.agent_name ? `${esc(m.agent_name)} · ${esc(platformName(m.agent_platform))}` : "unassigned";
          const route = m.routing ? `<span class="badge plain mono" title="${esc(m.routing.reason || "")}">${esc(m.routing.method)}${m.routing.confidence != null ? ` ${Math.round(m.routing.confidence * 100)}%` : ""}</span>` : "";
          let extra = "";
          if (m.status === "needs_assignment") {
            const sugg = (m.suggestions || [])
              .map((s) => `<button class="btn small" data-assign="${m.id}" data-agent="${s.agent_id}" title="${esc(s.reason)}">→ ${esc(s.name)} <b>${Math.round(s.score * 100)}%</b></button>`)
              .join("");
            const newAgent = m.routing?.new_agent ? `<button class="btn small ghost" data-new-agent="${m.id}">Create agent on ${esc(platformName(m.routing.new_agent.platform))}</button>` : "";
            const pick = `<select data-pick="${m.id}" aria-label="Assign to"><option value="">Assign to…</option>${agentOptions}</select>`;
            extra = `<div class="sub">${esc(m.routing?.reason || "")}</div><div class="suggest">${sugg}${newAgent}${pick}</div>`;
          } else if (m.error) {
            extra = `<div class="sub" style="color:var(--bad)">${esc(m.error)}</div>`;
          } else if (m.delivery_hint && m.status !== "done") {
            extra = `<div class="sub">${esc(m.delivery_hint)}</div>`;
          }
          if (m.response) extra += `<div class="response">${esc(m.response)}</div>`;
          const manual = m.delivery_mode === "manual" && !["done", "failed"].includes(m.status);
          const actions = [
            manual ? `<button class="btn small" data-copy="${m.id}">Copy</button>` : "",
            manual && m.agent_native_url ? `<a class="btn small" target="_blank" rel="noopener" href="${esc(m.agent_native_url)}">Open</a>` : "",
            m.status === "failed" && m.agent_id ? `<button class="btn small" data-msg-retry="${m.id}">Retry</button>` : "",
            m.status !== "done" && m.agent_id ? `<button class="btn small ghost" data-msg-done="${m.id}">Done</button>` : "",
            `<details class="menu"><summary class="btn small ghost icon" aria-label="More">…</summary><div class="menu-list">
               ${m.status !== "needs_assignment" ? `<button class="btn small ghost" data-msg-reroute="${m.id}">Reroute</button>` : ""}
               <button class="btn small ghost danger" data-msg-delete="${m.id}">Delete</button></div></details>`,
          ].join("");
          return `<div class="rowitem ${cls}" id="message-${m.id}"><div class="body">
              <div class="title">${msgBadge(m.status)} ${route} <span class="meta">${when(m.created_at)}</span><span class="meta">${who}</span></div>
              <div class="text">${esc(m.text)}</div>${extra}</div>
            <div class="actions">${actions}</div></div>`;
        })
        .join("") || `<p class="empty">No messages yet. Type an instruction above; it goes to the responsible agent, or you get suggestions.</p>`;
  }

  /* ---------- render: platforms ---------- */
  function renderPlatforms() {
    $("#platforms").innerHTML = state.platforms
      .map((p) => {
        const s = p.state;
        const shot = p.hasScreenshot
          ? `<div class="tile-shot"><img data-shot="${p.id}" src="/api/platforms/${p.id}/screenshot.png?t=${encodeURIComponent(s.last_sync_at || "")}" alt="${esc(p.name)} task page" loading="lazy" /><span class="stamp">${rel(s.last_sync_at)}</span></div>`
          : p.syncable
            ? `<div class="tile-shot"><div class="placeholder">No screenshot yet. Sync to capture the task page.</div></div>`
            : "";
        const extras = p.actions
          .filter((a) => a.id !== "sync" && a.id !== "open" && a.id !== "screenshot")
          .map((a) => `<button class="btn small" data-action="${a.id}" data-platform="${p.id}" title="${esc(a.description)}">${esc(a.label)}</button>`)
          .join("");
        return `<article class="tile ${p.syncable ? "" : "compact"}" id="platform-${p.id}">
          <div class="tile-head"><h3>${esc(p.name)}</h3>${p.syncable ? sessionBadge(s.session_status) : '<span class="badge plain">registry only</span>'}</div>
          ${shot}
          <div class="tile-meta">
            <span>${p.agents} agent${p.agents === 1 ? "" : "s"}${s.last_error ? ` · <span class="error">${esc(s.last_error)}</span>` : ""}</span>
            ${p.notes ? `<span>${esc(p.notes)}</span>` : ""}
          </div>
          <div class="tile-actions">
            ${p.syncable ? `<button class="btn small primary" data-sync="${p.id}">Sync</button>` : ""}
            ${p.tasksUrl || p.appUrl ? `<button class="btn small" data-action="open" data-platform="${p.id}" title="Bring this platform up on the browser screen">Open</button>` : ""}
            ${extras}
            <details class="menu"><summary class="btn small ghost">More</summary><div class="menu-list">
              <button class="btn small ghost" data-action="screenshot" data-platform="${p.id}">Refresh screenshot</button>
              <button class="btn small ghost" data-settings="${p.id}">Settings</button></div></details>
          </div>
        </article>`;
      })
      .join("");
  }

  /* ---------- render: agents ---------- */
  function renderAgents() {
    const filter = $("#agent-filter").value;
    const rows = state.agents.filter((a) => !filter || a.platform === filter);
    $("#agents-count").textContent = state.agents.length || "";
    $("#agents-empty").hidden = rows.length > 0;
    const history = (a) => {
      const list = (a.recent_statuses || []).slice(0, 6).reverse();
      const pad = Array(Math.max(0, 6 - list.length)).fill("");
      return `<span class="history" title="Last ${list.length} runs, oldest to newest">${[...pad, ...list].map((s) => `<i class="${runCls(s)}"></i>`).join("")}</span>`;
    };
    const extras = (a) => {
      const p = state.platforms.find((x) => x.id === a.platform);
      return (p?.actions || [])
        .filter((x) => x.id !== "sync" && x.id !== "screenshot")
        .map((x) => `<button class="btn small ghost" data-agent-action="${x.id}" data-agent="${a.id}" data-platform="${p.id}" title="${esc(x.description)}">${esc(x.label)}</button>`)
        .join("");
    };
    $("#agents-table tbody").innerHTML = rows
      .map(
        (a) => `<tr>
          <td><div class="agent-name">${esc(a.name)}${a.enabled ? "" : '<span class="badge plain">disabled</span>'}${a.status && a.status !== "active" ? `<span class="badge plain">${esc(a.status)}</span>` : ""}</div>${a.purpose ? `<div class="sub">${esc(a.purpose.slice(0, 120))}</div>` : `<div class="sub mono">${esc(a.key)}</div>`}</td>
          <td>${esc(platformName(a.platform))}<div class="sub">${esc(a.source)}</div></td>
          <td class="mono">${esc(a.schedule || "—")}</td>
          <td>${history(a)}</td>
          <td>${a.last_run ? `${runBadge(a.last_run.status)}<div class="sub">${rel(a.last_run.finished_at || a.last_run.started_at || a.last_run.created_at)}${a.last_run.summary ? " · " + esc(a.last_run.summary.slice(0, 70)) : ""}</div>` : '<span class="sub">no runs yet</span>'}</td>
          <td class="actions"><div class="row">
            ${a.native_url ? `<a class="btn small ghost" target="_blank" rel="noopener" href="${esc(a.native_url)}">Link</a>` : ""}
            <button class="btn small ghost" data-edit="${a.id}">Edit</button>
            <details class="menu"><summary class="btn small ghost icon" aria-label="More">…</summary><div class="menu-list">
              ${extras(a)}
              <button class="btn small ghost danger" data-delete="${a.id}">Delete</button></div></details>
          </div></td>
        </tr>`,
      )
      .join("");
  }

  /* ---------- render: activity ---------- */
  function renderRuns() {
    $("#runs").innerHTML =
      state.runs
        .slice(0, 10)
        .map(
          (r) => `<div class="rowitem s-${runCls(r.status) || "neutral"}"><div class="body"><div class="title">${esc(r.agent_name)} ${runBadge(r.status)}</div>
            <div class="sub">${esc(platformName(r.platform))} · via ${esc(r.source)} · ${when(r.finished_at || r.started_at || r.created_at)}${r.summary ? "<br/>" + esc(r.summary.slice(0, 200)) : ""}</div></div>
            <div class="actions">${r.output_url ? `<a class="btn small ghost" target="_blank" rel="noopener" href="${esc(r.output_url)}">Output</a>` : ""}</div></div>`,
        )
        .join("") || '<p class="empty">No runs recorded yet.</p>';
  }
  function renderEvents() {
    $("#events").innerHTML =
      state.events
        .slice(0, 10)
        .map(
          (e) => `<div class="rowitem ${e.read ? "" : e.kind === "session" ? "s-warn" : e.kind === "sync_error" || e.kind === "run" ? "s-bad" : "s-accent"}"><div class="body"><div class="title">${esc(e.title)}</div>
            <div class="sub">${esc(platformName(e.platform || ""))} · ${esc(e.kind)} · ${when(e.occurred_at)}${e.body ? "<br/>" + esc(e.body.slice(0, 200)) : ""}</div></div>
            <div class="actions">${e.link ? `<a class="btn small ghost" target="_blank" rel="noopener" href="${esc(e.link)}">Open</a>` : ""}${e.read ? "" : `<button class="btn small ghost" data-read="${e.id}">Dismiss</button>`}</div></div>`,
        )
        .join("") || '<p class="empty">No events yet. Failed runs, login prompts and ingested emails show up here.</p>';
  }
  function renderIngestExample() {
    const base = state.overview.publicUrl || window.location.origin;
    $("#ingest-example").textContent = `curl -X POST ${base}/api/ingest \\
  -H "Authorization: Bearer $ACP_INGEST_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "agent": { "key": "daily-digest", "platform": "claude", "name": "Daily digest", "schedule": "weekdays 08:00" },
    "run":   { "status": "success", "summary": "Sent digest with 12 items", "output_url": "https://..." }
  }'`;
  }
  function renderFilters() {
    const sel = $("#agent-filter");
    const cur = sel.value;
    sel.innerHTML = '<option value="">All platforms</option>' + state.platforms.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
    sel.value = cur;
    $("#platform-ids").innerHTML = state.platforms.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
  }

  async function refresh() {
    try {
      await api("/session");
      const [overview, agents, runs, events, messages, stats] = await Promise.all([
        api("/overview"),
        api("/agents?all=1"),
        api("/runs?limit=40"),
        api("/events?limit=40"),
        api("/messages?limit=30"),
        api("/stats/runs?days=14"),
      ]);
      state = { overview, agents, runs, events, messages, stats, platforms: overview.platforms };
      renderFilters();
      renderHealth();
      renderStats();
      renderChart();
      renderSetup();
      renderAttention();
      renderMessages();
      renderPlatforms();
      renderAgents();
      renderRuns();
      renderEvents();
      renderIngestExample();
    } catch (err) {
      fail(err);
    }
  }

  /* ---------- interactions ---------- */
  document.addEventListener("click", async (e) => {
    // close open menus when clicking elsewhere
    for (const d of $$("details.menu[open]")) if (!d.contains(e.target)) d.removeAttribute("open");
    const t = e.target.closest(
      "[data-sync],[data-action],[data-settings],[data-shot],[data-read],[data-edit],[data-delete],[data-agent-action],[data-close],[data-assign],[data-copy],[data-msg-retry],[data-msg-done],[data-msg-reroute],[data-msg-delete],[data-new-agent]",
    );
    if (!t) {
      const ov = e.target.closest("[data-close-on-click]");
      if (ov && e.target === ov) ov.hidden = true;
      return;
    }
    const btn = t.tagName === "BUTTON" ? t : null;
    try {
      if (t.dataset.close !== undefined) {
        t.closest(".overlay").hidden = true;
      } else if (t.dataset.sync) {
        await busy(btn, async () => {
          const r = await api(`/platforms/${t.dataset.sync}/sync`, { method: "POST" });
          toast(`${platformName(t.dataset.sync)}: ${r.message || (r.ok ? "synced" : "sync failed")}`, r.ok ? "ok" : "bad");
        });
        await refresh();
      } else if (t.dataset.action) {
        await busy(btn, async () => {
          const r = await api(`/platforms/${t.dataset.platform}/actions/${t.dataset.action}`, { method: "POST", body: {} });
          toast(r.message, r.ok ? "ok" : "bad");
          if (t.dataset.action === "open" && r.ok && !state.overview.browser.headless) window.open("/vnc/", "_blank", "noopener");
        });
        await refresh();
      } else if (t.dataset.agentAction) {
        await busy(btn, async () => {
          const r = await api(`/platforms/${t.dataset.platform}/actions/${t.dataset.agentAction}`, { method: "POST", body: { agent_id: Number(t.dataset.agent) } });
          toast(r.message, r.ok ? "ok" : "bad");
          if (t.dataset.agentAction === "open" && r.ok && !state.overview.browser.headless) window.open("/vnc/", "_blank", "noopener");
        });
        await refresh();
      } else if (t.dataset.settings) {
        await openPlatformSettings(t.dataset.settings);
      } else if (t.dataset.shot) {
        $("#shot-img").src = `/api/platforms/${t.dataset.shot}/screenshot.png?t=${Date.now()}`;
        $("#shot-modal").hidden = false;
      } else if (t.dataset.read) {
        await api(`/events/${t.dataset.read}/read`, { method: "POST", body: {} });
        await refresh();
      } else if (t.dataset.edit) {
        openAgentModal(state.agents.find((a) => a.id === Number(t.dataset.edit)));
      } else if (t.dataset.delete) {
        const a = state.agents.find((x) => x.id === Number(t.dataset.delete));
        if (a && confirm(`Delete "${a.name}" and its run history?`)) {
          await api(`/agents/${a.id}`, { method: "DELETE" });
          toast("Agent deleted", "ok");
          await refresh();
        }
      } else if (t.dataset.assign) {
        await busy(btn, async () => {
          const m = await api(`/messages/${t.dataset.assign}/assign`, { method: "POST", body: { agent_id: Number(t.dataset.agent) } });
          toast(m.status === "failed" ? `Delivery failed: ${m.error}` : `Sent to ${m.agent_name}. ${cap(m.delivery_hint)}`, m.status === "failed" ? "bad" : "ok");
        });
        await refresh();
      } else if (t.dataset.copy) {
        const m = state.messages.find((x) => x.id === Number(t.dataset.copy));
        if (m) {
          await navigator.clipboard.writeText(m.text).catch(() => prompt("Copy this instruction:", m.text));
          toast("Copied. Paste it into the platform, then press Done.", "ok");
        }
      } else if (t.dataset.msgRetry) {
        await busy(btn, async () => {
          const m = await api(`/messages/${t.dataset.msgRetry}/retry`, { method: "POST", body: {} });
          toast(m.status === "failed" ? `Still failing: ${m.error}` : `Delivered. ${cap(m.delivery_hint)}`, m.status === "failed" ? "bad" : "ok");
        });
        await refresh();
      } else if (t.dataset.msgDone) {
        await api(`/messages/${t.dataset.msgDone}/status`, { method: "POST", body: { status: "done" } });
        await refresh();
      } else if (t.dataset.msgReroute) {
        await busy(btn, () => api(`/messages/${t.dataset.msgReroute}/reroute`, { method: "POST", body: {} }));
        await refresh();
      } else if (t.dataset.msgDelete) {
        await api(`/messages/${t.dataset.msgDelete}`, { method: "DELETE" });
        await refresh();
      } else if (t.dataset.newAgent) {
        const m = state.messages.find((x) => x.id === Number(t.dataset.newAgent));
        const n = m?.routing?.new_agent;
        openAgentModal(n ? { name: n.name, platform: n.platform, purpose: n.purpose, enabled: 1 } : null);
        $("#agent-id").value = "";
        $("#agent-form").dataset.thenAssign = t.dataset.newAgent;
      }
    } catch (err) {
      fail(err);
    }
  });
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) + "." : "");

  $("#btn-sync-all").addEventListener("click", async (e) => {
    try {
      await busy(e.currentTarget, async () => {
        toast("Syncing every platform. This takes about a minute.");
        const r = await api("/sync", { method: "POST", body: {} });
        const parts = Object.values(r.results).map((x) => `${platformName(x.platform)}: ${x.message || (x.ok ? "ok" : "failed")}`);
        toast(parts.join(" · ") || "Nothing to sync. Set a tasks page URL on a platform first.", parts.length ? "ok" : "");
      });
      await refresh();
    } catch (err) {
      fail(err);
    }
  });
  $("#btn-refresh").addEventListener("click", refresh);
  $("#btn-read-all").addEventListener("click", async () => {
    await api("/events/read-all", { method: "POST", body: {} });
    refresh();
  });
  $("#agent-filter").addEventListener("change", renderAgents);

  /* ---------- messages ---------- */
  $("#message-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = $("#message-text").value.trim();
    if (!text) return;
    const agentId = $("#message-agent").value;
    try {
      await busy($("#message-send"), async () => {
        const r = await api("/messages", { method: "POST", body: { text, ...(agentId ? { agent_id: Number(agentId) } : {}) } });
        const m = r.message;
        if (m.status === "needs_assignment") toast(m.suggestions?.length ? "Not sure who owns this. Pick from the suggestions." : "No matching agent. Pick one or create it.");
        else if (m.status === "failed") toast(`Assigned to ${m.agent_name}, but delivery failed: ${m.error}`, "bad");
        else toast(`${r.auto_assigned ? "Routed to" : "Sent to"} ${m.agent_name}. ${cap(m.delivery_hint)}`, "ok");
        $("#message-text").value = "";
        $("#message-agent").value = "";
      });
      await refresh();
    } catch (err) {
      fail(err);
    }
  });
  $("#message-text").addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") $("#message-form").requestSubmit();
  });
  document.addEventListener("change", async (e) => {
    const sel = e.target.closest("[data-pick]");
    if (!sel || !sel.value) return;
    try {
      const m = await api(`/messages/${sel.dataset.pick}/assign`, { method: "POST", body: { agent_id: Number(sel.value) } });
      toast(m.status === "failed" ? `Delivery failed: ${m.error}` : `Sent to ${m.agent_name}. ${cap(m.delivery_hint)}`, m.status === "failed" ? "bad" : "ok");
      await refresh();
    } catch (err) {
      fail(err);
    }
  });

  /* ---------- agent editor ---------- */
  function openAgentModal(agent) {
    $("#agent-modal-title").textContent = agent?.id ? "Edit agent" : "Add agent";
    $("#agent-id").value = agent?.id ?? "";
    $("#agent-name").value = agent?.name ?? "";
    $("#agent-platform").value = agent?.platform ?? "";
    $("#agent-key").value = agent?.key ?? "";
    $("#agent-purpose").value = agent?.purpose ?? "";
    $("#agent-schedule").value = agent?.schedule ?? "";
    $("#agent-url").value = agent?.native_url ?? "";
    $("#agent-keywords").value = agent?.keywords ?? "";
    let d = {};
    try {
      d = agent?.delivery ? JSON.parse(agent.delivery) : {};
    } catch {
      d = {};
    }
    $("#agent-delivery-mode").value = d.mode || "auto";
    $("#agent-delivery-action").value = d.action || "";
    $("#agent-webhook-url").value = d.webhook_url || "";
    $("#agent-webhook-token").value = d.webhook_token || "";
    $("#agent-enabled").checked = agent ? !!agent.enabled : true;
    delete $("#agent-form").dataset.thenAssign;
    $("#agent-modal").hidden = false;
    $("#agent-name").focus();
  }
  $("#btn-add-agent").addEventListener("click", () => openAgentModal(null));
  $("#agent-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = $("#agent-id").value;
    const body = {
      name: $("#agent-name").value.trim(),
      platform: $("#agent-platform").value.trim().toLowerCase(),
      key: $("#agent-key").value.trim() || undefined,
      purpose: $("#agent-purpose").value.trim() || null,
      schedule: $("#agent-schedule").value.trim() || null,
      native_url: $("#agent-url").value.trim() || null,
      keywords: $("#agent-keywords").value.trim() || null,
      delivery: {
        mode: $("#agent-delivery-mode").value || "auto",
        action: $("#agent-delivery-action").value.trim() || undefined,
        webhook_url: $("#agent-webhook-url").value.trim() || undefined,
        webhook_token: $("#agent-webhook-token").value.trim() || undefined,
      },
      enabled: $("#agent-enabled").checked,
    };
    try {
      const saved = id ? await api(`/agents/${id}`, { method: "PUT", body }) : await api("/agents", { method: "POST", body });
      $("#agent-modal").hidden = true;
      const thenAssign = $("#agent-form").dataset.thenAssign;
      if (thenAssign && saved?.id) {
        delete $("#agent-form").dataset.thenAssign;
        const m = await api(`/messages/${thenAssign}/assign`, { method: "POST", body: { agent_id: saved.id } });
        toast(m.status === "failed" ? `Agent saved, but delivery failed: ${m.error}` : `Agent saved and instruction sent. ${cap(m.delivery_hint)}`, m.status === "failed" ? "bad" : "ok");
      } else {
        toast("Agent saved", "ok");
      }
      await refresh();
    } catch (err) {
      fail(err);
    }
  });

  /* ---------- platform settings ---------- */
  async function openPlatformSettings(id) {
    const p = await api(`/platforms/${id}`);
    $("#platform-modal-title").textContent = `${p.name} settings`;
    $("#pf-id").value = p.id;
    for (const f of ["name", "appUrl", "tasksUrl", "nativeUrlTemplate", "sessionCookie", "cookieDomain", "loggedInSelector", "snapshotSelector", "notes"]) $(`#pf-${f}`).value = p[f] ?? "";
    $("#pf-capturePatterns").value = (p.capturePatterns || []).join("\n");
    $("#pf-loginUrlPatterns").value = (p.loginUrlPatterns || []).join("\n");
    $("#pf-actions").value = Object.keys(p.actions || {}).length ? JSON.stringify(p.actions, null, 2) : "";
    const disc = (p.state?.meta?.discovered || []).slice(0, 60);
    $("#pf-discovered-list").innerHTML = disc.length
      ? disc.map((d) => `<div class="rowitem ${d.matched ? "s-ok" : ""}"><div class="body endpoint">${d.matched ? "✓ " : ""}${esc(d.url)} <span class="muted">(${d.status}${d.size ? ", " + Math.round(d.size / 1024) + " KB" : ""})</span></div></div>`).join("")
      : '<p class="empty">Nothing captured yet. Sync this platform first.</p>';
    $("#platform-modal").hidden = false;
  }
  $("#platform-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = $("#pf-id").value;
    const lines = (v) => v.split("\n").map((s) => s.trim()).filter(Boolean);
    let actions = {};
    const rawActions = $("#pf-actions").value.trim();
    if (rawActions) {
      try {
        actions = JSON.parse(rawActions);
      } catch {
        return toast("Actions must be valid JSON.", "bad");
      }
    }
    const body = {
      name: $("#pf-name").value.trim(),
      appUrl: $("#pf-appUrl").value.trim(),
      tasksUrl: $("#pf-tasksUrl").value.trim(),
      nativeUrlTemplate: $("#pf-nativeUrlTemplate").value.trim(),
      sessionCookie: $("#pf-sessionCookie").value.trim(),
      cookieDomain: $("#pf-cookieDomain").value.trim(),
      loggedInSelector: $("#pf-loggedInSelector").value.trim(),
      snapshotSelector: $("#pf-snapshotSelector").value.trim() || "main",
      notes: $("#pf-notes").value.trim(),
      capturePatterns: lines($("#pf-capturePatterns").value),
      loginUrlPatterns: lines($("#pf-loginUrlPatterns").value),
      actions,
    };
    try {
      await api(`/platforms/${id}`, { method: "PUT", body });
      $("#platform-modal").hidden = true;
      toast("Settings saved", "ok");
      await refresh();
    } catch (err) {
      fail(err);
    }
  });
  $("#pf-reset").addEventListener("click", async () => {
    const id = $("#pf-id").value;
    if (!confirm("Reset this platform to the built-in defaults?")) return;
    await api(`/platforms/${id}/overrides`, { method: "DELETE" });
    $("#platform-modal").hidden = true;
    toast("Defaults restored", "ok");
    refresh();
  });

  /* ---------- boot ---------- */
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      for (const o of $$(".overlay:not(#login)")) o.hidden = true;
      for (const d of $$("details.menu[open]")) d.removeAttribute("open");
    }
  });
  refresh();
  setInterval(() => {
    if (document.visibilityState === "visible" && !$$(".overlay").some((o) => !o.hidden) && !$$("details.menu[open]").length) refresh();
  }, 30_000);
})();
