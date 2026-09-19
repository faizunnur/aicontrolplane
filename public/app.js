/* AI Control Plane dashboard. Vanilla JS, talks to /api. */
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  let state = { overview: null, agents: [], runs: [], events: [], platforms: [] };
  let refreshTimer = null;

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

  function toast(msg, bad = false) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.toggle("bad", bad);
    t.classList.remove("hidden");
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.add("hidden"), bad ? 6000 : 3500);
  }

  /* ---------- login ---------- */
  function showLogin() {
    $("#login").classList.remove("hidden");
    $("#login-token").focus();
  }
  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const token = $("#login-token").value.trim();
    try {
      await api("/session", { method: "POST", body: { token } });
      $("#login").classList.add("hidden");
      $("#login-error").classList.add("hidden");
      $("#login-token").value = "";
      refresh();
    } catch {
      $("#login-error").classList.remove("hidden");
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
    if (diff < 60) return "just now";
    if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
    if (diff < 86400 * 14) return `${Math.floor(diff / 86400)} d ago`;
    return d.toLocaleDateString();
  };
  const sessionBadge = (s) =>
    ({
      logged_in: '<span class="badge ok">signed in</span>',
      needs_login: '<span class="badge warn">login required</span>',
      error: '<span class="badge bad">error</span>',
    })[s] || '<span class="badge neutral">not synced</span>';
  const runBadge = (s) =>
    ({
      success: '<span class="badge ok">success</span>',
      failed: '<span class="badge bad">failed</span>',
      needs_attention: '<span class="badge warn">needs attention</span>',
      running: '<span class="badge info">running</span>',
    })[s] || `<span class="badge neutral">${esc(s || "unknown")}</span>`;
  const platformName = (id) => state.platforms.find((p) => p.id === id)?.name || id;

  /* ---------- render ---------- */
  function renderPills() {
    const c = state.overview.counts;
    $("#pills").innerHTML = [
      `<span class="pill"><b>${c.agents}</b>agents</span>`,
      `<span class="pill"><b>${c.runs24h}</b>runs · 24h</span>`,
      `<span class="pill ${c.failed7d ? "bad" : ""}"><b>${c.failed7d}</b>failed · 7d</span>`,
      `<span class="pill ${c.unreadEvents ? "warn" : ""}"><b>${c.unreadEvents}</b>unread</span>`,
    ].join("");
    const s = state.overview.scheduler;
    $("#scheduler-status").textContent = !s.enabled
      ? "auto-sync off"
      : s.running
        ? "syncing…"
        : `auto-sync every ${s.intervalMin} min · next ${s.nextAt ? rel(s.nextAt).replace("ago", "").trim() || "soon" : "—"}`;
    $("#btn-sync-all").disabled = !state.overview.browser.enabled || s.running;
    $("#btn-vnc").classList.toggle("hidden", !state.overview.browser.enabled || state.overview.browser.headless);
  }

  function renderSetup() {
    const anyLoggedIn = state.platforms.some((p) => p.state.session_status === "logged_in");
    $("#setup").classList.toggle("hidden", anyLoggedIn || state.agents.length > 0);
  }

  function renderAttention() {
    const a = state.overview.attention;
    const items = [];
    for (const s of a.sessions) {
      items.push(
        `<div class="item unread"><div class="body"><div class="title">${esc(s.name)} needs login</div><div class="sub">Open the browser screen and sign in. Sync afterwards.</div></div>
         <div class="actions"><a class="btn small" href="/vnc/" target="_blank" rel="noopener">Browser screen</a></div></div>`,
      );
    }
    for (const r of a.runs) {
      items.push(
        `<div class="item"><div class="body"><div class="title">${esc(r.agent_name)} ${runBadge(r.status)}</div><div class="sub">${esc(r.summary || "")} · ${esc(platformName(r.platform))} · ${rel(r.finished_at || r.started_at || r.created_at)}</div></div>
         <div class="actions">${r.output_url || r.agent_native_url ? `<a class="btn small" target="_blank" rel="noopener" href="${esc(r.output_url || r.agent_native_url)}">Open</a>` : ""}</div></div>`,
      );
    }
    for (const e of a.events) {
      items.push(
        `<div class="item unread"><div class="body"><div class="title">${esc(e.title)}</div><div class="sub">${esc((e.body || "").slice(0, 200))} · ${esc(platformName(e.platform || ""))} · ${rel(e.occurred_at)}</div></div>
         <div class="actions">${e.link ? `<a class="btn small" target="_blank" rel="noopener" href="${esc(e.link)}">Open</a>` : ""}<button class="btn small" data-read="${e.id}">Read</button></div></div>`,
      );
    }
    $("#attention").classList.toggle("hidden", items.length === 0);
    $("#attention-list").innerHTML = items.join("");
  }

  function renderPlatforms() {
    const html = state.platforms.map((p) => {
      const s = p.state;
      const shot = p.hasScreenshot
        ? `<img class="shot" data-shot="${p.id}" src="/api/platforms/${p.id}/screenshot.png?t=${encodeURIComponent(s.last_sync_at || "")}" alt="${esc(p.name)} screenshot" loading="lazy" />`
        : `<div class="shot-placeholder">${p.syncable ? "No screenshot yet. Press Sync." : "Registry-only platform. Set a tasks URL in settings to sync it through the browser."}</div>`;
      const actions = p.actions
        .filter((a) => a.id !== "sync")
        .map((a) => `<button class="btn small" data-action="${a.id}" data-platform="${p.id}" title="${esc(a.description)}">${esc(a.label)}</button>`)
        .join("");
      return `<div class="card platform" data-platform-card="${p.id}">
        <div class="platform-head"><h3>${esc(p.name)}</h3>${p.syncable ? sessionBadge(s.session_status) : '<span class="badge neutral">registry</span>'}</div>
        ${shot}
        <div class="platform-meta">
          <span>${p.agents} agent${p.agents === 1 ? "" : "s"} · last sync ${rel(s.last_sync_at)}${s.last_error ? ` · <span class="error">${esc(s.last_error)}</span>` : ""}</span>
          ${p.notes ? `<span>${esc(p.notes)}</span>` : ""}
        </div>
        <div class="row">
          ${p.syncable ? `<button class="btn small primary" data-sync="${p.id}">Sync</button>` : ""}
          ${actions}
          <button class="btn small ghost" data-settings="${p.id}">Settings</button>
        </div>
      </div>`;
    });
    $("#platforms").innerHTML = html.join("");
  }

  function renderAgents() {
    const filter = $("#agent-filter").value;
    const rows = state.agents.filter((a) => !filter || a.platform === filter);
    $("#agents-empty").classList.toggle("hidden", rows.length > 0);
    const platformActions = (a) => {
      const p = state.platforms.find((x) => x.id === a.platform);
      if (!p) return "";
      return p.actions
        .filter((x) => x.id !== "sync" && x.id !== "screenshot")
        .map((x) => `<button class="btn small ghost" data-agent-action="${x.id}" data-agent="${a.id}" data-platform="${p.id}" title="${esc(x.description)}">${esc(x.label)}</button>`)
        .join("");
    };
    $("#agents-table tbody").innerHTML = rows
      .map(
        (a) => `<tr>
          <td><div>${esc(a.name)}${a.enabled ? "" : ' <span class="badge neutral">disabled</span>'}${a.status ? ` <span class="badge neutral">${esc(a.status)}</span>` : ""}</div>${a.purpose ? `<div class="sub">${esc(a.purpose.slice(0, 140))}</div>` : ""}</td>
          <td>${esc(platformName(a.platform))}</td>
          <td>${esc(a.schedule || "—")}</td>
          <td>${a.last_run ? `${runBadge(a.last_run.status)}<div class="sub">${rel(a.last_run.finished_at || a.last_run.started_at || a.last_run.created_at)}${a.last_run.summary ? " · " + esc(a.last_run.summary.slice(0, 80)) : ""}</div>` : '<span class="sub">no runs</span>'}</td>
          <td><span class="badge neutral">${esc(a.source)}</span></td>
          <td class="actions">
            ${a.native_url ? `<a class="btn small ghost" target="_blank" rel="noopener" href="${esc(a.native_url)}">Link</a>` : ""}
            ${platformActions(a)}
            <button class="btn small ghost" data-edit="${a.id}">Edit</button>
            <button class="btn small ghost danger" data-delete="${a.id}">Delete</button>
          </td>
        </tr>`,
      )
      .join("");
  }

  function renderRuns() {
    $("#runs").innerHTML =
      state.runs
        .slice(0, 25)
        .map(
          (r) => `<div class="item"><div class="body"><div class="title">${esc(r.agent_name)} ${runBadge(r.status)}</div>
            <div class="sub">${esc(platformName(r.platform))} · ${rel(r.finished_at || r.started_at || r.created_at)} · via ${esc(r.source)}${r.summary ? "<br/>" + esc(r.summary.slice(0, 220)) : ""}</div></div>
            <div class="actions">${r.output_url ? `<a class="btn small" target="_blank" rel="noopener" href="${esc(r.output_url)}">Output</a>` : ""}</div></div>`,
        )
        .join("") || '<p class="muted">No runs recorded yet.</p>';
  }

  function renderEvents() {
    $("#events").innerHTML =
      state.events
        .slice(0, 25)
        .map(
          (e) => `<div class="item ${e.read ? "" : "unread"}"><div class="body"><div class="title">${esc(e.title)}</div>
            <div class="sub">${esc(platformName(e.platform || ""))} · ${esc(e.kind)} · ${rel(e.occurred_at)}${e.body ? "<br/>" + esc(e.body.slice(0, 220)) : ""}</div></div>
            <div class="actions">${e.link ? `<a class="btn small" target="_blank" rel="noopener" href="${esc(e.link)}">Open</a>` : ""}${e.read ? "" : `<button class="btn small ghost" data-read="${e.id}">Read</button>`}</div></div>`,
        )
        .join("") || '<p class="muted">No events yet. Failed runs, login prompts and ingested emails show up here.</p>';
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
      // One cheap call first so an expired session shows the login overlay without a burst of 401s.
      await api("/session");
      const [overview, agents, runs, events] = await Promise.all([api("/overview"), api("/agents?all=1"), api("/runs?limit=40"), api("/events?limit=40")]);
      state = { overview, agents, runs, events, platforms: overview.platforms };
      renderFilters();
      renderPills();
      renderSetup();
      renderAttention();
      renderPlatforms();
      renderAgents();
      renderRuns();
      renderEvents();
      renderIngestExample();
    } catch (err) {
      if (err.message !== "unauthorized") toast(err.message, true);
    }
  }

  /* ---------- actions ---------- */
  document.addEventListener("click", async (e) => {
    const t = e.target.closest("[data-sync],[data-action],[data-settings],[data-shot],[data-read],[data-edit],[data-delete],[data-agent-action],[data-close]");
    if (!t) {
      const ov = e.target.closest("[data-close-on-click]");
      if (ov && e.target === ov) ov.classList.add("hidden");
      return;
    }
    try {
      if (t.dataset.close !== undefined) {
        t.closest(".overlay").classList.add("hidden");
      } else if (t.dataset.sync) {
        t.disabled = true;
        toast(`Syncing ${platformName(t.dataset.sync)}…`);
        const r = await api(`/platforms/${t.dataset.sync}/sync`, { method: "POST" });
        toast(`${platformName(t.dataset.sync)}: ${r.message || (r.ok ? "synced" : "failed")}`, !r.ok);
        await refresh();
      } else if (t.dataset.action) {
        t.disabled = true;
        const r = await api(`/platforms/${t.dataset.platform}/actions/${t.dataset.action}`, { method: "POST", body: {} });
        toast(r.message, !r.ok);
        if (t.dataset.action === "open" && r.ok && !state.overview.browser.headless) window.open("/vnc/", "_blank", "noopener");
        await refresh();
      } else if (t.dataset.agentAction) {
        t.disabled = true;
        const r = await api(`/platforms/${t.dataset.platform}/actions/${t.dataset.agentAction}`, { method: "POST", body: { agent_id: Number(t.dataset.agent) } });
        toast(r.message, !r.ok);
        if (t.dataset.agentAction === "open" && r.ok && !state.overview.browser.headless) window.open("/vnc/", "_blank", "noopener");
        await refresh();
      } else if (t.dataset.settings) {
        await openPlatformSettings(t.dataset.settings);
      } else if (t.dataset.shot) {
        $("#shot-img").src = `/api/platforms/${t.dataset.shot}/screenshot.png?t=${Date.now()}`;
        $("#shot-modal").classList.remove("hidden");
      } else if (t.dataset.read) {
        await api(`/events/${t.dataset.read}/read`, { method: "POST", body: {} });
        await refresh();
      } else if (t.dataset.edit) {
        openAgentModal(state.agents.find((a) => a.id === Number(t.dataset.edit)));
      } else if (t.dataset.delete) {
        const a = state.agents.find((x) => x.id === Number(t.dataset.delete));
        if (a && confirm(`Delete "${a.name}" and its run history?`)) {
          await api(`/agents/${a.id}`, { method: "DELETE" });
          toast("Agent deleted");
          await refresh();
        }
      }
    } catch (err) {
      if (err.message !== "unauthorized") toast(err.message, true);
    } finally {
      if (t.tagName === "BUTTON") t.disabled = false;
    }
  });

  $("#btn-sync-all").addEventListener("click", async () => {
    try {
      $("#btn-sync-all").disabled = true;
      toast("Syncing every platform… this takes a minute.");
      const r = await api("/sync", { method: "POST", body: {} });
      const summary = Object.values(r.results)
        .map((x) => `${platformName(x.platform)}: ${x.message || (x.ok ? "ok" : "failed")}`)
        .join(" · ");
      toast(summary || "Nothing to sync. Set a tasks URL on a platform first.");
      await refresh();
    } catch (err) {
      if (err.message !== "unauthorized") toast(err.message, true);
    } finally {
      $("#btn-sync-all").disabled = false;
    }
  });
  $("#btn-refresh").addEventListener("click", refresh);
  $("#btn-read-all").addEventListener("click", async () => {
    await api("/events/read-all", { method: "POST", body: {} });
    refresh();
  });
  $("#agent-filter").addEventListener("change", renderAgents);

  /* ---------- agent modal ---------- */
  function openAgentModal(agent) {
    $("#agent-modal-title").textContent = agent ? "Edit agent" : "Add agent";
    $("#agent-id").value = agent?.id ?? "";
    $("#agent-name").value = agent?.name ?? "";
    $("#agent-platform").value = agent?.platform ?? "";
    $("#agent-key").value = agent?.key ?? "";
    $("#agent-purpose").value = agent?.purpose ?? "";
    $("#agent-schedule").value = agent?.schedule ?? "";
    $("#agent-url").value = agent?.native_url ?? "";
    $("#agent-enabled").checked = agent ? !!agent.enabled : true;
    $("#agent-modal").classList.remove("hidden");
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
      enabled: $("#agent-enabled").checked,
    };
    try {
      if (id) await api(`/agents/${id}`, { method: "PUT", body });
      else await api("/agents", { method: "POST", body });
      $("#agent-modal").classList.add("hidden");
      toast("Agent saved");
      await refresh();
    } catch (err) {
      toast(err.message, true);
    }
  });

  /* ---------- platform settings ---------- */
  async function openPlatformSettings(id) {
    const p = await api(`/platforms/${id}`);
    $("#platform-modal-title").textContent = `${p.name} settings`;
    $("#pf-id").value = p.id;
    for (const f of ["name", "appUrl", "tasksUrl", "nativeUrlTemplate", "sessionCookie", "cookieDomain", "loggedInSelector", "snapshotSelector", "notes"]) {
      $(`#pf-${f}`).value = p[f] ?? "";
    }
    $("#pf-capturePatterns").value = (p.capturePatterns || []).join("\n");
    $("#pf-loginUrlPatterns").value = (p.loginUrlPatterns || []).join("\n");
    $("#pf-actions").value = Object.keys(p.actions || {}).length ? JSON.stringify(p.actions, null, 2) : "";
    const disc = (p.state?.meta?.discovered || []).slice(0, 60);
    $("#pf-discovered-list").innerHTML = disc.length
      ? disc.map((d) => `<div class="item"><div class="body endpoint">${d.matched ? "✓ " : "· "}${esc(d.url)} <span class="muted">(${d.status}${d.size ? ", " + Math.round(d.size / 1024) + " KB" : ""})</span></div></div>`).join("")
      : '<p class="muted small">Nothing captured yet. Sync this platform first.</p>';
    $("#platform-modal").classList.remove("hidden");
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
        return toast("Custom actions must be valid JSON", true);
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
      $("#platform-modal").classList.add("hidden");
      toast("Platform saved");
      await refresh();
    } catch (err) {
      toast(err.message, true);
    }
  });
  $("#pf-reset").addEventListener("click", async () => {
    const id = $("#pf-id").value;
    if (!confirm("Reset this platform to built-in defaults?")) return;
    await api(`/platforms/${id}/overrides`, { method: "DELETE" });
    $("#platform-modal").classList.add("hidden");
    toast("Defaults restored");
    refresh();
  });

  /* ---------- boot ---------- */
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") $$(".overlay:not(#login)").forEach((o) => o.classList.add("hidden"));
  });
  refresh();
  refreshTimer = setInterval(() => {
    if (document.visibilityState === "visible" && $$(".overlay:not(.hidden)").length === 0) refresh();
  }, 30_000);
  void refreshTimer;
})();
