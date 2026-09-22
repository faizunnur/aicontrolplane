/* Live browser view: Chromium screencast frames over a WebSocket, your input forwarded back.
   Protocol: see src/browser/live.ts. Binary messages are JPEG frames; text messages are JSON. */
class LiveView {
  constructor(opts) {
    this.canvas = opts.canvas;
    this.viewport = opts.viewport;
    this.onState = opts.onState || (() => {});
    this.onMeta = opts.onMeta || (() => {});
    this.onStatus = opts.onStatus || (() => {});
    this.onError = opts.onError || (() => {});
    this.ws = null;
    this.meta = null; // { platform, url, title, width, height }
    this.state = null; // browser snapshot from the server
    this.follow = true;
    this.platform = null;
    this.override = false;
    this.level = "medium";
    this.connected = false;
    this.stopped = false;
    this.retry = 0;
    this.frames = 0;
    this.fps = 0;
    this.seq = 0;
    this.drawn = 0;
    this.pending = null;
    this.raf = 0;
    this.lastFrameAt = 0;
    this.ctx = this.canvas.getContext("2d", { alpha: false, desynchronized: true });
    this.viewport.style.touchAction = "none";
    this.bindInput();
    setInterval(() => {
      this.fps = this.frames;
      this.frames = 0;
      this.onStatus(this.status());
    }, 1000);
  }

  /** Can the user act on the page right now? */
  get interactive() {
    return this.connected && !!(this.meta && this.meta.platform) && (!(this.state && this.state.busy) || this.override);
  }

  status() {
    if (this.state && this.state.enabled === false) return { kind: "off", text: "The browser is off on this deployment" };
    if (!this.connected) return { kind: "down", text: this.retry ? "Reconnecting…" : "Connecting…" };
    if (!this.meta || !this.meta.platform) return { kind: "idle", text: "Live · nothing open" };
    const who = this.meta.title || this.meta.platform;
    const busy = this.state && this.state.busy;
    const idle = performance.now() - this.lastFrameAt > 3000;
    return { kind: busy ? "busy" : "live", text: `Live · ${who}${busy ? ` · ${busy.label}` : idle ? " · still" : ""}`, fps: this.fps };
  }

  connect() {
    this.stopped = false;
    if (this.ws) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/live`);
    ws.binaryType = "blob";
    this.ws = ws;
    ws.addEventListener("open", () => {
      this.connected = true;
      this.retry = 0;
      this.viewport.classList.toggle("interactive", this.interactive);
      // Re-state what we want after every (re)connect.
      if (this.follow) this.send({ t: "follow" });
      else if (this.platform) this.send({ t: "watch", platform: this.platform });
      if (this.level !== "medium") this.send({ t: "quality", level: this.level });
      if (this.override) this.send({ t: "override", on: true });
      this.onStatus(this.status());
    });
    ws.addEventListener("message", (e) => {
      if (e.data instanceof Blob) return void this.frame(e.data);
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.t === "state") {
        this.state = msg.browser;
        this.viewport.classList.toggle("interactive", this.interactive);
        this.onState(this.state);
      } else if (msg.t === "meta") {
        const was = this.meta && this.meta.platform;
        this.meta = msg;
        if (!msg.platform) this.viewport.classList.add("empty");
        else if (was !== msg.platform) this.viewport.classList.add("empty"); // until the first frame of the new tab lands
        this.viewport.classList.toggle("interactive", this.interactive);
        this.onMeta(this.meta);
      } else if (msg.t === "error") this.onError(msg.message);
    });
    const closed = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.connected = false;
      this.viewport.classList.remove("interactive");
      this.onStatus(this.status());
      if (this.stopped) return;
      this.retry++;
      setTimeout(() => this.connect(), Math.min(10_000, 500 * 2 ** Math.min(this.retry, 5)));
    };
    ws.addEventListener("close", closed);
    ws.addEventListener("error", closed);
  }

  disconnect() {
    this.stopped = true;
    if (this.ws) this.ws.close();
  }

  send(obj) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  /* ---------- what to show ---------- */
  watch(platform) {
    this.follow = false;
    this.platform = platform;
    this.send({ t: "watch", platform });
  }
  followAgent() {
    this.follow = true;
    this.platform = null;
    this.send({ t: "follow" });
  }
  setQuality(level) {
    this.level = level;
    this.send({ t: "quality", level });
  }
  setOverride(on) {
    this.override = on;
    this.send({ t: "override", on });
    this.viewport.classList.toggle("interactive", this.interactive);
  }
  nav(url) {
    this.send({ t: "nav", url });
  }
  back() {
    this.send({ t: "back" });
  }
  forward() {
    this.send({ t: "forward" });
  }
  reload() {
    this.send({ t: "reload" });
  }

  /* ---------- frames ---------- */
  async frame(blob) {
    const seq = ++this.seq;
    this.frames++;
    this.lastFrameAt = performance.now();
    let bmp;
    try {
      bmp = await createImageBitmap(blob);
    } catch {
      return;
    }
    if (seq < this.drawn) return void bmp.close(); // a newer frame already went up
    if (this.pending) this.pending.bmp.close();
    this.pending = { bmp, seq };
    if (!this.raf) this.raf = requestAnimationFrame(() => this.draw());
  }
  draw() {
    this.raf = 0;
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    const { bmp, seq } = p;
    if (this.canvas.width !== bmp.width || this.canvas.height !== bmp.height) {
      this.canvas.width = bmp.width;
      this.canvas.height = bmp.height;
    }
    this.ctx.drawImage(bmp, 0, 0);
    bmp.close();
    this.drawn = seq;
    this.viewport.classList.remove("empty");
  }

  /* ---------- input ---------- */
  bindInput() {
    const v = this.viewport;
    const pos = (e) => {
      const r = this.canvas.getBoundingClientRect();
      return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
    };
    const inside = (p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;
    let queuedMove = null;
    let moveRaf = 0;
    const flushMove = () => {
      moveRaf = 0;
      if (queuedMove) this.send({ t: "mouse", kind: "move", ...queuedMove });
      queuedMove = null;
    };

    v.addEventListener("pointerdown", (e) => {
      v.focus({ preventScroll: true });
      if (!this.interactive) return;
      const p = pos(e);
      if (!inside(p)) return;
      e.preventDefault();
      try {
        v.setPointerCapture(e.pointerId);
      } catch {
        /* not needed */
      }
      queuedMove = null;
      this.send({ t: "mouse", kind: "down", ...p, button: e.button });
    });
    v.addEventListener("pointermove", (e) => {
      if (!this.interactive) return;
      queuedMove = pos(e);
      if (!moveRaf) moveRaf = requestAnimationFrame(flushMove);
    });
    v.addEventListener("pointerup", (e) => {
      if (!this.interactive) return;
      queuedMove = null;
      this.send({ t: "mouse", kind: "up", ...pos(e), button: e.button });
    });
    v.addEventListener("contextmenu", (e) => e.preventDefault());
    v.addEventListener(
      "wheel",
      (e) => {
        if (!this.interactive) return;
        e.preventDefault();
        const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
        this.send({ t: "wheel", ...pos(e), dx: e.deltaX * k, dy: e.deltaY * k });
      },
      { passive: false },
    );
    const isPaste = (e) => (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v";
    v.addEventListener("keydown", (e) => {
      if (!this.interactive) return;
      if (isPaste(e)) return; // the paste event carries the text
      if (e.key === "F11" || e.key === "F12") return;
      e.preventDefault();
      this.send({ t: "key", kind: "down", key: e.key });
    });
    v.addEventListener("keyup", (e) => {
      if (!this.interactive) return;
      if (isPaste(e)) return;
      e.preventDefault();
      this.send({ t: "key", kind: "up", key: e.key });
    });
    v.addEventListener("paste", (e) => {
      if (!this.interactive) return;
      const text = e.clipboardData && e.clipboardData.getData("text/plain");
      if (!text) return;
      e.preventDefault();
      this.send({ t: "text", text });
    });
    v.addEventListener("blur", () => {
      for (const key of ["Shift", "Control", "Alt", "Meta"]) this.send({ t: "key", kind: "up", key });
    });
  }
}
window.LiveView = LiveView;
