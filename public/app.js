/* AI Control Plane — workspace: AIs + chats · conversation · live browser */
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
  let attention = [];
  let activity = [];
  let signingIn = null; // platform id while the sign-in ribbon shows
  const openActivity = new Map(); // message id -> user toggled open/closed
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
  const aiName = (id) => conn(id)?.name || id || "an AI";
  const statusOf = (c) => c.status === "logged_in" ? { dot: "ok", label: "Connected" } : c.status === "needs_login" ? { dot: "warn", label: "Signed out" } : c.status === "error" ? { dot: "bad", label: "Problem" } : { dot: "", label: "Not connected" };
  const isRunning = (m) => m.status === "assigned" || m.status === "delivered";

  /* ---------- gate ---------- */
  let gateMode = "login";
  function showGate(mode) {
    gateMode = mode;
    $("#gate").hidden = false;
    $("#gate-title").textContent = mode === "setup" ? "Create your password" : "Welcome back";
    $("#gate-text").textContent = mode === "setup" ? "This is the only password you need. It protects your chats and your saved sign-ins." : "Enter your password to open the workspace.";
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
    attention = h.attention;
    activity = h.activity;
    if (conversationId === null) { current = null; messages = []; }
    else { current = h.conversation; messages = h.messages; }
    renderAll();
  }
  function renderAll() {
    renderAiList();
    renderEngine();
    renderChatList();
    renderHeader();
    renderMode();
    renderTargets();
    renderThread();
    renderTabs();
    renderBadge();
    live.setState && live.setState(browserState);
  }
  function renderBadge() {
    const n = connections.filter((c) => c.status === "needs_login").length + attention.filter((x) => x.kind !== "session").length;
    $("#badge-attention").hidden = !n;
    $("#badge-attention").textContent = n;
  }

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
      renderAiList(); renderTargets(); renderBadge();
    });
    es.addEventListener("browser", (e) => {
      browserState = JSON.parse(e.data);
      renderAiList(); renderEngine(); renderTabs(); renderRibbons();
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
  const showBrowser = () => { app.classList.remove("browser-collapsed"); store.set("acp-browser", "open"); reflectCollapse(); if (isNarrow()) setView("browser"); };
  $("#btn-browser-close").addEventListener("click", () => { app.classList.add("browser-collapsed"); store.set("acp-browser", "closed"); reflectCollapse(); });
  $("#btn-browser-open").addEventListener("click", showBrowser);
  $("#btn-browser-fab").addEventListener("click", showBrowser);
  const isNarrow = () => window.matchMedia("(max-width: 960px)").matches;
  function setView(v) {
    app.dataset.view = v;
    for (const b of $$(".mobile-nav .seg-btn")) b.classList.toggle("active", b.dataset.view === v);
  }
  $(".mobile-nav").addEventListener("click", (e) => { const b = e.target.closest("[data-view]"); if (b) setView(b.dataset.view); });
  applyWidths();

  /* ---------- left: AIs ---------- */
  function renderAiList() {
    const busyP = browserState?.busy?.platform;
    const rows = connections.filter((c) => c.appUrl || c.builtin).map((c) => {
      const st = statusOf(c);
      const busyLabel = busyP === c.id ? browserState.busy.label : null;
      const showing = browserState?.active === c.id && browserState?.pages?.some((p) => p.platform === c.id);
      return `<div class="ai-row ${target === c.id ? "active" : ""}" data-ai="${c.id}" role="button" tabindex="0" title="${target === c.id ? "Sending to this AI. Click to go back to Auto." : `Send your next message to ${esc(c.name)}`}">
        <span class="avatar ${esc(c.id)}">${esc(c.name.slice(0, 1))}</span>
        <div class="info"><div class="name">${esc(c.name)}${showing ? `<span class="muted" title="Showing in the browser panel">${icon("eye", "sm")}</span>` : ""}</div>
        <div class="sub ${busyLabel ? "busy" : ""}">${esc(busyLabel || st.label)}${c.lastError && c.status !== "logged_in" && !busyLabel ? ` · ${esc(c.lastError)}` : ""}</div></div>
        <span class="dot ${busyLabel ? "run" : st.dot}"></span>
        <details class="menu"><summary class="btn icon ghost" aria-label="More" style="width:24px;height:24px">${icon("more", "sm")}</summary><div class="menu-list">
          ${c.status === "logged_in" ? `<button class="btn small" data-view-ai="${c.id}">${icon("eye", "sm")} Show in browser</button><button class="btn small" data-check="${c.id}">${icon("check", "sm")} Check sign-in</button><button class="btn small" data-connect="${c.id}">${icon("login", "sm")} Sign in again</button>` : `<button class="btn small" data-connect="${c.id}">${icon("login", "sm")} Sign in</button>`}
          <button class="btn small" data-open-settings="ai" data-ai-id="${c.id}">${icon("edit", "sm")} Edit</button>
          <button class="btn small danger" data-remove="${c.id}">${icon("trash", "sm")} Remove</button></div></details>
      </div>`;
    });
    $("#ai-list").innerHTML = rows.join("") || `<div class="side-empty">No AIs yet. Add one with +.</div>`;
  }
  function renderEngine() {
    const b = browserState;
    const r = home?.router;
    const tabs = b?.pages?.length ?? 0;
    const bl = !b || b.enabled === false ? ["", "Cloud browser off"] : b.running ? ["ok", `Cloud browser on · ${tabs} tab${tabs === 1 ? "" : "s"}`] : ["warn", "Cloud browser starting…"];
    const rl = r?.llm ? `Routing by Claude${r.provider === "claude-code" ? " (subscription)" : ""}` : "Routing by name or keywords";
    const ml = approvalMode === "manual" ? "Asks you before sending" : "Acts on its own";
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
    el.innerHTML = conversations.map((c) => {
      const at = c.last_message_at || c.created_at;
      const g = groupOf(at);
      const head = g !== lastGroup ? `<div class="chat-group">${g}</div>` : "";
      lastGroup = g;
      const dot = c.active ? `<span class="dot run"></span>` : c.last_status === "failed" ? `<span class="dot bad" title="Something failed"></span>` : c.last_status === "needs_assignment" ? `<span class="dot warn" title="Needs you"></span>` : "";
      return `${head}<div class="chat-row ${current && current.id === c.id ? "active" : ""}" data-conv="${c.id}" role="button" tabindex="0">
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
      renderChatList(); renderHeader(); renderThread();
      if (isNarrow()) setView("chat");
    } catch (err) { fail(err); }
  }
  function newChat() {
    current = null;
    messages = [];
    renderChatList(); renderHeader(); renderThread();
    if (isNarrow()) setView("chat");
    $("#chat-text").focus();
  }
  $("#btn-new-chat").addEventListener("click", newChat);

  /* ---------- middle: header, mode, targets ---------- */
  function renderHeader() {
    $("#chat-title").textContent = current ? current.title || "New chat" : "New chat";
    const n = current?.message_count ?? messages.length;
    $("#chat-sub").textContent = current ? `${n} message${n === 1 ? "" : "s"}` : "";
  }
  $("#chat-title").addEventListener("click", async () => {
    if (!current) return;
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
      toast(approvalMode === "manual" ? "The agent will now pause and ask before sending anything." : "The agent now acts on its own.");
    } catch (err) { fail(err); }
  });
  function renderTargets() {
    const chattable = connections.filter((c) => c.canChat);
    $("#targets").innerHTML =
      `<button type="button" class="chip ${target === "" ? "active" : ""}" data-target="" role="radio" aria-checked="${target === ""}" title="Pick the AI from what you write">Auto</button>` +
      chattable.map((c) => `<button type="button" class="chip ${target === c.id ? "active" : ""}" data-target="${c.id}" role="radio" aria-checked="${target === c.id}" title="${c.status === "logged_in" ? `Send to ${esc(c.name)}` : `${esc(c.name)} is not connected`}"><span class="dot ${statusOf(c).dot}"></span>${esc(c.name)}</button>`).join("");
    $("#chat-send").disabled = chattable.length === 0;
    $("#chat-text").placeholder = chattable.some((c) => c.status === "logged_in") ? "Message your AIs…" : "Sign in to an AI first, then message it here…";
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
      inner.innerHTML = `<div class="thread-empty"><strong>${connected.length ? "What should your AIs do?" : "Connect an AI to begin."}</strong>${connected.length
        ? `Chat normally or give an instruction. It goes to the AI you name or pick, the answer comes back here, and you can watch it happen in the browser panel.<div class="examples">${["Grok, what's trending in AI today?", "Claude, draft this week's status report", "Set up a daily 9am summary of my tasks"].map((x) => `<button class="chip" data-example="${esc(x)}">${esc(x)}</button>`).join("")}</div>`
        : `Open the menu next to an AI on the left and press Sign in. You sign in inside the browser panel, once.`}</div>`;
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
    const name = aiName(m.platform || m.agent_platform);
    const pid = m.platform || m.agent_platform || "";
    const others = (except) => connections.filter((c) => c.canChat && c.id !== except).map((c) => `<button class="btn small ghost" data-send="${m.id}" data-platform="${c.id}">Send to ${esc(c.name)}</button>`).join("");
    let reply = "";
    if (m.status === "done" || (m.status === "acknowledged" && m.response)) {
      reply = `<div class="msg ai"><span class="avatar ${esc(pid)}">${esc(name.slice(0, 1))}</span><div class="col"><div class="meta"><span class="who">${esc(name)}</span>${rel(m.acked_at || m.updated_at)}</div><div class="bubble ai">${esc(m.response || "Done.")}</div></div></div>`;
    } else if (m.status === "failed") {
      reply = `<div class="msg ai"><span class="avatar ${esc(pid)}">!</span><div class="col"><div class="bubble error">${esc(m.error || "Something went wrong.")}</div><div class="choices">${m.status === "failed" && conn(pid)?.status === "needs_login" ? `<button class="btn small primary" data-connect="${esc(pid)}">Sign in to ${esc(name)}</button>` : ""}${pid ? `<button class="btn small" data-send="${m.id}" data-platform="${esc(pid)}">Try again</button>` : ""}${others(pid)}</div></div></div>`;
    } else if (m.status === "cancelled") {
      reply = `<div class="msg ai"><div class="col"><div class="bubble note">${esc(m.error || "Stopped.")}</div><div class="choices">${pid ? `<button class="btn small" data-send="${m.id}" data-platform="${esc(pid)}">Send again</button>` : ""}${others(pid)}</div></div></div>`;
    } else if (m.agent_id && (m.status === "assigned" || m.status === "delivered" || m.status === "acknowledged")) {
      reply = `<div class="msg ai"><div class="col"><div class="bubble note">${esc(m.delivery_hint ? `Handed to ${m.agent_name}: ${m.delivery_hint}.` : `Handed to ${m.agent_name}.`)}</div></div></div>`;
    }
    return `<div class="turn" id="message-${m.id}">
      <div class="msg me"><div class="col"><div class="bubble me">${esc(m.text)}</div><div class="meta">${clock(m.created_at)}<button class="btn icon ghost" data-del="${m.id}" title="Remove from this chat" aria-label="Remove">${icon("trash", "sm")}</button></div></div></div>
      ${renderActivity(m)}${reply}</div>`;
  }

  function renderActivity(m) {
    const steps = m.steps || [];
    const running = isRunning(m) && !m.agent_id;
    const waiting = steps.find((s) => s.status === "waiting");
    if (!steps.length && !running && m.status !== "needs_assignment") return "";
    const name = aiName(m.platform);
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
  function tickTimers() { for (const el of $$(".elapsed[data-since]")) el.textContent = dur(el.dataset.since, null); }
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
        if (!r.routed) toast("Not sure which AI should do this. Pick one in the thread.");
      });
      scrollThread(true);
      ta.focus();
    } catch (err) { fail(err); }
  });

  /* ---------- right: live browser ---------- */
  const live = new LiveView({
    canvas: $("#screen"),
    viewport: $("#viewport"),
    onState: (s) => { browserState = s; renderTabs(); renderRibbons(); renderAiList(); renderEngine(); },
    onMeta: () => { renderUrl(); renderTabs(); renderViewportMessage(); },
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
    for (const b of $$("[data-nav]")) b.disabled = !shown;
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
    if (!live.meta?.platform) return toast("Open an AI first, then you can navigate its tab.");
    live.nav(v);
    $("#viewport").focus({ preventScroll: true });
  });
  $("#url").addEventListener("blur", renderUrl);
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-nav]");
    if (!b) return;
    if (b.dataset.nav === "back") live.back(); else if (b.dataset.nav === "forward") live.forward(); else live.reload();
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
    $("#signin-ribbon").hidden = !signingIn || live.meta?.platform !== signingIn;
    $("#viewport").classList.toggle("interactive", live.interactive);
  }
  $("#btn-control").addEventListener("click", () => { live.setOverride(!live.override); renderRibbons(); $("#viewport").focus({ preventScroll: true }); });
  function renderViewportMessage() {
    const el = $("#viewport-msg");
    const st = live.status();
    if (st.kind === "off") { el.hidden = false; el.innerHTML = `<strong>The browser is off on this deployment</strong><span>Run the Docker image (or set BROWSER_ENABLED=true) to watch and drive your AIs here.</span>`; }
    else if (st.kind === "down") { el.hidden = false; el.innerHTML = `<strong>${esc(st.text)}</strong><span>The live view reconnects on its own.</span>`; }
    else if (st.kind === "idle") { el.hidden = false; el.innerHTML = `<strong>Nothing open yet</strong><span>Send a message, or sign in to an AI from the left, and its tab shows up here.</span>`; }
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

  /* sign-in inside the live view */
  async function startSignIn(id) {
    const c = conn(id);
    if (!c) return;
    if (browserState && browserState.enabled === false) return toast("The browser is off on this deployment, so there is nowhere to sign in.", "bad");
    signingIn = id;
    showBrowser();
    try {
      await api(`/connections/${id}/connect`, { method: "POST", body: {} });
      live.watch(id);
      renderTabs(); renderRibbons();
      $("#viewport").focus({ preventScroll: true });
      toast(`Sign in to ${c.name} in the browser panel.`);
    } catch (err) { signingIn = null; renderRibbons(); fail(err); }
  }
  $("#btn-signed-in").addEventListener("click", async (e) => {
    if (!signingIn) return;
    const id = signingIn;
    try {
      await busy(e.currentTarget, async () => {
        const r = await api(`/connections/${id}/check`, { method: "POST", body: {} });
        if (r.status === "logged_in") {
          toast(`${r.name} is connected.`, "ok");
          signingIn = null;
          live.followAgent();
          renderRibbons(); renderTabs();
        } else {
          toast(r.status === "needs_login" ? `${r.name} still looks signed out. Finish signing in, then press again.` : `Could not check ${r.name}: ${r.lastError || "try again"}`, "bad");
        }
      });
    } catch (err) { fail(err); }
  });
  $("#btn-signin-dismiss").addEventListener("click", () => { signingIn = null; renderRibbons(); });

  /* ---------- activity modal ---------- */
  const runCls = (s) => ({ success: "ok", failed: "bad", needs_attention: "warn", running: "run" })[s] || "";
  const runLabel = (s) => ({ success: "ok", failed: "failed", needs_attention: "needs you", running: "running" })[s] || s || "";
  async function openActivityModal() {
    try {
      const h = await api("/home");
      attention = h.attention; activity = h.activity; connections = h.connections; home = h;
      renderBadge();
      $("#attention").innerHTML = [
        h.storage?.persistedBy === "none" ? `<div class="notice warn"><div class="body"><strong>Your sign-ins and chats will be lost on the next deploy.</strong><div class="sub">Nothing keeps this server's data folder. Add a Postgres database to the Railway project and reference its DATABASE_URL in this service, or attach a volume at ${esc(h.storage.dataDir)}.</div></div><button class="btn small" data-open-settings="general">Open Settings</button></div>` : "",
        h.storage?.database?.lastError ? `<div class="notice bad"><div class="body"><strong>The database backup is failing.</strong><div class="sub">${esc(h.storage.database.lastError)}</div></div></div>` : "",
        ...attention.map((x) => {
          const cls = x.kind === "session" ? "warn" : x.kind === "run" ? "bad" : x.action === "retry" ? "bad" : "warn";
          const btn = x.action === "connect" ? `<button class="btn small primary" data-connect="${esc(x.platform)}">Sign in</button>` : x.action === "choose" || x.action === "retry" ? `<button class="btn small" data-close>Open chat</button>` : `<button class="btn small ghost" data-read="${x.id}">Dismiss</button>`;
          return `<div class="notice ${cls}"><div class="body"><strong>${esc(x.title)}</strong>${x.body ? `<div class="sub">${esc(String(x.body).slice(0, 200))}</div>` : ""}</div>${x.link ? `<a class="btn small" target="_blank" rel="noopener" href="${esc(x.link)}">Open</a>` : ""}${btn}</div>`;
        }),
      ].join("") || `<div class="notice"><div class="body"><strong>All quiet.</strong><div class="sub">Nothing needs you right now.</div></div></div>`;
      $("#ai-cards").innerHTML = connections.filter((c) => c.appUrl).map((c) => {
        const st = statusOf(c);
        const tasks = c.tasks.slice(0, 5).map((t) => `<div class="task"><span class="name" title="${esc(t.name)}">${esc(t.name)}</span>${t.last_run ? `<span class="badge ${runCls(t.last_run.status)}">${esc(runLabel(t.last_run.status))}</span>` : `<span class="sched">${esc(t.schedule || "")}</span>`}</div>`).join("");
        return `<article class="ai-card"><div class="head"><span class="dot ${st.dot}"></span><h3>${esc(c.name)}</h3><span class="muted small">${st.label}</span></div>
          ${c.hasScreenshot ? `<img class="shot" data-shot="${c.id}" src="/api/platforms/${c.id}/screenshot.png?t=${encodeURIComponent(c.lastSync || "")}" alt="${esc(c.name)} screen" loading="lazy" />` : ""}
          <div class="tasks">${tasks || `<span class="muted small">${c.status === "logged_in" ? (c.canSync ? "No scheduled tasks found yet." : "Ready for messages.") : "Sign in to see what it is doing."}</span>`}${c.tasks.length > 5 ? `<span class="muted small">+${c.tasks.length - 5} more</span>` : ""}</div>
          <div class="foot"><span>${c.lastSync ? `checked ${rel(c.lastSync)}` : ""}</span><span class="row">${c.status === "logged_in" ? `<button class="btn small ghost" data-refresh="${c.id}">Refresh</button><button class="btn small ghost" data-view-ai="${c.id}" data-close>Show</button>` : `<button class="btn small primary" data-connect="${c.id}">Sign in</button>`}</span></div></article>`;
      }).join("");
      $("#activity").innerHTML = activity.map((x) => `<div class="rowitem s-${runCls(x.status) || "run"}"><div class="body"><div class="title">${esc(x.title)} ${x.status && x.status !== "info" ? `<span class="badge ${runCls(x.status)}">${esc(runLabel(x.status))}</span>` : ""}</div><div class="sub">${esc(aiName(x.platform))}${x.summary ? " · " + esc(String(x.summary).slice(0, 160)) : ""} · ${rel(x.at)}</div></div>${x.link ? `<a class="btn small ghost" target="_blank" rel="noopener" href="${esc(x.link)}">Open</a>` : ""}</div>`).join("") || `<p class="empty">Nothing yet. Once your AIs run tasks or answer messages, it shows up here.</p>`;
      $("#activity-modal").hidden = false;
    } catch (err) { fail(err); }
  }
  $("#btn-activity").addEventListener("click", openActivityModal);

  /* ---------- add an AI ---------- */
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
      $("#router-note").textContent = settings.router.provider === "claude-code" ? "Claude decides which AI gets each message, using your Claude subscription (CLAUDE_CODE_OAUTH_TOKEN)."
        : settings.router.provider === "api" ? `Claude (${settings.router.model}) decides which AI gets each message, using your Anthropic API key.`
        : "Messages go to the AI you name, or to the only connected AI. To let Claude decide between several, set CLAUDE_CODE_OAUTH_TOKEN (from “claude setup-token”) or ANTHROPIC_API_KEY on the server.";
      $("#alerts-note").textContent = settings.alerts.telegram || settings.alerts.webhook ? `Failures and sign-outs are sent to ${[settings.alerts.telegram ? "Telegram" : "", settings.alerts.webhook ? "your webhook" : ""].filter(Boolean).join(" and ")}.` : "Not set up. Add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID, or ALERT_WEBHOOK_URL, on the server to get notified when something fails or an AI signs you out.";
      const st = settings.storage;
      $("#storage-note").textContent = st.persistedBy === "database" ? `Sign-ins, chats and settings are mirrored to your Postgres database${st.database.lastSaveAt ? ` (last saved ${rel(st.database.lastSaveAt)})` : ""}. No volume needed.`
        : st.persistedBy === "volume" ? `Sign-ins are saved on a persistent disk${st.backupAt ? ` and were backed up ${rel(st.backupAt)}` : ""}.`
        : st.persistedBy === "none" ? `Warning: nothing keeps ${st.dataDir} between deploys. Add a Postgres database (reference DATABASE_URL in this service) or attach a volume there. Download a copy of your sign-ins to be safe.`
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
      sel.innerHTML = connections.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
      sel.value = aiId || connections[0]?.id || "";
      if (sel.value) await fillAiForm(sel.value);
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
    if (!confirm("Restore this AI's built-in settings?")) return;
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
      toast(`Restored ${r.imported} cookies. Check each AI from its menu.`, "ok");
      await load(current ? current.id : null);
    } catch (err) { fail(err); } finally { e.target.value = ""; }
  });

  /* ---------- global clicks ---------- */
  document.addEventListener("click", async (e) => {
    for (const d of $$("details.menu[open]")) if (!d.contains(e.target)) d.removeAttribute("open");
    const t = e.target.closest("[data-send],[data-del],[data-connect],[data-view-ai],[data-check],[data-refresh],[data-remove],[data-read],[data-shot],[data-open-settings],[data-close],[data-approve],[data-cancel],[data-toggle],[data-conv],[data-rename],[data-delete-conv],[data-ai],[data-example]");
    if (!t) {
      const ov = e.target.closest("[data-close-on-click]");
      if (ov && e.target === ov) ov.hidden = true;
      return;
    }
    if (e.target.closest("details.menu") && !e.target.closest(".menu-list")) return; // the ⋯ summary itself
    const btn = t.tagName === "BUTTON" ? t : null;
    const d = t.dataset;
    try {
      if (d.close !== undefined) { t.closest(".overlay").hidden = true; }
      if (d.send) { await busy(btn, () => api(`/chat/${d.send}/send`, { method: "POST", body: { platform: d.platform } })); }
      else if (d.approve) { await busy(btn, () => api(`/chat/${d.approve}/approve`, { method: "POST", body: { decision: d.decision } })); }
      else if (d.cancel) { await busy(btn, () => api(`/chat/${d.cancel}/cancel`, { method: "POST", body: {} })); }
      else if (d.toggle) { const box = t.closest(".activity"); const open = !box.classList.contains("open"); box.classList.toggle("open", open); openActivity.set(Number(d.toggle), open); }
      else if (d.del) { await api(`/chat/${d.del}`, { method: "DELETE" }); }
      else if (d.conv) { if (!(current && current.id === Number(d.conv))) await openConversation(Number(d.conv)); else if (isNarrow()) setView("chat"); }
      else if (d.rename) { const c = conversations.find((x) => x.id === Number(d.rename)); const title = prompt("Rename this chat", c?.title || ""); if (title !== null) await api(`/conversations/${d.rename}`, { method: "PATCH", body: { title: title.trim() } }); }
      else if (d.deleteConv) { if (confirm("Delete this chat and its messages?")) await api(`/conversations/${d.deleteConv}`, { method: "DELETE" }); }
      else if (d.ai !== undefined) { const c = conn(d.ai); setTarget(target === d.ai ? "" : d.ai); if (c && browserState?.pages?.some((p) => p.platform === c.id)) { live.watch(c.id); renderTabs(); } }
      else if (d.connect) { if (t.closest(".overlay")) t.closest(".overlay").hidden = true; await startSignIn(d.connect); }
      else if (d.viewAi) { showBrowser(); if (browserState?.pages?.some((p) => p.platform === d.viewAi)) live.watch(d.viewAi); else { await api("/browser/open", { method: "POST", body: { platform: d.viewAi, url: conn(d.viewAi)?.appUrl } }); live.watch(d.viewAi); } renderTabs(); }
      else if (d.check) { await busy(btn, async () => { const r = await api(`/connections/${d.check}/check`, { method: "POST", body: {} }); toast(r.status === "logged_in" ? `${r.name} is connected.` : `${r.name} is signed out.`, r.status === "logged_in" ? "ok" : "bad"); }); }
      else if (d.refresh) { await busy(btn, async () => { const c = conn(d.refresh); if (c?.canSync) await api(`/platforms/${c.id}/sync`, { method: "POST" }); else await api(`/connections/${d.refresh}/check`, { method: "POST", body: {} }); }); await openActivityModal(); }
      else if (d.remove) { if (confirm(`Remove ${aiName(d.remove)} from the app?`)) { await api(`/connections/${d.remove}`, { method: "DELETE" }); await load(current ? current.id : null); } }
      else if (d.read) { await api(`/events/${d.read}/read`, { method: "POST", body: {} }); await openActivityModal(); }
      else if (d.shot) { $("#shot-img").src = `/api/platforms/${d.shot}/screenshot.png?t=${Date.now()}`; $("#shot-modal").hidden = false; }
      else if (d.openSettings) { if (t.closest(".overlay") && t.closest(".overlay").id !== "settings-modal") t.closest(".overlay").hidden = true; await openSettings(d.openSettings, d.aiId || null); }
      else if (d.example) { ta.value = d.example; autogrow(); ta.focus(); }
    } catch (err) { fail(err); }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { for (const o of $$(".overlay")) o.hidden = true; }
  });
  window.addEventListener("resize", () => { if (!isNarrow() && !app.dataset.view) setView("chat"); });

  /* ---------- boot ---------- */
  async function start() {
    await load();
    connectStream();
    live.connect();
    if (isNarrow()) setView(connections.some((c) => c.status === "logged_in") ? "chat" : "side");
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
