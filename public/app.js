/* AI Control Plane — Chat · Dashboard · Connect */
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  let home = null;
  let target = ""; // "" = auto
  let currentTab = "chat";
  let pollTimer = null;
  let connecting = null; // platform id shown in the sign-in screen

  /* ---------- theme ---------- */
  const THEMES = ["system", "light", "dark"];
  let theme = "system";
  try { theme = localStorage.getItem("acp-theme") || "system"; } catch { theme = "system"; }
  function applyTheme(t) {
    if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
    else document.documentElement.removeAttribute("data-theme");
    $("#btn-theme").textContent = t === "light" ? "☀" : t === "dark" ? "☾" : "◐";
    $("#btn-theme").title = `Theme: ${t}`;
  }
  applyTheme(theme);
  $("#btn-theme").addEventListener("click", () => {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    try { localStorage.setItem("acp-theme", theme); } catch { /* per-viewer only */ }
    applyTheme(theme);
  });

  /* ---------- api ---------- */
  async function api(path, opts = {}) {
    const res = await fetch("/api" + path, {
      headers: { "content-type": "application/json", ...(opts.headers || {}) },
      credentials: "same-origin",
      ...opts,
      body: opts.body !== undefined && typeof opts.body !== "string" ? JSON.stringify(opts.body) : opts.body,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      showGate(data.setup ? "setup" : "login");
      throw new Error("unauthorized");
    }
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
  const fail = (err) => { if (err && err.message !== "unauthorized") toast(err.message || String(err), "bad"); };
  async function busy(btn, fn) {
    if (btn) btn.classList.add("busy");
    try { return await fn(); } finally { if (btn) btn.classList.remove("busy"); }
  }
  const rel = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d)) return "";
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return "just now";
    if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
    if (diff < 86400 * 14) return `${Math.floor(diff / 86400)} d ago`;
    return d.toLocaleDateString();
  };
  const conn = (id) => home?.connections.find((c) => c.id === id);
  const aiName = (id) => conn(id)?.name || id || "an AI";

  /* ---------- gate ---------- */
  let gateMode = "login";
  function showGate(mode) {
    gateMode = mode;
    $("#gate").hidden = false;
    $("#gate-title").textContent = mode === "setup" ? "Create your password" : "Welcome back";
    $("#gate-text").textContent = mode === "setup" ? "This is the only password you need. It protects your chats and your saved sign-ins." : "Enter your password to open the console.";
    $("#gate-submit").textContent = mode === "setup" ? "Create password" : "Open";
    $("#gate-password").setAttribute("autocomplete", mode === "setup" ? "new-password" : "current-password");
    $("#gate-password").setAttribute("minlength", mode === "setup" ? "8" : "1");
    $("#gate-password").focus();
  }
  $("#gate-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const password = $("#gate-password").value;
    try {
      if (gateMode === "setup") await api("/setup", { method: "POST", body: { password } });
      else {
        const res = await fetch("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "That password was not accepted.");
      }
      $("#gate").hidden = true;
      $("#gate-error").hidden = true;
      $("#gate-password").value = "";
      await load();
      if (home && home.connectedCount === 0 && !location.hash) go("connect");
    } catch (err) {
      $("#gate-error").textContent = err.message;
      $("#gate-error").hidden = false;
    }
  });

  /* ---------- tabs ---------- */
  function go(tab) { location.hash = tab; }
  function showTab() {
    const tab = (location.hash || "").replace("#", "") || (home && home.connectedCount === 0 ? "connect" : "chat");
    currentTab = ["chat", "dashboard", "connect"].includes(tab) ? tab : "chat";
    for (const s of $$(".screen")) s.hidden = s.id !== `screen-${currentTab}`;
    for (const t of $$(".tab")) t.classList.toggle("active", t.dataset.tab === currentTab);
    if (home) render();
    if (currentTab === "chat") scrollThread(true);
  }
  window.addEventListener("hashchange", showTab);

  /* ---------- load & render ---------- */
  async function load() {
    try {
      home = await api("/home");
      render();
      schedulePoll();
    } catch (err) { fail(err); }
  }
  function schedulePoll() {
    clearTimeout(pollTimer);
    const inFlight = home?.chat.some((m) => ["assigned", "delivered"].includes(m.status));
    pollTimer = setTimeout(() => { if (document.visibilityState === "visible" && !$$(".overlay").some((o) => !o.hidden)) load(); else schedulePoll(); }, inFlight ? 3000 : 30000);
  }
  function render() {
    renderBadges();
    if (currentTab === "chat") renderChat();
    if (currentTab === "dashboard") renderDashboard();
    if (currentTab === "connect") renderConnect();
  }
  function renderBadges() {
    const n = home.attention.length;
    $("#badge-attention").hidden = !n;
    $("#badge-attention").textContent = n;
    const needs = home.connections.filter((c) => c.status === "needs_login").length;
    $("#badge-connect").hidden = !needs;
    $("#badge-connect").textContent = needs;
  }

  /* ---------- chat ---------- */
  const STATUS_TEXT = {
    assigned: (m) => `Sending to ${aiName(m.platform)}…`,
    delivered: (m) => `${aiName(m.platform)} is working on it…`,
  };
  function renderChat() {
    const connected = home.connections.filter((c) => c.status === "logged_in" && c.canChat);
    const chattable = home.connections.filter((c) => c.canChat);
    $("#targets").innerHTML =
      `<button type="button" class="chip ${target === "" ? "active" : ""}" data-target="" role="radio" aria-checked="${target === ""}">Auto</button>` +
      chattable.map((c) => `<button type="button" class="chip ${target === c.id ? "active" : ""}" data-target="${c.id}" role="radio" aria-checked="${target === c.id}" ${c.status === "logged_in" ? "" : 'title="Not connected"'}><span class="dot ${c.status === "logged_in" ? "ok" : c.status === "needs_login" ? "warn" : ""}"></span>${esc(c.name)}</button>`).join("");
    $("#chat-send").disabled = chattable.length === 0;

    const thread = $("#thread");
    if (!home.chat.length) {
      thread.innerHTML = `<div class="thread-empty"><strong>${connected.length ? "Tell your AIs what to do." : "Connect an AI first."}</strong>${connected.length ? `Type an instruction below. It goes to the right AI, and the answer comes back here. Name one to be explicit: “Grok, what's trending in AI today?”` : `Open <a href="#connect">Connect</a> and sign in to ChatGPT, Claude or Grok. Then come back here.`}</div>`;
      return;
    }
    thread.innerHTML = home.chat.map((m) => {
      const who = aiName(m.platform);
      let reply = "";
      if (m.status === "needs_assignment") {
        const opts = (m.suggestions || []).filter((o) => o.platform);
        reply = `<div class="bubble system">${esc(m.routing?.reason || "Which AI should do this?")}</div>
          <div class="choices">${opts.map((o) => `<button class="btn small" data-send="${m.id}" data-platform="${esc(o.platform)}" title="${esc(o.reason || "")}">${esc(o.name)}${o.confidence >= 0.5 ? ` <span class="muted">${Math.round(o.confidence * 100)}%</span>` : ""}</button>`).join("")}
          ${home.connections.filter((c) => c.canChat && !opts.some((o) => o.platform === c.id)).map((c) => `<button class="btn small ghost" data-send="${m.id}" data-platform="${c.id}">${esc(c.name)}</button>`).join("")}</div>`;
      } else if (m.status === "assigned" || m.status === "delivered") {
        reply = `<div class="bubble system"><span class="typing"><i></i><i></i><i></i></span> ${esc(STATUS_TEXT[m.status](m))}</div>`;
      } else if (m.status === "failed") {
        reply = `<div class="bubble error">${esc(m.error || "Something went wrong.")}</div>
          <div class="choices"><button class="btn small" data-send="${m.id}" data-platform="${esc(m.platform || "")}" ${m.platform ? "" : "hidden"}>Try again</button>
          ${home.connections.filter((c) => c.canChat && c.id !== m.platform).map((c) => `<button class="btn small ghost" data-send="${m.id}" data-platform="${c.id}">Send to ${esc(c.name)}</button>`).join("")}</div>`;
      } else if (m.response) {
        reply = `<div class="meta"><span class="who">${esc(who)}</span> ${rel(m.acked_at || m.delivered_at || m.updated_at)}</div><div class="bubble ai">${esc(m.response)}</div>`;
      } else {
        reply = `<div class="bubble system">Sent to ${esc(who)}.</div>`;
      }
      const routeNote = m.routing && m.routing.method !== "manual" && m.platform && m.status !== "needs_assignment" ? ` · ${esc(m.routing.method === "mention" ? "you named it" : m.routing.method === "only" ? "only AI connected" : m.routing.method === "llm" ? "picked by Claude" : "picked by keywords")}` : "";
      return `<div class="turn" id="message-${m.id}">
        <div class="meta me">${rel(m.created_at)}${m.platform ? ` · to ${esc(aiName(m.platform))}` : ""}${routeNote} <button class="btn small ghost icon" data-del="${m.id}" title="Remove" aria-label="Remove">✕</button></div>
        <div class="bubble me">${esc(m.text)}</div>${reply}</div>`;
    }).join("");
    scrollThread(false);
  }
  let lastScrollHeight = 0;
  function scrollThread(force) {
    const t = $("#thread");
    if (force || t.scrollHeight !== lastScrollHeight) t.scrollTop = t.scrollHeight;
    lastScrollHeight = t.scrollHeight;
  }
  $("#targets").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-target]");
    if (!chip) return;
    target = chip.dataset.target;
    renderChat();
    $("#chat-text").focus();
  });
  $("#composer").addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = $("#chat-text").value.trim();
    if (!text) return;
    try {
      await busy($("#chat-send"), async () => {
        const r = await api("/chat", { method: "POST", body: { text, ...(target ? { platform: target } : {}) } });
        $("#chat-text").value = "";
        autogrow();
        if (!r.routed) toast("Not sure which AI should do this. Pick one in the thread.");
      });
      await load();
      scrollThread(true);
    } catch (err) { fail(err); }
  });
  const ta = $("#chat-text");
  function autogrow() { ta.style.height = "auto"; ta.style.height = Math.min(160, ta.scrollHeight) + "px"; }
  ta.addEventListener("input", autogrow);
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#composer").requestSubmit(); }
  });

  /* ---------- dashboard ---------- */
  function renderDashboard() {
    const a = home.attention;
    $("#attention").innerHTML = [
      home.browser.enabled && home.storage?.persistent === false ? `<div class="notice warn"><div class="body"><strong>Your sign-ins will be lost on the next deploy.</strong><div class="sub">The server's data folder is not on a persistent disk. Attach a volume at ${esc(home.storage.dataDir)}, or download your sign-ins from Settings.</div></div><button class="btn small" data-open-settings="general">Open Settings</button></div>` : "",
      ...a.map((x) => {
        const cls = x.kind === "session" ? "warn" : x.kind === "run" ? "bad" : x.action === "retry" ? "bad" : "warn";
        const btn = x.action === "connect" ? `<button class="btn small primary" data-connect="${esc(x.platform)}">Sign in</button>`
          : x.action === "choose" || x.action === "retry" ? `<a class="btn small" href="#chat">Open chat</a>`
          : `<button class="btn small ghost" data-read="${x.id}">Dismiss</button>`;
        return `<div class="notice ${cls}"><div class="body"><strong>${esc(x.title)}</strong>${x.body ? `<div class="sub">${esc(String(x.body).slice(0, 200))}</div>` : ""}</div>${x.link ? `<a class="btn small" target="_blank" rel="noopener" href="${esc(x.link)}">Open</a>` : ""}${btn}</div>`;
      }),
    ].join("") || `<div class="notice"><div class="body"><strong>All quiet.</strong><div class="sub">Nothing needs you right now.</div></div></div>`;

    $("#ai-cards").innerHTML = home.connections.filter((c) => c.appUrl).map((c) => {
      const dot = c.status === "logged_in" ? "ok" : c.status === "needs_login" ? "warn" : c.status === "error" ? "bad" : "";
      const label = c.status === "logged_in" ? "connected" : c.status === "needs_login" ? "sign in again" : c.status === "error" ? "problem" : "not connected";
      const tasks = c.tasks.slice(0, 5).map((t) => `<div class="task"><span class="name" title="${esc(t.name)}">${esc(t.name)}</span>${t.last_run ? `<span class="badge ${runCls(t.last_run.status)}">${esc(runLabel(t.last_run.status))}</span>` : `<span class="sched">${esc(t.schedule || "")}</span>`}</div>`).join("");
      return `<article class="ai-card" id="ai-${c.id}">
        <div class="head"><span class="dot ${dot}"></span><h3>${esc(c.name)}</h3><span class="muted small">${label}</span></div>
        ${c.hasScreenshot ? `<img class="shot" data-shot="${c.id}" src="/api/platforms/${c.id}/screenshot.png?t=${encodeURIComponent(c.lastSync || "")}" alt="${esc(c.name)} screen" loading="lazy" />` : ""}
        <div class="tasks">${tasks || `<span class="muted small">${c.status === "logged_in" ? (c.canSync ? "No scheduled tasks found yet." : "Ready for instructions.") : "Connect to see what it is doing."}</span>`}${c.tasks.length > 5 ? `<span class="muted small">+${c.tasks.length - 5} more</span>` : ""}</div>
        <div class="foot"><span>${c.lastSync ? `checked ${rel(c.lastSync)}` : ""}${c.lastError ? ` · <span style="color:var(--bad)">${esc(c.lastError)}</span>` : ""}</span>
          <span class="row">${c.status === "logged_in" ? `<button class="btn small ghost" data-refresh="${c.id}" title="Look at ${esc(c.name)} again now">Refresh</button><button class="btn small ghost" data-view="${c.id}">Open</button>` : `<button class="btn small primary" data-connect="${c.id}">Sign in</button>`}</span></div>
      </article>`;
    }).join("");

    $("#activity").innerHTML = home.activity.map((x) => `<div class="rowitem s-${runCls(x.status) || "run"}"><div class="body"><div class="title">${esc(x.title)} ${x.status && x.status !== "info" ? `<span class="badge ${runCls(x.status)}">${esc(runLabel(x.status))}</span>` : ""}</div><div class="sub">${esc(aiName(x.platform))}${x.summary ? " · " + esc(String(x.summary).slice(0, 160)) : ""} · ${rel(x.at)}</div></div>${x.link ? `<a class="btn small ghost" target="_blank" rel="noopener" href="${esc(x.link)}">Open</a>` : ""}</div>`).join("")
      || `<p class="empty">Nothing yet. Once your AIs run tasks or answer instructions, it shows up here.</p>`;
  }
  const runCls = (s) => ({ success: "ok", failed: "bad", needs_attention: "warn", running: "run" })[s] || "";
  const runLabel = (s) => ({ success: "ok", failed: "failed", needs_attention: "needs you", running: "running" })[s] || s || "";

  /* ---------- connect ---------- */
  function renderConnect() {
    $("#connections").innerHTML = home.connections.filter((c) => c.appUrl || c.builtin).map((c) => {
      const dot = c.status === "logged_in" ? "ok" : c.status === "needs_login" ? "warn" : c.status === "error" ? "bad" : "";
      const label = c.status === "logged_in" ? "Connected" : c.status === "needs_login" ? "Signed out" : c.status === "error" ? "Problem" : "Not connected";
      const primary = c.status === "logged_in" ? `<button class="btn small" data-connect="${c.id}">Reconnect</button>` : `<button class="btn small primary" data-connect="${c.id}">Connect</button>`;
      return `<div class="conn" id="conn-${c.id}">
        <span class="logo" aria-hidden="true">${esc(c.name.slice(0, 1))}</span>
        <div class="info"><div class="name">${esc(c.name)} <span class="dot ${dot}" title="${label}"></span><span class="muted small">${label}${c.lastError && c.status !== "logged_in" ? ` · ${esc(c.lastError)}` : ""}</span></div><div class="purpose">${esc(c.purpose || "")}</div></div>
        <div class="actions">${primary}
          <details class="menu"><summary class="btn small ghost icon" aria-label="More">…</summary><div class="menu-list">
            <button class="btn small ghost" data-check="${c.id}">Check sign-in</button>
            <button class="btn small ghost" data-open-settings="ai" data-ai="${c.id}">Edit</button>
            <button class="btn small ghost danger" data-remove="${c.id}">Remove</button></div></details></div>
      </div>`;
    }).join("");
  }
  $("#add-ai-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/connections", { method: "POST", body: { name: $("#add-name").value.trim(), appUrl: $("#add-url").value.trim(), purpose: $("#add-purpose").value.trim() } });
      e.target.reset();
      $(".add-ai").removeAttribute("open");
      toast("Added. Press Connect to sign in.", "ok");
      await load();
    } catch (err) { fail(err); }
  });

  /* ---------- sign-in screen ---------- */
  async function openConnect(id, viewOnly = false) {
    const c = conn(id);
    if (!c) return;
    if (!home.browser.enabled || home.browser.headless) return toast("The browser screen is not available on this deployment.", "bad");
    connecting = id;
    $("#connect-title").textContent = viewOnly ? c.name : `Sign in to ${c.name}`;
    $("#connect-help").hidden = viewOnly;
    $("#connect-done").hidden = viewOnly;
    $("#connect-frame").src = "about:blank";
    $("#connect-modal").hidden = false;
    try {
      const r = await api(`/connections/${id}/connect`, { method: "POST", body: {} });
      $("#connect-frame").src = r.screen;
    } catch (err) { fail(err); }
  }
  $("#connect-done").addEventListener("click", async (e) => {
    if (!connecting) return;
    try {
      await busy(e.currentTarget, async () => {
        const r = await api(`/connections/${connecting}/check`, { method: "POST", body: {} });
        if (r.status === "logged_in") {
          toast(`${r.name} is connected.`, "ok");
          $("#connect-modal").hidden = true;
          $("#connect-frame").src = "about:blank";
        } else {
          toast(r.status === "needs_login" ? `${r.name} still looks signed out. Finish signing in, then press again.` : `Could not check ${r.name}: ${r.lastError || "try again"}`, "bad");
        }
      });
      await load();
    } catch (err) { fail(err); }
  });

  /* ---------- settings ---------- */
  let settings = null;
  async function openSettings(tab = "general", aiId = null) {
    try {
      settings = await api("/settings");
      $("#password-note").textContent = settings.passwordFromEnv ? "The password is set on the server (ACP_ADMIN_TOKEN). Change it there." : "";
      $("#password-form").hidden = settings.passwordFromEnv;
      $("#router-note").textContent = settings.router.provider === "claude-code" ? "Claude decides which AI gets each instruction, using your Claude subscription (CLAUDE_CODE_OAUTH_TOKEN)."
        : settings.router.provider === "api" ? `Claude (${settings.router.model}) decides which AI gets each instruction, using your Anthropic API key.`
        : "Instructions go to the AI you name, or to the only connected AI. To let Claude decide between several, set CLAUDE_CODE_OAUTH_TOKEN (from “claude setup-token”) or ANTHROPIC_API_KEY on the server.";
      $("#alerts-note").textContent = settings.alerts.telegram || settings.alerts.webhook ? `Failures and sign-outs are sent to ${[settings.alerts.telegram ? "Telegram" : "", settings.alerts.webhook ? "your webhook" : ""].filter(Boolean).join(" and ")}.` : "Not set up. Add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID, or ALERT_WEBHOOK_URL, on the server to get notified when something fails or an AI signs you out.";
      const st = settings.storage;
      $("#storage-note").textContent = st.persistent === true ? `Sign-ins are saved on a persistent disk${st.backupAt ? ` and were backed up ${rel(st.backupAt)}` : ""}.`
        : st.persistent === false ? `Warning: ${st.dataDir} is not persistent. Sign-ins will be lost on redeploy unless you attach a volume there. Download a copy to be safe.`
        : `Sign-ins are saved under ${st.dataDir}${st.backupAt ? `, backed up ${rel(st.backupAt)}` : ""}.`;
      $("#ingest-token").textContent = settings.ingestToken;
      $("#btn-rotate-token").hidden = settings.ingestTokenFromEnv;
      const base = home?.publicUrl || location.origin;
      $("#ingest-example").textContent = `curl -X POST ${base}/api/ingest \\
  -H "Authorization: Bearer ${settings.ingestToken}" \\
  -H "Content-Type: application/json" \\
  -d '{ "agent": { "key": "nightly-audit", "platform": "custom", "name": "Nightly audit" },
        "run": { "status": "success", "summary": "0 issues found" } }'`;
      const sel = $("#ai-select");
      sel.innerHTML = home.connections.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
      sel.value = aiId || home.connections[0]?.id || "";
      await fillAiForm(sel.value);
      showSettingsTab(tab);
      $("#settings-modal").hidden = false;
    } catch (err) { fail(err); }
  }
  function showSettingsTab(tab) {
    for (const b of $$(".subtab")) b.classList.toggle("active", b.dataset.stab === tab);
    for (const s of $$(".stab")) s.hidden = s.id !== `stab-${tab}`;
  }
  $("#settings-tabs").addEventListener("click", (e) => { const b = e.target.closest("[data-stab]"); if (b) showSettingsTab(b.dataset.stab); });
  $("#btn-settings").addEventListener("click", () => openSettings("general"));
  async function fillAiForm(id) {
    const p = await api(`/platforms/${id}`);
    for (const f of ["name", "purpose", "appUrl", "chatUrl", "tasksUrl", "composerSelector", "sendSelector", "replySelector", "busySelector", "sessionCookie", "cookieDomain"]) $(`#ai-${f}`).value = p[f] ?? "";
    $("#ai-loginUrlPatterns").value = (p.loginUrlPatterns || []).join("\n");
    $("#ai-capturePatterns").value = (p.capturePatterns || []).join("\n");
    $("#ai-form").dataset.id = id;
  }
  $("#ai-select").addEventListener("change", (e) => fillAiForm(e.target.value).catch(fail));
  $("#ai-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = e.target.dataset.id;
    const lines = (v) => v.split("\n").map((s) => s.trim()).filter(Boolean);
    const body = {};
    for (const f of ["name", "purpose", "appUrl", "chatUrl", "tasksUrl", "composerSelector", "sendSelector", "replySelector", "busySelector", "sessionCookie", "cookieDomain"]) body[f] = $(`#ai-${f}`).value.trim();
    body.loginUrlPatterns = lines($("#ai-loginUrlPatterns").value);
    body.capturePatterns = lines($("#ai-capturePatterns").value);
    try { await api(`/connections/${id}`, { method: "PUT", body }); toast("Saved.", "ok"); await load(); } catch (err) { fail(err); }
  });
  $("#ai-restore").addEventListener("click", async () => {
    const id = $("#ai-form").dataset.id;
    if (!confirm("Restore this AI's built-in settings?")) return;
    try { await api(`/connections/${id}/restore`, { method: "POST", body: {} }); await fillAiForm(id); toast("Defaults restored.", "ok"); await load(); } catch (err) { fail(err); }
  });
  $("#ai-remove").addEventListener("click", async () => {
    const id = $("#ai-form").dataset.id;
    if (!confirm(`Remove ${aiName(id)} from the app? You can add it back later.`)) return;
    try { await api(`/connections/${id}`, { method: "DELETE" }); $("#settings-modal").hidden = true; toast("Removed.", "ok"); await load(); } catch (err) { fail(err); }
  });
  $("#password-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/settings/password", { method: "POST", body: { current: $("#pw-current").value, next: $("#pw-next").value } });
      e.target.reset();
      toast("Password changed.", "ok");
    } catch (err) { fail(err); }
  });
  $("#btn-copy-token").addEventListener("click", async () => { await navigator.clipboard.writeText($("#ingest-token").textContent).catch(() => null); toast("Copied.", "ok"); });
  $("#btn-rotate-token").addEventListener("click", async () => {
    if (!confirm("Make a new token? Agents using the old one will stop reporting until you update them.")) return;
    try { const r = await api("/settings/ingest-token/rotate", { method: "POST", body: {} }); $("#ingest-token").textContent = r.ingestToken; toast("New token created.", "ok"); } catch (err) { fail(err); }
  });
  $("#btn-backup").addEventListener("click", async (e) => {
    try { await busy(e.currentTarget, async () => { const r = await api("/browser/backup", { method: "POST", body: {} }); toast(`Backed up ${r.cookies} sign-in cookies.`, "ok"); }); } catch (err) { fail(err); }
  });
  $("#btn-download").addEventListener("click", async (e) => {
    try {
      await busy(e.currentTarget, async () => {
        const state = await api("/browser/export-state");
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([JSON.stringify(state, null, 2)], { type: "application/json" }));
        a.download = `ai-control-plane-signins-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        toast("Downloaded. Keep this file private; it is your sign-ins.", "ok");
      });
    } catch (err) { fail(err); }
  });
  $("#sessions-file").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (!Array.isArray(parsed.cookies)) throw new Error("That file has no sign-ins in it.");
      const r = await api("/browser/import-state", { method: "POST", body: { cookies: parsed.cookies } });
      await api("/browser/backup", { method: "POST", body: {} }).catch(() => null);
      toast(`Restored ${r.imported} cookies. Check each AI on Connect.`, "ok");
      await load();
    } catch (err) { fail(err); } finally { e.target.value = ""; }
  });

  /* ---------- global clicks ---------- */
  document.addEventListener("click", async (e) => {
    for (const d of $$("details.menu[open]")) if (!d.contains(e.target)) d.removeAttribute("open");
    const t = e.target.closest("[data-send],[data-del],[data-connect],[data-view],[data-check],[data-refresh],[data-remove],[data-read],[data-shot],[data-open-settings],[data-close]");
    if (!t) {
      const ov = e.target.closest("[data-close-on-click]");
      if (ov && e.target === ov) ov.hidden = true;
      return;
    }
    const btn = t.tagName === "BUTTON" ? t : null;
    try {
      if (t.dataset.close !== undefined) { t.closest(".overlay").hidden = true; if (t.closest("#connect-modal")) { $("#connect-frame").src = "about:blank"; await load(); } }
      else if (t.dataset.send) { await busy(btn, () => api(`/chat/${t.dataset.send}/send`, { method: "POST", body: { platform: t.dataset.platform } })); await load(); }
      else if (t.dataset.del) { await api(`/chat/${t.dataset.del}`, { method: "DELETE" }); await load(); }
      else if (t.dataset.connect) await openConnect(t.dataset.connect, false);
      else if (t.dataset.view) await openConnect(t.dataset.view, true);
      else if (t.dataset.check) { await busy(btn, async () => { const r = await api(`/connections/${t.dataset.check}/check`, { method: "POST", body: {} }); toast(r.status === "logged_in" ? `${r.name} is connected.` : `${r.name} is signed out.`, r.status === "logged_in" ? "ok" : "bad"); }); await load(); }
      else if (t.dataset.refresh) { await busy(btn, async () => { const c = conn(t.dataset.refresh); if (c?.canSync) await api(`/platforms/${c.id}/sync`, { method: "POST" }); else await api(`/connections/${t.dataset.refresh}/check`, { method: "POST", body: {} }); }); await load(); }
      else if (t.dataset.remove) { if (confirm(`Remove ${aiName(t.dataset.remove)} from the app?`)) { await api(`/connections/${t.dataset.remove}`, { method: "DELETE" }); await load(); } }
      else if (t.dataset.read) { await api(`/events/${t.dataset.read}/read`, { method: "POST", body: {} }); await load(); }
      else if (t.dataset.shot) { $("#shot-img").src = `/api/platforms/${t.dataset.shot}/screenshot.png?t=${Date.now()}`; $("#shot-modal").hidden = false; }
      else if (t.dataset.openSettings) await openSettings(t.dataset.openSettings, t.dataset.ai || null);
    } catch (err) { fail(err); }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { for (const o of $$(".overlay")) o.hidden = true; $("#connect-frame").src = "about:blank"; }
  });

  /* ---------- boot ---------- */
  (async () => {
    try {
      const s = await fetch("/api/setup").then((r) => r.json());
      if (s.setupRequired) return showGate("setup");
      const ok = await fetch("/api/session", { credentials: "same-origin" }).then((r) => r.ok);
      if (!ok) return showGate("login");
      await load();
      showTab();
    } catch { showGate("login"); }
  })();
  showTab();
})();
