/* AI Control Plane — navigation, command chat, live execution, settings */
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const icon = (name, cls = "") => `<svg class="ic ${cls}"><use href="#i-${name}"/></svg>`;
  const store = {
    get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* per-viewer only */ } },
  };

  /* ---------- state ---------- */
  let home = null;
  let connections = [];
  let conversations = [];
  let current = null; // conversation summary, or null for a fresh chat
  let messages = [];
  let target = ""; // "" = auto
  let approvalMode = "auto";
  let browserState = null;
  let overview = null; // counts, running, attention (kept fresh over SSE)
  let agents = [];
  let view = "chat"; // chat | overview | agents | tasks | runs | approvals | activity | notifications
  let viewFilter = "";
  let signingIn = null; // { platform, mode: "live" | "desktop", vnc, desktopOk, localOk } while the sign-in ribbon shows
  let pairing = null; // { platform, name, id, code, command, expiresAt, secure, status, detail } while the connect panel is relevant
  let pairingTimer = null;
  const openActivity = new Map(); // message id -> user toggled open/closed
  const runningRuns = new Map(); // run id -> { ...run, current_step }
  const app = $("#app");

  /* ---------- theme (dark by default) ---------- */
  let theme = store.get("acp-theme", "dark");
  function applyTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
    $("#btn-theme").innerHTML = icon(t === "dark" ? "sun" : "moon");
    $("#btn-theme").title = t === "dark" ? "Switch to light" : "Switch to dark";
    $('meta[name="theme-color"]').content = t === "dark" ? "#12161c" : "#ffffff";
  }
  applyTheme(theme);
  $("#btn-theme").addEventListener("click", () => {
    theme = theme === "dark" ? "light" : "dark";
    store.set("acp-theme", theme);
    applyTheme(theme);
  });

  /* ---------- api & helpers ---------- */
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
    if (!res.ok) throw new Error(data.reason ? `${data.reason}` : data.error || res.statusText);
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
  const clock = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); };
  const dur = (from, to) => {
    const a = new Date(from).getTime();
    const b = to ? new Date(to).getTime() : Date.now();
    if (isNaN(a) || isNaN(b)) return "";
    const s = Math.max(0, Math.round((b - a) / 1000));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  };
  const conn = (id) => connections.find((c) => c.id === id);
  const aiName = (id) => conn(id)?.name || (id === "custom" ? "Custom agents" : id) || "an AI";
  const statusOf = (c) => c.status === "logged_in" ? { dot: "ok", label: "Connected" } : c.status === "needs_login" ? { dot: "warn", label: "Signed out" } : c.status === "error" ? { dot: "bad", label: "Problem" } : { dot: "", label: "Not connected" };
  const isRunning = (m) => m.status === "assigned" || m.status === "delivered";
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  /* ---------- gate ---------- */
  let gateMode = "login";
  function showGate(mode) {
    gateMode = mode;
    $("#gate").hidden = false;
    $("#gate-title").textContent = mode === "setup" ? "Create your password" : "Welcome back";
    $("#gate-text").textContent = mode === "setup" ? "This is the only password you need. It protects your chats and your saved sign-ins." : "Enter your password to open the control plane.";
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
      await start();
    } catch (err) {
      $("#gate-error").textContent = err.message;
      $("#gate-error").hidden = false;
    }
  });

  /* ---------- load ---------- */
  async function load(conversationId) {
    const h = await api(`/home${conversationId ? `?conversation_id=${conversationId}` : ""}`);
    home = h;
    connections = h.connections;
    conversations = h.conversations;
    approvalMode = h.approvalMode;
    browserState = h.browser;
    live.state = h.browser; // the freshest snapshot; the socket and the stream only replace it with newer ones
    overview = h.overview;
    agents = h.agents || [];
    runningRuns.clear();
    for (const r of h.overview?.running ?? []) runningRuns.set(r.id, r);
    if (conversationId === null) { current = null; messages = []; }
    else { current = h.conversation; messages = h.messages; }
    renderAll();
    if (adoptSignIn()) {
      renderRibbons();
      toast(`A sign-in to ${aiName(signingIn.platform)} is still open on the cloud desktop. Continue it in the browser panel, or cancel it there.`);
    }
  }
  /**
   * A desktop sign-in the server still has open (this page was reloaded, or the tab was closed
   * while it ran) is picked up again rather than lost: the server owns that state, not the page.
   */
  function adoptSignIn() {
    const s = browserState?.signIn;
    if (!s) return false;
    if (signingIn && signingIn.platform === s.platform && signingIn.mode === "desktop") return false;
    const opts = home?.signInOptions || {};
    signingIn = { platform: s.platform, mode: "desktop", vnc: opts.vnc, desktopOk: true, localOk: true, resumed: true };
    return true;
  }

  /* sign-in from the user's own computer: a pairing code, one command there, the session lands here */
  async function startLocalSignIn(id) {
    const c = conn(id);
    if (browserState && browserState.enabled === false) return toast("The browser is off on this deployment, so there is nowhere to put a sign-in.", "bad");
    if (pairing && pairing.platform === id && ["waiting", "paired", "importing"].includes(pairing.status)) return openPairing();
    try {
      const r = await api(`/connections/${id}/pairing`, { method: "POST", body: {} });
      if (signingIn && signingIn.platform === id) { signingIn = null; renderRibbons(); }
      pairing = { platform: id, name: r.name || c?.name || id, id: r.id, code: r.code, command: r.command, expiresAt: r.expiresAt, secure: r.secure, status: "waiting", detail: null };
      openPairing();
    } catch (err) { fail(err); }
  }
  function openPairing() {
    $("#pairing-modal").hidden = false;
    renderPairing();
    clearInterval(pairingTimer);
    pairingTimer = setInterval(renderPairing, 1000);
  }
  function closePairing() {
    clearInterval(pairingTimer);
    pairingTimer = null;
    $("#pairing-modal").hidden = true;
  }
  function renderPairing() {
    if (!pairing) return;
    const left = Math.max(0, Math.round((new Date(pairing.expiresAt).getTime() - Date.now()) / 1000));
    const mmss = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
    if (pairing.status === "waiting" && left <= 0) pairing.status = "expired";
    const st = pairing.status;
    const name = pairing.name;
    const texts = {
      waiting: [`Waiting for your computer… the code is good for ${mmss}.`, "run"],
      paired: [`Your computer is paired. Sign in to ${name} in the Chrome window that opened there, exactly as you always do. When the site shows you signed in, the helper hands the session over on its own.`, "run"],
      importing: [`Signed in. Handing your ${name} session to the cloud browser…`, "run"],
      done: [`${name} is connected.`, "ok"],
      failed: [pairing.detail || `The sign-in to ${name} could not be imported.`, "bad"],
      expired: ["The code expired before your computer used it. Make a new one.", "warn"],
      cancelled: ["Cancelled. Make a new code whenever you are ready.", ""],
      replaced: ["A newer code replaced this one.", ""],
    };
    const [text, tone] = texts[st] || [st, ""];
    $("#pairing-title").textContent = `Connect ${name} from this computer`;
    $("#pairing-command").textContent = pairing.command;
    $("#pairing-code").textContent = pairing.code;
    $("#pairing-expires").textContent = st === "waiting" ? `· expires in ${mmss}` : st === "paired" || st === "importing" ? `· token good for ${mmss}` : "";
    $("#pairing-warning").hidden = !!pairing.secure;
    $("#pairing-status-text").textContent = text;
    $("#pairing-dot").className = `dot ${tone}`;
    $("#pairing-status").className = `notice ${tone === "run" ? "" : tone}`;
    const over = ["done", "failed", "expired", "cancelled", "replaced"].includes(st);
    $("#btn-pairing-cancel").hidden = over;
    $("#btn-pairing-new").hidden = !over || st === "done";
    $("#btn-pairing-done").hidden = st !== "done";
  }
  $("#btn-pairing-copy").addEventListener("click", async () => { await navigator.clipboard.writeText(pairing?.command || "").catch(() => null); toast("Copied. Paste it in a terminal in the project folder.", "ok"); });
  $("#btn-pairing-cancel").addEventListener("click", async () => { const p = pairing; closePairing(); pairing = null; if (p) await api(`/connections/${p.platform}/pairing`, { method: "DELETE" }).catch(() => null); });
  $("#btn-pairing-new").addEventListener("click", () => { const p = pairing; pairing = null; if (p) startLocalSignIn(p.platform); });
  $("#btn-pairing-done").addEventListener("click", () => { closePairing(); pairing = null; });
  $("[data-pairing-close]").addEventListener("click", () => closePairing()); // keeps the code: "Show the connect code" brings it back
  function renderAll() {
    renderAiList();
    renderEngine();
    renderChatList();
    renderHeader();
    renderMode();
    renderTargets();
    renderThread();
    renderTabs();
    renderCounts();
    renderLiveContext();
    if (view !== "chat") renderView();
  }

  /* ---------- counts in the sidebar ---------- */
  function renderCounts() {
    const c = overview?.counts ?? {};
    const attention = (overview?.attention ?? []).length;
    const set = (key, n, hideZero = true) => { for (const el of $$(`[data-count="${key}"]`)) { el.textContent = n; el.hidden = hideZero && !n; } };
    set("attention", attention);
    set("agents", c.agents ?? 0);
    set("tasks", c.tasks ?? 0);
    set("running", c.running ?? runningRuns.size);
    set("awaiting_approval", c.awaiting_approval ?? 0);
    set("unread", c.unread ?? 0);
    const custom = agents.filter((a) => a.kind === "custom");
    $("#custom-agents-sub").textContent = custom.length ? `${custom.length} registered${custom.some((a) => a.running) ? " · working" : ""}` : "none registered";
    document.title = (c.running ? `(${c.running}) ` : "") + "AI Control Plane";
  }
  const refreshOverview = debounce(async () => {
    try {
      overview = await api("/overview");
      runningRuns.clear();
      for (const r of overview.running) runningRuns.set(r.id, r);
      renderCounts();
      renderLiveContext();
      if (view === "overview") renderView();
    } catch (err) { fail(err); }
  }, 400);
  // The logs view tails the stream itself; re-rendering it on every run event would lose the reader's place.
  const refreshView = debounce(() => { if (view !== "chat" && view !== "logs") renderView(); }, 500);
  const logFilter = () => ({ level: store.get("acp-log-level", "info"), scope: store.get("acp-log-scope", "") });

  /* ---------- live updates (server-sent events) ---------- */
  let es = null;
  let streamOpenedBefore = false;
  function connectStream() {
    if (es) es.close();
    es = new EventSource("/api/stream");
    es.addEventListener("hello", () => {
      if (streamOpenedBefore) load(current ? current.id : null).catch(fail); // catch up on what we missed
      streamOpenedBefore = true;
    });
    es.addEventListener("msg", (e) => onMessage(JSON.parse(e.data)));
    es.addEventListener("msg-deleted", (e) => {
      const { id } = JSON.parse(e.data);
      messages = messages.filter((m) => m.id !== id);
      $(`#message-${id}`)?.remove();
      if (!messages.length) renderThread();
    });
    es.addEventListener("connection", (e) => {
      const c = JSON.parse(e.data);
      const i = connections.findIndex((x) => x.id === c.id);
      if (i >= 0) connections[i] = c; else connections.push(c);
      renderAiList(); renderTargets(); refreshOverview();
    });
    es.addEventListener("browser", (e) => {
      const next = JSON.parse(e.data);
      if (browserState && typeof next.seq === "number" && typeof browserState.seq === "number" && next.seq < browserState.seq) return; // older than what the live-view socket already delivered
      const before = browserState?.signIn;
      browserState = next;
      live.state = next;
      // A desktop sign-in that ended on its own (window closed, or timed out): check where we stand.
      if (before && !browserState.signIn && signingIn?.mode === "desktop" && signingIn.platform === before.platform) {
        const id = before.platform;
        signingIn = null;
        api(`/connections/${id}/check`, { method: "POST", body: {} }).then((r) => toast(r.status === "logged_in" ? `${r.name} is connected.` : `The sign-in window for ${r.name} closed before you were signed in. Start it again when you are ready.`, r.status === "logged_in" ? "ok" : "bad")).catch(() => null);
      }
      // A desktop sign-in started or cancelled from another tab: this page follows the server.
      if (!browserState.signIn && signingIn?.resumed) signingIn = null;
      adoptSignIn();
      renderAiList(); renderEngine(); renderTabs(); renderRibbons(); renderLiveContext();
    });
    es.addEventListener("log", (e) => { if (view === "logs") Views.appendLog(JSON.parse(e.data), $("#view"), logFilter()); });
    es.addEventListener("pairing", (e) => {
      const p = JSON.parse(e.data);
      if (pairing && p.id === pairing.id) { pairing.status = p.status; pairing.detail = p.detail; if (p.expires_at) pairing.expiresAt = p.expires_at; renderPairing(); }
      if (p.status === "done") toast(`${aiName(p.platform)} is connected.`, "ok");
      else if (p.status === "failed") toast(p.detail || `The sign-in to ${aiName(p.platform)} could not be imported.`, "bad");
    });
    es.addEventListener("conversation", (e) => {
      const { action, conversation: c } = JSON.parse(e.data);
      if (action === "deleted") {
        conversations = conversations.filter((x) => x.id !== c.id);
        if (current && current.id === c.id) newChat();
      } else {
        const i = conversations.findIndex((x) => x.id === c.id);
        if (i >= 0) conversations[i] = c; else conversations.unshift(c);
        conversations.sort((a, b) => String(b.last_message_at || b.created_at).localeCompare(String(a.last_message_at || a.created_at)));
        if (current && current.id === c.id) { current = c; renderHeader(); }
      }
      renderChatList();
    });
    es.addEventListener("settings", (e) => {
      const s = JSON.parse(e.data);
      if (s.approvalMode) { approvalMode = s.approvalMode; renderMode(); renderEngine(); }
    });
    es.addEventListener("run", (e) => {
      const r = JSON.parse(e.data);
      if (r.status === "running") runningRuns.set(r.id, { ...(runningRuns.get(r.id) || {}), ...r });
      else runningRuns.delete(r.id);
      renderLiveContext(); refreshOverview(); refreshView();
    });
    es.addEventListener("run-event", (e) => {
      const ev = JSON.parse(e.data);
      const r = runningRuns.get(ev.run_id);
      if (r && ev.type === "step" && (ev.status === "running" || ev.status === "waiting")) { r.current_step = ev.label; r.current_step_status = ev.status; renderLiveContext(); }
      if (view === "activity" || view === "runs") refreshView();
    });
    for (const k of ["approval", "task", "agent", "agent-deleted", "task-deleted", "notification"]) es.addEventListener(k, () => { refreshOverview(); refreshView(); if (k === "agent" || k === "agent-deleted") api("/agents").then((a) => { agents = a; renderCounts(); }).catch(() => null); });
  }
  function onMessage(m) {
    if (!current || m.conversation_id !== current.id) return;
    const i = messages.findIndex((x) => x.id === m.id);
    if (i >= 0) messages[i] = m; else messages.push(m);
    patchTurn(m);
  }

  /* ---------- layout: resize, collapse, narrow screens ---------- */
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  function applyWidths() {
    app.style.setProperty("--side-w", store.get("acp-side-w", "272") + "px");
    app.style.setProperty("--browser-w", store.get("acp-browser-w", "") ? store.get("acp-browser-w", "") + "px" : "44%");
    app.classList.toggle("side-collapsed", store.get("acp-side", "open") === "closed");
    app.classList.toggle("browser-collapsed", store.get("acp-browser", "open") === "closed");
    reflectCollapse();
  }
  function reflectCollapse() {
    const sideClosed = app.classList.contains("side-collapsed");
    const browserClosed = app.classList.contains("browser-collapsed");
    $("#btn-side-open").hidden = !sideClosed;
    $("#btn-browser-open").hidden = !browserClosed;
    $("#btn-browser-fab").hidden = !browserClosed;
  }
  function initGutter(gutter, which) {
    gutter.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      gutter.setPointerCapture(e.pointerId);
      gutter.classList.add("dragging");
      app.classList.add("resizing");
      const move = (ev) => {
        const r = app.getBoundingClientRect();
        if (which === "side") {
          const w = clamp(ev.clientX - r.left, 200, 420);
          app.style.setProperty("--side-w", w + "px");
          store.set("acp-side-w", String(Math.round(w)));
        } else {
          const sideW = app.classList.contains("side-collapsed") ? 0 : parseInt(getComputedStyle(app).getPropertyValue("--side-w")) || 272;
          const w = clamp(r.right - ev.clientX, 320, r.width - sideW - 12 - 360);
          app.style.setProperty("--browser-w", w + "px");
          store.set("acp-browser-w", String(Math.round(w)));
        }
      };
      const up = () => {
        gutter.classList.remove("dragging");
        app.classList.remove("resizing");
        gutter.removeEventListener("pointermove", move);
        gutter.removeEventListener("pointerup", up);
        gutter.removeEventListener("pointercancel", up);
      };
      gutter.addEventListener("pointermove", move);
      gutter.addEventListener("pointerup", up);
      gutter.addEventListener("pointercancel", up);
    });
    gutter.addEventListener("dblclick", () => {
      if (which === "side") { store.set("acp-side-w", "272"); } else { store.set("acp-browser-w", ""); }
      applyWidths();
    });
  }
  initGutter($("#gutter-left"), "side");
  initGutter($("#gutter-right"), "browser");
  $("#btn-side-collapse").addEventListener("click", () => { app.classList.add("side-collapsed"); store.set("acp-side", "closed"); reflectCollapse(); });
  $("#btn-side-open").addEventListener("click", () => { app.classList.remove("side-collapsed"); store.set("acp-side", "open"); reflectCollapse(); });
  const showBrowser = () => { app.classList.remove("browser-collapsed"); store.set("acp-browser", "open"); reflectCollapse(); if (isNarrow()) setPanel("browser"); };
  $("#btn-browser-close").addEventListener("click", () => { app.classList.add("browser-collapsed"); store.set("acp-browser", "closed"); reflectCollapse(); });
  $("#btn-browser-open").addEventListener("click", showBrowser);
  $("#btn-browser-fab").addEventListener("click", showBrowser);
  const isNarrow = () => window.matchMedia("(max-width: 960px)").matches;
  function setPanel(v) {
    app.dataset.view = v;
    for (const b of $$(".mobile-nav .seg-btn")) b.classList.toggle("active", b.dataset.view === v);
  }
  $(".mobile-nav").addEventListener("click", (e) => { const b = e.target.closest("[data-view]"); if (b) setPanel(b.dataset.view); });
  applyWidths();

  /* ---------- navigation between the command chat and the views ---------- */
  function setView(v, filter = "") {
    if (!Views.titles[v] && v !== "chat") v = "chat";
    view = v;
    viewFilter = filter;
    for (const a of $$("[data-nav]")) a.classList.toggle("active", a.dataset.nav === v && (!a.dataset.filter || a.dataset.filter === filter));
    const isChat = v === "chat";
    $("#thread").hidden = !isChat;
    $("#composer").hidden = !isChat;
    $("#view").hidden = isChat;
    $("#mode").hidden = !isChat && v !== "approvals";
    renderHeader();
    if (!isChat) renderView();
    else scrollThread();
    if (isNarrow()) setPanel("chat");
    const hash = v === "chat" ? "#chat" : `#${v}${filter ? `?${filter}` : ""}`;
    if (location.hash !== hash) history.replaceState(null, "", hash);
  }
  function viewFromHash() {
    const [name, filter] = (location.hash || "#chat").replace("#", "").split("?");
    return { name: name || "chat", filter: filter ? decodeURIComponent(filter) : "" };
  }
  window.addEventListener("hashchange", () => { const h = viewFromHash(); if (h.name !== view || h.filter !== viewFilter) setView(h.name, h.filter); });
  const viewCtx = { api, esc, icon, rel, dur, aiName, conn, store, get filter() { return viewFilter; }, set filter(v) { viewFilter = v; }, overview: null };
  let viewSeq = 0;
  async function renderView() {
    const root = $("#view");
    const seq = ++viewSeq;
    const keepScroll = root.scrollTop;
    try {
      const tmp = document.createElement("div");
      await Views.render(view, tmp, viewCtx);
      if (seq !== viewSeq) return; // a newer render is on its way
      root.innerHTML = tmp.innerHTML;
      root.scrollTop = view === "logs" ? root.scrollHeight : keepScroll; // a log reads newest-last, like a terminal
      tickTimers();
    } catch (err) {
      if (seq === viewSeq) root.innerHTML = `<div class="view-empty"><strong>Could not load this view</strong><span>${esc(err.message)}</span></div>`;
    }
  }

  /* ---------- left: providers ---------- */
  function renderAiList() {
    const busyP = browserState?.busy?.platform;
    const rows = connections.filter((c) => c.appUrl || c.builtin).map((c) => {
      const st = statusOf(c);
      const signingHere = browserState?.signIn?.platform === c.id;
      const pairingHere = !!(c.pairing && ["waiting", "paired", "importing"].includes(c.pairing.status));
      const busyLabel = signingHere ? "Sign-in open on the cloud desktop" : pairingHere ? (c.pairing.status === "waiting" ? "Waiting for your computer…" : c.pairing.status === "paired" ? "Sign in on your computer…" : "Importing your sign-in…") : busyP === c.id ? browserState.busy.label : null;
      const showing = browserState?.active === c.id && browserState?.pages?.some((p) => p.platform === c.id);
      const modeLabel = c.signInMode === "desktop" ? " (cloud desktop)" : c.signInMode === "local" ? " (from this computer)" : "";
      const alternatives = [
        c.signInMode !== "live" ? `<button class="btn small" data-connect="${c.id}" data-mode="live">${icon("eye", "sm")} Sign in in the live view</button>` : "",
        c.signInMode !== "desktop" ? `<button class="btn small" data-connect="${c.id}" data-mode="desktop">${icon("panel", "sm")} Sign in on the cloud desktop</button>` : "",
        c.signInMode !== "local" ? `<button class="btn small" data-connect="${c.id}" data-mode="local">${icon("terminal", "sm")} Connect from this computer</button>` : "",
      ].join("");
      const signInButtons = signingHere
        ? `<button class="btn small" data-signin-resume="${c.id}">${icon("panel", "sm")} Continue the sign-in</button><button class="btn small" data-signin-cancel="${c.id}">${icon("close", "sm")} Cancel the sign-in</button>`
        : pairingHere
          ? `<button class="btn small" data-connect="${c.id}" data-mode="local">${icon("terminal", "sm")} Show the connect code</button><button class="btn small" data-pairing-cancel="${c.id}">${icon("close", "sm")} Cancel the connect</button>`
          : `${c.status === "logged_in" ? `<button class="btn small" data-connect="${c.id}">${icon("login", "sm")} Sign in again${modeLabel}</button>` : `<button class="btn small" data-connect="${c.id}">${icon("login", "sm")} Sign in${modeLabel}</button>`}${alternatives}`;
      return `<div class="ai-row ${target === c.id ? "active" : ""}" data-ai="${c.id}" role="button" tabindex="0" title="${target === c.id ? "Sending to this AI. Click to go back to Auto." : `Send your next message to ${esc(c.name)}`}">
        <span class="avatar ${esc(c.id)}">${esc(c.name.slice(0, 1))}</span>
        <div class="info"><div class="name">${esc(c.name)}${showing ? `<span class="muted" title="Showing in the browser panel">${icon("eye", "sm")}</span>` : ""}</div>
        <div class="sub ${busyLabel ? "busy" : ""}">${esc(busyLabel || st.label)}${c.lastError && c.status !== "logged_in" && !busyLabel ? ` · ${esc(c.lastError)}` : ""}</div></div>
        <span class="dot ${busyLabel ? "run" : st.dot}"></span>
        <details class="menu"><summary class="btn icon ghost" aria-label="More" style="width:24px;height:24px">${icon("more", "sm")}</summary><div class="menu-list">
          ${c.status === "logged_in" && !signingHere ? `<button class="btn small" data-view-ai="${c.id}">${icon("eye", "sm")} Show in browser</button><button class="btn small" data-check="${c.id}">${icon("check", "sm")} Check sign-in</button>${c.canSync ? `<button class="btn small" data-refresh="${c.id}">${icon("reload", "sm")} Look at its tasks now</button>` : ""}` : ""}
          ${signInButtons}
          <a class="btn small" href="#tasks" data-nav="tasks">${icon("tasks", "sm")} Its tasks</a>
          <button class="btn small" data-open-settings="ai" data-ai-id="${c.id}">${icon("edit", "sm")} Edit</button>
          <button class="btn small danger" data-remove="${c.id}">${icon("trash", "sm")} Remove</button></div></details>
      </div>`;
    });
    $("#ai-list").innerHTML = rows.join("") || `<div class="side-empty">No providers yet. Add one with +.</div>`;
  }
  function renderEngine() {
    const b = browserState;
    const r = home?.router;
    const tabs = b?.pages?.length ?? 0;
    const bl = !b || b.enabled === false ? ["", "Cloud browser off"] : b.running ? ["ok", `Cloud browser on · ${tabs} tab${tabs === 1 ? "" : "s"}`] : ["warn", "Cloud browser starting…"];
    const rl = r?.llm ? `Routing by Claude${r.provider === "claude-code" ? " (subscription)" : ""}` : "Routing by name or keywords";
    const ml = approvalMode === "manual" ? "Asks you before acting" : "Acts on its own";
    $("#engine").innerHTML = `<div class="line"><span class="dot ${bl[0]}"></span><b>${esc(bl[1])}</b></div><div class="line">${icon("bolt", "sm")}<b>${esc(rl)}</b></div><div class="line">${icon(approvalMode === "manual" ? "hand" : "check", "sm")}<b>${esc(ml)}</b></div>`;
  }

  /* ---------- left: chats ---------- */
  function groupOf(iso) {
    const d = new Date(iso);
    const now = new Date();
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = (day(now) - day(d)) / 86400000;
    return diff < 1 ? "Today" : diff < 2 ? "Yesterday" : diff < 7 ? "Previous 7 days" : "Older";
  }
  function renderChatList() {
    const el = $("#chat-list");
    if (!conversations.length) { el.innerHTML = `<div class="side-empty">Your chats show up here.</div>`; return; }
    let lastGroup = "";
    el.innerHTML = conversations.slice(0, 60).map((c) => {
      const at = c.last_message_at || c.created_at;
      const g = groupOf(at);
      const head = g !== lastGroup ? `<div class="chat-group">${g}</div>` : "";
      lastGroup = g;
      const dot = c.active ? `<span class="dot run"></span>` : c.last_status === "failed" ? `<span class="dot bad" title="Something failed"></span>` : c.last_status === "needs_assignment" ? `<span class="dot warn" title="Needs you"></span>` : "";
      return `${head}<div class="chat-row ${view === "chat" && current && current.id === c.id ? "active" : ""}" data-conv="${c.id}" role="button" tabindex="0">
        <div class="info"><div class="title">${esc(c.title || "New chat")}</div><div class="sub">${c.last_platform ? esc(aiName(c.last_platform)) + " · " : ""}${rel(at)}</div></div>${dot}
        <details class="menu"><summary class="btn icon ghost" aria-label="More" style="width:24px;height:24px">${icon("more", "sm")}</summary><div class="menu-list">
          <button class="btn small" data-rename="${c.id}">${icon("edit", "sm")} Rename</button>
          <button class="btn small danger" data-delete-conv="${c.id}">${icon("trash", "sm")} Delete</button></div></details>
      </div>`;
    }).join("");
  }
  async function openConversation(id) {
    try {
      const d = await api(`/conversations/${id}`);
      current = d.conversation;
      messages = d.messages;
      setView("chat");
      renderChatList(); renderHeader(); renderThread();
    } catch (err) { fail(err); }
  }
  function newChat() {
    current = null;
    messages = [];
    setView("chat");
    renderChatList(); renderHeader(); renderThread();
    $("#chat-text").focus();
  }
  $("#btn-new-chat").addEventListener("click", newChat);

  /* ---------- middle: header, mode, targets ---------- */
  function renderHeader() {
    if (view !== "chat") {
      $("#chat-title").textContent = Views.titles[view] || view;
      $("#chat-title").title = "";
      $("#chat-sub").textContent = viewFilter ? `filtered: ${viewFilter}` : "";
      return;
    }
    $("#chat-title").textContent = current ? current.title || "New chat" : "New chat";
    $("#chat-title").title = "Click to rename";
    const n = current?.message_count ?? messages.length;
    $("#chat-sub").textContent = current ? `${n} message${n === 1 ? "" : "s"}` : "";
  }
  $("#chat-title").addEventListener("click", async () => {
    if (view !== "chat" || !current) return;
    const title = prompt("Rename this chat", current.title || "");
    if (title === null) return;
    try { current = await api(`/conversations/${current.id}`, { method: "PATCH", body: { title: title.trim() } }); renderHeader(); renderChatList(); } catch (err) { fail(err); }
  });
  function renderMode() {
    for (const b of $$(".mode-btn")) { b.classList.toggle("active", b.dataset.mode === approvalMode); b.setAttribute("aria-checked", String(b.dataset.mode === approvalMode)); }
  }
  $("#mode").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-mode]");
    if (!b || b.dataset.mode === approvalMode) return;
    try {
      const r = await api("/settings/approval", { method: "PUT", body: { approvalMode: b.dataset.mode } });
      approvalMode = r.approvalMode;
      renderMode(); renderEngine();
      toast(approvalMode === "manual" ? "The agent will now pause and ask before sending or acting." : "The agent now acts on its own for everyday actions. Deploys and deletions still ask.");
    } catch (err) { fail(err); }
  });
  function renderTargets() {
    const chattable = connections.filter((c) => c.canChat);
    $("#targets").innerHTML =
      `<button type="button" class="chip ${target === "" ? "active" : ""}" data-target="" role="radio" aria-checked="${target === ""}" title="Questions and commands are answered here; anything else goes to the AI picked from what you write">Auto</button>` +
      chattable.map((c) => `<button type="button" class="chip ${target === c.id ? "active" : ""}" data-target="${c.id}" role="radio" aria-checked="${target === c.id}" title="${c.status === "logged_in" ? `Send to ${esc(c.name)}` : `${esc(c.name)} is not connected`}"><span class="dot ${statusOf(c).dot}"></span>${esc(c.name)}</button>`).join("");
    $("#chat-send").disabled = false;
  }
  function setTarget(id) {
    target = id;
    renderTargets(); renderAiList();
  }
  $("#targets").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-target]");
    if (!chip) return;
    setTarget(chip.dataset.target);
    $("#chat-text").focus();
  });

  /* ---------- middle: thread ---------- */
  function renderThread() {
    const inner = $("#thread-inner");
    if (!messages.length) {
      const connected = connections.filter((c) => c.status === "logged_in" && c.canChat);
      inner.innerHTML = `<div class="thread-empty"><strong>${connected.length ? "Mission control. What do you want to know or do?" : "Ask the control plane, or connect a provider to talk to an AI."}</strong>Questions about your agents, tasks and runs are answered here. Commands start, pause or stop tasks. Anything else goes to the AI you name or pick, and you can watch it happen in the browser panel.<div class="examples">${["What is running right now?", "What failed today?", "What requires my approval?", "Run the security scan again", ...(connected.length ? ["Grok, what's trending in AI today?", "Claude, draft this week's status report"] : [])].map((x) => `<button class="chip" data-example="${esc(x)}">${esc(x)}</button>`).join("")}</div></div>`;
      return;
    }
    inner.innerHTML = messages.map(renderTurn).join("");
    scrollThread(true);
    tickTimers();
  }
  function patchTurn(m) {
    const inner = $("#thread-inner");
    const el = $(`#message-${m.id}`);
    const pinned = nearBottom();
    if (el) el.outerHTML = renderTurn(m);
    else {
      if (inner.querySelector(".thread-empty")) inner.innerHTML = "";
      inner.insertAdjacentHTML("beforeend", renderTurn(m));
    }
    if (pinned || !el) scrollThread(true);
    tickTimers();
  }
  function nearBottom() { const t = $("#thread"); return t.scrollHeight - t.scrollTop - t.clientHeight < 120; }
  function scrollThread() { const t = $("#thread"); t.scrollTop = t.scrollHeight; }

  function renderTurn(m) {
    const control = m.routing?.method === "control";
    const name = control ? "Control plane" : aiName(m.platform || m.task_platform);
    const pid = control ? "system" : m.platform || m.task_platform || "";
    const others = (except) => connections.filter((c) => c.canChat && c.id !== except).map((c) => `<button class="btn small ghost" data-send="${m.id}" data-platform="${c.id}">Send to ${esc(c.name)}</button>`).join("");
    let reply = "";
    if (m.status === "done" || (m.status === "acknowledged" && m.response)) {
      reply = `<div class="msg ai"><span class="avatar ${esc(pid)}">${control ? icon("agents", "sm") : esc(name.slice(0, 1))}</span><div class="col"><div class="meta"><span class="who">${esc(name)}</span>${rel(m.acked_at || m.updated_at)}</div><div class="bubble ai">${esc(m.response || "Done.")}</div></div></div>`;
    } else if (m.status === "failed") {
      reply = `<div class="msg ai"><span class="avatar ${esc(pid)}">!</span><div class="col"><div class="bubble error">${esc(m.error || "Something went wrong.")}</div><div class="choices">${!control && conn(pid)?.status === "needs_login" ? `<button class="btn small primary" data-connect="${esc(pid)}">Sign in to ${esc(name)}</button>` : ""}${pid && !control ? `<button class="btn small" data-send="${m.id}" data-platform="${esc(pid)}">Try again</button>` : ""}${control ? "" : others(pid)}</div></div></div>`;
    } else if (m.status === "cancelled") {
      reply = `<div class="msg ai"><div class="col"><div class="bubble note">${esc(m.error || "Stopped.")}</div><div class="choices">${pid && !control ? `<button class="btn small" data-send="${m.id}" data-platform="${esc(pid)}">Send again</button>` : ""}${control ? "" : others(pid)}</div></div></div>`;
    } else if (control && m.status === "delivered" && m.response) {
      reply = `<div class="msg ai"><span class="avatar system">${icon("agents", "sm")}</span><div class="col"><div class="meta"><span class="who">Control plane</span></div><div class="bubble ai">${esc(m.response)}</div></div></div>`;
    } else if (m.task_id && (m.status === "assigned" || m.status === "delivered" || m.status === "acknowledged")) {
      reply = `<div class="msg ai"><div class="col"><div class="bubble note">${esc(m.delivery_hint ? `Handed to ${m.task_name}: ${m.delivery_hint}.` : `Handed to ${m.task_name}.`)}</div></div></div>`;
    }
    return `<div class="turn" id="message-${m.id}">
      <div class="msg me"><div class="col"><div class="bubble me">${esc(m.text)}</div><div class="meta">${clock(m.created_at)}<button class="btn icon ghost" data-del="${m.id}" title="Remove from this chat" aria-label="Remove">${icon("trash", "sm")}</button></div></div></div>
      ${renderActivity(m)}${reply}</div>`;
  }

  function renderActivity(m) {
    const steps = m.steps || [];
    const running = isRunning(m) && !m.task_id;
    const waiting = steps.find((s) => s.status === "waiting");
    if (!steps.length && !running && m.status !== "needs_assignment") return "";
    const control = m.routing?.method === "control";
    const name = control ? "the control plane" : aiName(m.platform);
    const state = m.status === "needs_assignment" || waiting ? "waiting" : running ? "running" : m.status === "failed" ? "failed" : m.status === "cancelled" ? "cancelled" : "done";
    const open = openActivity.has(m.id) ? openActivity.get(m.id) : state !== "done";
    const runningStep = [...steps].reverse().find((s) => s.status === "running");
    const head = m.status === "needs_assignment" ? "Which AI should do this?" : waiting ? (waiting.key === "approve" ? "Paused. Waiting for your approval" : waiting.label) : running ? runningStep?.label || (m.status === "assigned" ? "Starting…" : "Working…") : m.status === "failed" ? "Failed" : m.status === "cancelled" ? "Stopped" : `Done via ${name}`;
    const elapsed = running ? `<span class="elapsed" data-since="${m.created_at}"></span>` : `<span class="elapsed">${dur(m.created_at, m.acked_at || m.updated_at)}</span>`;
    const list = steps.map((s) => `<li class="step ${s.status}"><span class="glyph ${s.status}"></span><span class="text"><span>${esc(s.label)}</span>${s.detail ? `<span class="detail ${s.key === "approve" ? "quote" : ""}">${esc(s.detail)}</span>` : ""}</span>${s.status === "running" || s.status === "waiting" ? `<span class="elapsed" data-since="${s.at}"></span>` : s.ended_at && s.at ? `<span class="elapsed">${dur(s.at, s.ended_at)}</span>` : ""}</li>`).join("");
    let ask = "";
    if (waiting && waiting.key === "approve") {
      ask = `<div class="approval"><div class="q">${esc(waiting.label)}<small>It is typed and waiting in the browser panel. Approve to go ahead, or reject to leave it unsent.</small></div><button class="btn small" data-approve="${m.id}" data-decision="reject">Reject</button><button class="btn small primary" data-approve="${m.id}" data-decision="approve">${icon("check", "sm")} Approve</button></div>`;
    } else if (m.status === "needs_assignment") {
      const opts = (m.suggestions || []).filter((o) => o.platform);
      ask = `<div class="approval"><div class="q">${esc(m.routing?.reason || "Pick an AI for this message.")}</div><div class="choices">${opts.map((o) => `<button class="btn small ${o === opts[0] && o.confidence >= 0.5 ? "primary" : ""}" data-send="${m.id}" data-platform="${esc(o.platform)}" title="${esc(o.reason || "")}">${esc(o.name)}${o.confidence >= 0.5 ? ` <span class="muted">${Math.round(o.confidence * 100)}%</span>` : ""}</button>`).join("")}${connections.filter((c) => c.canChat && !opts.some((o) => o.platform === c.id)).map((c) => `<button class="btn small ghost" data-send="${m.id}" data-platform="${c.id}">${esc(c.name)}</button>`).join("")}</div></div>`;
    }
    const foot = running && !waiting ? `<div class="activity-foot"><span class="typing"><i></i><i></i><i></i></span><span>${esc(head)}</span><span class="spacer"></span><button class="btn xs ghost" data-cancel="${m.id}">${icon("stop", "sm")} Stop</button></div>` : "";
    const glyphState = state === "cancelled" ? "skipped" : state;
    return `<div class="activity ${state} ${open ? "open" : ""}" data-activity="${m.id}">
      <button type="button" class="activity-head" data-toggle="${m.id}"><span class="glyph ${glyphState}"></span><span class="label">${esc(head)}</span>${elapsed}${icon("chev-down", "sm chev")}</button>
      <div class="activity-body"><ol class="steps">${list}</ol>${ask}${foot}</div></div>`;
  }
  function tickTimers() { for (const el of $$(".elapsed[data-since]")) el.textContent = dur(el.dataset.since, null); const lc = $("#lc-elapsed"); if (lc?.dataset.since) lc.textContent = dur(lc.dataset.since, null); }
  setInterval(tickTimers, 1000);

  /* ---------- composer ---------- */
  const ta = $("#chat-text");
  function autogrow() { ta.style.height = "auto"; ta.style.height = Math.min(200, ta.scrollHeight) + "px"; }
  ta.addEventListener("input", autogrow);
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#composer").requestSubmit(); } });
  $("#composer").addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = ta.value.trim();
    if (!text) return;
    try {
      await busy($("#chat-send"), async () => {
        const body = { text, ...(target ? { platform: target } : {}), ...(current ? { conversation_id: current.id } : {}) };
        ta.value = ""; autogrow();
        const r = await api("/chat", { method: "POST", body });
        if (!current || current.id !== r.conversation.id) {
          current = r.conversation;
          const d = await api(`/conversations/${current.id}`);
          messages = d.messages;
          const i = conversations.findIndex((c) => c.id === current.id);
          if (i >= 0) conversations[i] = current; else conversations.unshift(current);
          renderChatList(); renderHeader(); renderThread();
        } else {
          const i = messages.findIndex((x) => x.id === r.message.id);
          if (i >= 0) messages[i] = r.message; else messages.push(r.message);
          patchTurn(r.message);
        }
        if (r.routed === null) toast("Not sure which AI should do this. Pick one in the thread.");
      });
      scrollThread(true);
      ta.focus();
    } catch (err) { fail(err); }
  });

  /* ---------- right: live browser ---------- */
  const live = new LiveView({
    canvas: $("#screen"),
    viewport: $("#viewport"),
    onState: (s) => { browserState = s; renderTabs(); renderRibbons(); renderAiList(); renderEngine(); renderLiveContext(); },
    onMeta: () => { renderUrl(); renderTabs(); renderViewportMessage(); renderLiveContext(); },
    onStatus: (st) => {
      $("#live-status").textContent = st.text;
      $("#live-dot").className = `dot ${st.kind === "live" ? "ok" : st.kind === "busy" ? "run" : st.kind === "down" ? "warn" : ""}`;
      $("#live-fps").textContent = st.fps !== undefined && st.fps > 0 ? `${st.fps} fps` : "";
      renderViewportMessage();
    },
    onError: (msg) => toast(msg, "bad"),
  });
  live.setState = (s) => { if (s) { live.state = s; } };
  function renderTabs() {
    const pages = browserState?.pages ?? [];
    const shown = live.meta?.platform;
    const busyP = browserState?.busy?.platform;
    $("#tabs").innerHTML =
      `<button class="tab follow ${live.follow ? "active" : ""}" data-tab="follow" title="Show whatever tab the agent is working in">${icon("eye", "sm")} Follow agent</button>` +
      pages.map((p) => `<button class="tab ${!live.follow && shown === p.platform ? "active" : ""}" data-tab="${esc(p.platform)}" title="${esc(p.title || p.url)}"><span class="dot ${busyP === p.platform ? "run" : shown === p.platform ? "ok" : ""}"></span>${esc(aiName(p.platform))}</button>`).join("");
    for (const b of $$("[data-nav-browser]")) b.disabled = !shown;
  }
  $("#tabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tab]");
    if (!b) return;
    if (b.dataset.tab === "follow") live.followAgent(); else live.watch(b.dataset.tab);
    renderTabs();
    $("#viewport").focus({ preventScroll: true });
  });
  function renderUrl() {
    const url = live.meta?.url || "";
    const input = $("#url");
    if (document.activeElement !== input) input.value = url === "about:blank" ? "" : url;
    $("#url-lock").innerHTML = icon(url.startsWith("https:") ? "lock" : "globe", "sm");
    $("#url-lock").classList.toggle("ok", url.startsWith("https:"));
  }
  $("#urlbar").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = $("#url").value.trim();
    if (!v) return;
    if (!live.meta?.platform) return toast("Open a provider first, then you can navigate its tab.");
    live.nav(v);
    $("#viewport").focus({ preventScroll: true });
  });
  $("#url").addEventListener("blur", renderUrl);
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-nav-browser]");
    if (!b) return;
    if (b.dataset.navBrowser === "back") live.back(); else if (b.dataset.navBrowser === "forward") live.forward(); else live.reload();
  });
  function renderRibbons() {
    const b = browserState;
    const busyRibbon = $("#busy-ribbon");
    if (b?.busy && live.meta?.platform && (!b.busy.platform || b.busy.platform === live.meta.platform)) {
      busyRibbon.hidden = false;
      $("#busy-text").textContent = live.override ? `You have control while the agent works (${b.busy.label})` : `Agent: ${b.busy.label} · view only`;
      $("#btn-control").textContent = live.override ? "Give control back" : "Take control";
    } else {
      busyRibbon.hidden = true;
      if (live.override) live.setOverride(false);
    }
    renderSignIn();
    $("#viewport").classList.toggle("interactive", live.interactive);
  }
  /** The sign-in ribbon and, for a desktop sign-in, the cloud desktop in place of the screencast. */
  function renderSignIn() {
    const ribbon = $("#signin-ribbon");
    const frame = $("#desktop-frame");
    const desktopActive = !!browserState?.signIn;
    if (!signingIn) {
      ribbon.hidden = true;
      frame.hidden = true;
      frame.removeAttribute("src");
      $("#viewport").classList.remove("desktop");
      return;
    }
    const name = aiName(signingIn.platform);
    if (signingIn.mode === "desktop") {
      ribbon.hidden = false;
      if (signingIn.vnc?.available) {
        if (!frame.getAttribute("src")) frame.src = signingIn.vnc.url;
        frame.hidden = !desktopActive;
        $("#viewport").classList.toggle("desktop", desktopActive);
        $("#signin-text").textContent = !desktopActive ? `Preparing the cloud desktop for ${name}…` : signingIn.resumed ? `The sign-in window for ${name} is still open on the cloud desktop from earlier. Carry on there; when you can see your chats, press` : `A plain browser window is open on the cloud desktop with ${name}, without any automation attached. Sign in there as you normally do; when you can see your chats, press`;
      } else {
        $("#signin-text").textContent = !desktopActive ? `Preparing a browser window for ${name}…` : signingIn.resumed ? `The sign-in window for ${name} is still open on the server's desktop from earlier. When you can see your chats there, press` : `A plain browser window with ${name} is open on the server's desktop. Sign in there; when you can see your chats, press`;
      }
      $("#btn-signin-desktop").hidden = true;
      $("#btn-signin-local").hidden = !signingIn.localOk; // the way out when the check refuses even the plain window
    } else {
      ribbon.hidden = live.meta?.platform !== signingIn.platform;
      frame.hidden = true;
      $("#viewport").classList.remove("desktop");
      $("#signin-text").textContent = signingIn.challenge ? `${name}'s sign-in page has a bot check that may refuse a browser in a datacenter. Sign in above if it lets you; otherwise connect from this computer. When you can see your chats, press` : "Sign in above, exactly as you normally do. When you can see your chats, press";
      $("#btn-signin-desktop").hidden = !signingIn.desktopOk;
      $("#btn-signin-local").hidden = !(signingIn.challenge && signingIn.localOk);
    }
  }
  $("#btn-signin-local").addEventListener("click", async () => { const id = signingIn?.platform; if (!id) return; await cancelSignIn(id); startLocalSignIn(id); });
  $("#btn-control").addEventListener("click", () => { live.setOverride(!live.override); renderRibbons(); $("#viewport").focus({ preventScroll: true }); });
  /** The execution the browser panel is showing: agent, provider, task, current action, elapsed. */
  function renderLiveContext() {
    const el = $("#live-context");
    const shown = live.meta?.platform || browserState?.busy?.platform || browserState?.active || null;
    const runs = [...runningRuns.values()];
    const run = runs.find((r) => r.provider === shown) || runs.find((r) => r.message_id && browserState?.busy?.messageId === r.message_id) || (browserState?.busy ? runs.find((r) => r.provider === browserState.busy.platform) : null) || null;
    if (!run) { el.hidden = true; return; }
    el.hidden = false;
    $("#lc-agent").textContent = run.agent_name || aiName(run.provider) || "Agent";
    $("#lc-provider").textContent = run.provider ? aiName(run.provider) : "control plane";
    $("#lc-task").textContent = run.label || run.task_name || run.kind;
    $("#lc-step").textContent = run.current_step || browserState?.busy?.label || "working";
    const lc = $("#lc-elapsed");
    lc.dataset.since = run.started_at || run.created_at;
    lc.textContent = dur(lc.dataset.since, null);
    $("#lc-stop").hidden = false;
    $("#lc-stop").dataset.stopRun = run.id;
  }
  function renderViewportMessage() {
    const el = $("#viewport-msg");
    const st = live.status();
    if (st.kind === "off") { el.hidden = false; el.innerHTML = `<strong>The browser is off on this deployment</strong><span>Run the Docker image (or set BROWSER_ENABLED=true) to watch and drive your AIs here.</span>`; }
    else if (st.kind === "desktop") {
      el.hidden = !!(signingIn && signingIn.mode === "desktop" && signingIn.vnc?.available);
      const id = browserState?.signIn?.platform;
      if (!el.hidden) el.innerHTML = `<strong>Sign-in to ${esc(aiName(id))} in progress on the cloud desktop</strong><span>${signingIn?.vnc && !signingIn.vnc.available ? "The desktop view is not reachable from here, so the window cannot be shown. Finish it there, or cancel it." : "The live view resumes when it is finished."}</span><span class="row" style="justify-content:center;margin-top:8px"><button class="btn xs" data-signin-resume="${esc(id)}">Continue the sign-in</button><button class="btn xs ghost" data-signin-cancel="${esc(id)}">Cancel it</button></span>`;
    }
    else if (st.kind === "down") { el.hidden = false; el.innerHTML = `<strong>${esc(st.text)}</strong><span>The live view reconnects on its own.</span>`; }
    else if (st.kind === "idle") { el.hidden = false; el.innerHTML = `<strong>Nothing open yet</strong><span>Send a message, or sign in to a provider from the left, and its tab shows up here.</span>`; }
    else el.hidden = true;
  }
  const LEVELS = ["low", "medium", "high"];
  const LEVEL_LABEL = { low: "SD", medium: "HD", high: "HD+" };
  live.level = store.get("acp-quality", "medium");
  $("#btn-quality").textContent = LEVEL_LABEL[live.level];
  $("#btn-quality").addEventListener("click", () => {
    const next = LEVELS[(LEVELS.indexOf(live.level) + 1) % LEVELS.length];
    live.setQuality(next);
    store.set("acp-quality", next);
    $("#btn-quality").textContent = LEVEL_LABEL[next];
    toast(`Picture quality: ${next === "low" ? "lower, for slow connections" : next === "high" ? "highest" : "standard"}.`);
  });
  $("#btn-fullscreen").addEventListener("click", () => {
    const el = $("#browser");
    if (document.fullscreenElement) document.exitFullscreen(); else el.requestFullscreen?.();
  });
  document.addEventListener("fullscreenchange", () => $("#btn-fullscreen").innerHTML = icon(document.fullscreenElement ? "close" : "expand"));

  /* sign-in: in the live view, or on the cloud desktop for sites with a bot check */
  async function startSignIn(id, mode) {
    const c = conn(id);
    if (!c) return;
    if (browserState && browserState.enabled === false) return toast("The browser is off on this deployment, so there is nowhere to sign in.", "bad");
    const wanted = mode || c.signInMode || "live";
    if (wanted === "local") return startLocalSignIn(id);
    showBrowser();
    if (wanted === "desktop") return startDesktopSignIn(id);
    signingIn = { platform: id, mode: "live" };
    renderRibbons();
    try {
      const r = await api(`/connections/${id}/connect`, { method: "POST", body: {} });
      signingIn = { platform: id, mode: "live", challenge: r.challenge, desktopOk: !!(r.desktop && r.desktop.ok), localOk: !!(r.local && r.local.ok) };
      live.watch(id);
      renderTabs(); renderRibbons();
      if (r.blocked && r.desktop && r.desktop.ok) {
        toast(`${c.name}'s sign-in page refused the automated browser. Switching to the cloud desktop.`);
        return startDesktopSignIn(id);
      }
      if (r.blocked) {
        toast(`${c.name}'s sign-in page refused the automated browser. Sign in from this computer instead.`);
        return startLocalSignIn(id);
      }
      $("#viewport").focus({ preventScroll: true });
      toast(`Sign in to ${c.name} in the browser panel.`);
    } catch (err) { signingIn = null; renderRibbons(); fail(err); }
  }
  async function startDesktopSignIn(id) {
    const c = conn(id);
    signingIn = { platform: id, mode: "desktop" };
    renderRibbons();
    try {
      const r = await api(`/connections/${id}/signin`, { method: "POST", body: { mode: "desktop" } });
      const resumed = !!(r.signIn && r.signIn.since && Date.now() - new Date(r.signIn.since).getTime() > 15_000);
      signingIn = { platform: id, mode: "desktop", vnc: r.vnc, desktopOk: true, localOk: !!(r.local && r.local.ok), resumed };
      renderRibbons(); renderTabs();
      toast(resumed ? `Back in the sign-in window for ${c?.name || id}.` : r.vnc?.available ? `Sign in to ${c?.name || id} in the desktop window.` : `A browser window with ${c?.name || id} opened on the server's desktop.`);
    } catch (err) { signingIn = null; renderRibbons(); fail(err); }
  }
  $("#btn-signin-desktop").addEventListener("click", () => { if (signingIn) startDesktopSignIn(signingIn.platform); });
  $("#btn-signed-in").addEventListener("click", async (e) => {
    if (!signingIn) return;
    const { platform: id, mode } = signingIn;
    try {
      await busy(e.currentTarget, async () => {
        const r = await api(`/connections/${id}/${mode === "desktop" ? "signin/finish" : "check"}`, { method: "POST", body: {} });
        if (r.status === "logged_in") {
          toast(`${r.name} is connected.`, "ok");
          signingIn = null;
          live.followAgent();
          renderRibbons(); renderTabs();
        } else if (mode === "desktop") {
          toast(r.status === "needs_login" ? `${r.name} still looks signed out. The window was closed; start the sign-in again, or use "Connect from this computer" from its menu if the site refused the check.` : `Could not check ${r.name}: ${r.lastError || "try again"}`, "bad");
          signingIn = null;
          renderRibbons();
        } else {
          toast(r.status === "needs_login" ? `${r.name} still looks signed out. Finish signing in, then press again.` : `Could not check ${r.name}: ${r.lastError || "try again"}`, "bad");
        }
      });
    } catch (err) { fail(err); }
  });
  $("#btn-signin-dismiss").addEventListener("click", () => cancelSignIn(signingIn?.platform));
  /** Cancel a sign-in wherever it was started from: this page, another tab, or a tab that was closed. */
  async function cancelSignIn(id) {
    const s = signingIn;
    signingIn = null;
    renderRibbons();
    const platform = id || s?.platform;
    if (s?.mode === "desktop" || browserState?.signIn?.platform === platform) {
      try {
        await api(`/connections/${platform}/signin/cancel`, { method: "POST", body: {} });
        toast(`The sign-in to ${aiName(platform)} was cancelled. Start it again whenever you are ready.`);
      } catch (err) { fail(err); }
    }
  }

  /* ---------- add a provider ---------- */
  $("#btn-add-ai").addEventListener("click", () => { $("#add-modal").hidden = false; $("#add-name").focus(); });
  $("#add-ai-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const c = await api("/connections", { method: "POST", body: { name: $("#add-name").value.trim(), appUrl: $("#add-url").value.trim(), purpose: $("#add-purpose").value.trim() } });
      e.target.reset();
      $("#add-modal").hidden = true;
      const i = connections.findIndex((x) => x.id === c.id);
      if (i >= 0) connections[i] = c; else connections.push(c);
      renderAiList(); renderTargets();
      toast(`${c.name} added. Sign in to it from the menu next to its name.`, "ok");
    } catch (err) { fail(err); }
  });

  /* ---------- settings ---------- */
  let settings = null;
  async function openSettings(tab = "general", aiId = null) {
    try {
      settings = await api("/settings");
      $("#password-note").textContent = settings.passwordFromEnv ? "The password is set on the server (ACP_ADMIN_TOKEN). Change it there." : "";
      $("#password-form").hidden = settings.passwordFromEnv;
      $("#router-note").textContent = settings.router.provider === "claude-code" ? "Claude decides which AI gets each message, using your Claude subscription (CLAUDE_CODE_OAUTH_TOKEN). Claude also double-checks whether a message is a question for the control plane."
        : settings.router.provider === "api" ? `Claude (${settings.router.model}) decides which AI gets each message, using your Anthropic API key, and double-checks whether a message is a question for the control plane.`
        : "Messages go to the AI you name, or to the only connected AI. Questions about your agents and tasks are answered by the control plane itself. To let Claude decide between several AIs, set CLAUDE_CODE_OAUTH_TOKEN (from “claude setup-token”) or ANTHROPIC_API_KEY on the server.";
      $("#alerts-note").textContent = settings.alerts.telegram || settings.alerts.webhook ? `Failures and sign-outs are sent to ${[settings.alerts.telegram ? "Telegram" : "", settings.alerts.webhook ? "your webhook" : ""].filter(Boolean).join(" and ")}.` : "Not set up. Add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID, or ALERT_WEBHOOK_URL, on the server to get notified when something fails or an AI signs you out.";
      const st = settings.storage;
      $("#storage-note").textContent = st.persistedBy === "database" ? `Sign-ins, chats and settings are mirrored to your Postgres database${st.database.lastSaveAt ? ` (last saved ${rel(st.database.lastSaveAt)})` : ""}. No volume needed.`
        : st.persistedBy === "volume" ? `Sign-ins are saved on a persistent disk${st.backupAt ? ` and were backed up ${rel(st.backupAt)}` : ""}.`
        : st.persistedBy === "none" ? `Warning: nothing keeps ${st.dataDir} between deploys. Add a Postgres database (reference DATABASE_URL in this service) or attach a volume there. Download a copy of your sign-ins to be safe.`
        : `Sign-ins are saved under ${st.dataDir}${st.backupAt ? `, backed up ${rel(st.backupAt)}` : ""}.`;
      $("#ingest-token").textContent = settings.ingestToken;
      $("#btn-rotate-token").hidden = settings.ingestTokenFromEnv;
      const base = home?.publicUrl || location.origin;
      $("#ingest-example").textContent = `# register your agent once
curl -X POST ${base}/api/agents/register \\
  -H "Authorization: Bearer ${settings.ingestToken}" -H "Content-Type: application/json" \\
  -d '{ "key": "scanner-bot", "name": "Scanner bot", "description": "watches repositories" }'

# report a finished run of one of its tasks
curl -X POST ${base}/api/ingest \\
  -H "Authorization: Bearer ${settings.ingestToken}" -H "Content-Type: application/json" \\
  -d '{ "agent": { "key": "nightly-audit", "platform": "custom", "name": "Nightly audit", "schedule": "daily 02:00" },
        "profile": { "key": "scanner-bot" },
        "run": { "status": "success", "summary": "0 issues found" } }'`;
      await renderPolicies();
      const sel = $("#ai-select");
      sel.innerHTML = connections.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
      sel.value = aiId || connections[0]?.id || "";
      if (sel.value) await fillAiForm(sel.value);
      showSettingsTab(tab);
      $("#settings-modal").hidden = false;
    } catch (err) { fail(err); }
  }
  async function renderPolicies() {
    const p = await api("/policies");
    $("#policy-list").innerHTML = p.policies.map((x) => `<div class="policy-row"><div class="body"><div>${esc(x.definition.label)}${x.override ? ` <span class="badge">custom</span>` : ""}</div><div class="sub">${esc(x.definition.description)}${x.definition.floor !== "auto" ? ` Never below “${x.definition.floor}”.` : ""}</div></div>
      <div class="seg">${["auto", "ask", "always"].map((m) => `<button class="seg-btn ${x.mode === m ? "active" : ""}" data-policy="${esc(x.action)}" data-mode-set="${m}" ${["auto", "ask", "always"].indexOf(m) < ["auto", "ask", "always"].indexOf(x.definition.floor) ? "disabled" : ""}>${m === "auto" ? "Go ahead" : m === "ask" ? "Ask" : "Always ask"}</button>`).join("")}</div>
      ${x.override ? `<button class="btn xs ghost" data-policy="${esc(x.action)}" data-mode-set="" title="Follow the switch again">reset</button>` : ""}</div>`).join("");
  }
  $("#policy-list").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-policy]");
    if (!b || b.disabled) return;
    try {
      await api(`/policies/${b.dataset.policy}`, { method: "PUT", body: { mode: b.dataset.modeSet || null } });
      await renderPolicies();
    } catch (err) { fail(err); }
  });
  function showSettingsTab(tab) {
    for (const b of $$(".subtab")) b.classList.toggle("active", b.dataset.stab === tab);
    for (const s of $$(".stab")) s.hidden = s.id !== `stab-${tab}`;
  }
  $("#settings-tabs").addEventListener("click", (e) => { const b = e.target.closest("[data-stab]"); if (b) showSettingsTab(b.dataset.stab); });
  $("#btn-settings").addEventListener("click", () => openSettings("general"));
  const AI_FIELDS = ["name", "purpose", "appUrl", "chatUrl", "tasksUrl", "composerSelector", "sendSelector", "replySelector", "busySelector", "loggedOutSelector", "sessionCookie", "cookieDomain"];
  async function fillAiForm(id) {
    const p = await api(`/platforms/${id}`);
    for (const f of AI_FIELDS) $(`#ai-${f}`).value = p[f] ?? "";
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
    for (const f of AI_FIELDS) body[f] = $(`#ai-${f}`).value.trim();
    body.loginUrlPatterns = lines($("#ai-loginUrlPatterns").value);
    body.capturePatterns = lines($("#ai-capturePatterns").value);
    try { await api(`/connections/${id}`, { method: "PUT", body }); toast("Saved.", "ok"); await load(current ? current.id : null); } catch (err) { fail(err); }
  });
  $("#ai-restore").addEventListener("click", async () => {
    const id = $("#ai-form").dataset.id;
    if (!confirm("Restore this provider's built-in settings?")) return;
    try { await api(`/connections/${id}/restore`, { method: "POST", body: {} }); await fillAiForm(id); toast("Defaults restored.", "ok"); await load(current ? current.id : null); } catch (err) { fail(err); }
  });
  $("#ai-remove").addEventListener("click", async () => {
    const id = $("#ai-form").dataset.id;
    if (!confirm(`Remove ${aiName(id)} from the app? You can add it back later.`)) return;
    try { await api(`/connections/${id}`, { method: "DELETE" }); $("#settings-modal").hidden = true; toast("Removed.", "ok"); await load(current ? current.id : null); } catch (err) { fail(err); }
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
      toast(`Restored ${r.imported} cookies. Check each provider from its menu.`, "ok");
      await load(current ? current.id : null);
    } catch (err) { fail(err); } finally { e.target.value = ""; }
  });

  /* ---------- expanding details inside views ---------- */
  async function toggleDetail(kind, id, host) {
    const box = $(`#${kind}-detail-${id}`, host) || host.querySelector(`.${kind}-detail`);
    if (kind === "run") {
      let box2 = host.nextElementSibling?.classList.contains("run-detail") ? host.nextElementSibling : null;
      if (box2) { box2.remove(); return; }
      box2 = document.createElement("div");
      box2.className = "run-detail";
      box2.innerHTML = `<span class="muted small">Loading…</span>`;
      host.insertAdjacentElement("afterend", box2);
      await Views.detail.run(box2, id, viewCtx);
      tickTimers();
      return;
    }
    if (!box) return;
    if (!box.hidden) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = `<span class="muted small">Loading…</span>`;
    await Views.detail[kind](box, id, viewCtx);
    tickTimers();
  }

  /* ---------- global clicks ---------- */
  document.addEventListener("click", async (e) => {
    for (const d of $$("details.menu[open]")) if (!d.contains(e.target)) d.removeAttribute("open");
    const t = e.target.closest("[data-send],[data-del],[data-connect],[data-signin-resume],[data-signin-cancel],[data-pairing-cancel],[data-view-ai],[data-check],[data-refresh],[data-remove],[data-read],[data-read-all],[data-shot],[data-open-settings],[data-close],[data-approve],[data-approve-id],[data-cancel],[data-stop-run],[data-run-task],[data-pause-task],[data-resume-task],[data-sync-all],[data-toggle],[data-conv],[data-rename],[data-delete-conv],[data-ai],[data-example],[data-nav],[data-filter],[data-filter-clear],[data-open-run],[data-open-task],[data-open-agent],[data-log-clear]");
    if (!t) {
      const ov = e.target.closest("[data-close-on-click]");
      if (ov && e.target === ov) ov.hidden = true;
      return;
    }
    if (e.target.closest("details.menu") && !e.target.closest(".menu-list")) return; // the ⋯ summary itself
    if (t.tagName === "A" && t.hasAttribute("href") && !t.dataset.nav && !t.closest(".menu-list")) return; // plain links open normally
    const btn = t.tagName === "BUTTON" ? t : null;
    const d = t.dataset;
    try {
      if (d.close !== undefined) { t.closest(".overlay").hidden = true; }
      if (d.nav !== undefined) { e.preventDefault(); if (t.closest(".overlay")) t.closest(".overlay").hidden = true; setView(d.nav, d.filter || ""); }
      else if (d.filter !== undefined && !d.nav) { viewFilter = d.filter; renderView(); }
      else if (d.filterClear !== undefined) { viewFilter = ""; renderView(); }
      else if (d.send) { await busy(btn, () => api(`/chat/${d.send}/send`, { method: "POST", body: { platform: d.platform } })); }
      else if (d.approve) { await busy(btn, () => api(`/chat/${d.approve}/approve`, { method: "POST", body: { decision: d.decision } })); }
      else if (d.approveId) { await busy(btn, () => api(`/approvals/${d.approveId}/decide`, { method: "POST", body: { decision: d.decision } })); refreshOverview(); refreshView(); }
      else if (d.cancel) { await busy(btn, () => api(`/chat/${d.cancel}/cancel`, { method: "POST", body: {} })); }
      else if (d.stopRun) { e.stopPropagation(); const run = runningRuns.get(Number(d.stopRun)); const m = run?.message_id ? { id: run.message_id } : null; if (m) await api(`/chat/${m.id}/cancel`, { method: "POST", body: {} }); else toast("This run cannot be stopped from here yet.", "bad"); }
      else if (d.runTask) { e.stopPropagation(); await busy(btn, async () => { const r = await api(`/tasks/${d.runTask}/run`, { method: "POST", body: {} }); toast(r.run.status === "running" ? "Started. Its agent will report back." : r.run.status === "success" ? `Started. ${r.run.summary || ""}` : r.run.error || "Not started", r.ok ? "ok" : "bad"); }); refreshView(); }
      else if (d.pauseTask) { await api(`/tasks/${d.pauseTask}`, { method: "PATCH", body: { enabled: false } }); refreshView(); }
      else if (d.resumeTask) { await api(`/tasks/${d.resumeTask}`, { method: "PATCH", body: { enabled: true } }); refreshView(); }
      else if (d.syncAll !== undefined) { await busy(btn, () => api("/sync", { method: "POST", body: {} })); refreshView(); }
      else if (d.toggle) { const box = t.closest(".activity"); const open = !box.classList.contains("open"); box.classList.toggle("open", open); openActivity.set(Number(d.toggle), open); }
      else if (d.del) { await api(`/chat/${d.del}`, { method: "DELETE" }); }
      else if (d.conv) { if (!(view === "chat" && current && current.id === Number(d.conv))) await openConversation(Number(d.conv)); else if (isNarrow()) setPanel("chat"); }
      else if (d.rename) { const c = conversations.find((x) => x.id === Number(d.rename)); const title = prompt("Rename this chat", c?.title || ""); if (title !== null) await api(`/conversations/${d.rename}`, { method: "PATCH", body: { title: title.trim() } }); }
      else if (d.deleteConv) { if (confirm("Delete this chat and its messages?")) await api(`/conversations/${d.deleteConv}`, { method: "DELETE" }); }
      else if (d.ai !== undefined) { const c = conn(d.ai); setTarget(target === d.ai ? "" : d.ai); if (c && browserState?.pages?.some((p) => p.platform === c.id)) { live.watch(c.id); renderTabs(); } }
      else if (d.connect) { if (t.closest(".overlay")) t.closest(".overlay").hidden = true; await startSignIn(d.connect, d.mode || null); }
      else if (d.signinResume) { showBrowser(); await startDesktopSignIn(d.signinResume); } // the server hands back the sign-in already open for this provider
      else if (d.signinCancel) { await busy(btn, () => cancelSignIn(d.signinCancel)); }
      else if (d.pairingCancel) { await busy(btn, () => api(`/connections/${d.pairingCancel}/pairing`, { method: "DELETE" })); if (pairing?.platform === d.pairingCancel) { closePairing(); pairing = null; } toast("Cancelled. Make a new code whenever you are ready."); }
      else if (d.logClear !== undefined) { const l = $("#log-lines"); if (l) l.innerHTML = ""; }
      else if (d.viewAi) { showBrowser(); if (browserState?.pages?.some((p) => p.platform === d.viewAi)) live.watch(d.viewAi); else { await api("/browser/open", { method: "POST", body: { platform: d.viewAi, url: conn(d.viewAi)?.appUrl } }); live.watch(d.viewAi); } renderTabs(); }
      else if (d.check) { await busy(btn, async () => { const r = await api(`/connections/${d.check}/check`, { method: "POST", body: {} }); toast(r.status === "logged_in" ? `${r.name} is connected.` : `${r.name} is signed out.`, r.status === "logged_in" ? "ok" : "bad"); }); }
      else if (d.refresh) { await busy(btn, async () => { const c = conn(d.refresh); if (c?.canSync) await api(`/platforms/${c.id}/sync`, { method: "POST" }); else await api(`/connections/${d.refresh}/check`, { method: "POST", body: {} }); }); refreshView(); }
      else if (d.remove) { if (confirm(`Remove ${aiName(d.remove)} from the app?`)) { await api(`/connections/${d.remove}`, { method: "DELETE" }); await load(current ? current.id : null); } }
      else if (d.read) { await api(`/events/${d.read}/read`, { method: "POST", body: {} }); refreshOverview(); refreshView(); }
      else if (d.readAll !== undefined) { await api("/events/read-all", { method: "POST", body: {} }); refreshOverview(); refreshView(); }
      else if (d.shot) { $("#shot-img").src = `/api/platforms/${d.shot}/screenshot.png?t=${Date.now()}`; $("#shot-modal").hidden = false; }
      else if (d.openSettings) { if (t.closest(".overlay") && t.closest(".overlay").id !== "settings-modal") t.closest(".overlay").hidden = true; await openSettings(d.openSettings, d.aiId || null); }
      else if (d.example) { setView("chat"); ta.value = d.example; autogrow(); ta.focus(); }
      else if (d.openRun) { if (e.target.closest("button, a")) return; await toggleDetail("run", Number(d.openRun), t); }
      else if (d.openTask) { if (e.target.closest("button, a, details")) return; await toggleDetail("task", Number(d.openTask), t); }
      else if (d.openAgent) { if (e.target.closest("button, a")) return; await toggleDetail("agent", Number(d.openAgent), t); }
    } catch (err) { fail(err); }
  });
  // The logs view's filters; the console level is a server setting and is audited.
  $("#view").addEventListener("change", async (e) => {
    const t = e.target;
    if (!(t instanceof HTMLSelectElement)) return;
    if (t.dataset.logLevel !== undefined) { store.set("acp-log-level", t.value); renderView(); }
    else if (t.dataset.logScope !== undefined) { store.set("acp-log-scope", t.value); renderView(); }
    else if (t.dataset.consoleLevel !== undefined) {
      try { await api("/logs/level", { method: "PUT", body: { level: t.value } }); toast(`The server now prints ${t.value} and above to its console.`, "ok"); } catch (err) { fail(err); }
    }
  });
  $("#lc-stop").addEventListener("click", async (e) => {
    const id = Number(e.currentTarget.dataset.stopRun);
    const run = runningRuns.get(id);
    try { if (run?.message_id) await api(`/chat/${run.message_id}/cancel`, { method: "POST", body: {} }); else toast("This run cannot be stopped from here yet.", "bad"); } catch (err) { fail(err); }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { for (const o of $$(".overlay")) o.hidden = true; }
  });

  /* ---------- boot ---------- */
  async function start() {
    await load();
    connectStream();
    live.connect();
    const h = viewFromHash();
    setView(h.name, h.filter);
    if (isNarrow()) setPanel(connections.some((c) => c.status === "logged_in") ? "chat" : "side");
  }
  (async () => {
    try {
      const s = await fetch("/api/setup").then((r) => r.json());
      if (s.setupRequired) return showGate("setup");
      const ok = await fetch("/api/session", { credentials: "same-origin" }).then((r) => r.ok);
      if (!ok) return showGate("login");
      await start();
    } catch (err) { console.error(err); showGate("login"); }
  })();
})();
