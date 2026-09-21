import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import httpProxy from "http-proxy";
import { isAdmin } from "./auth.js";
import { browser, storageInfo, vncState } from "./browser/manager.js";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { api } from "./routes/api.js";
import { startEmailPoller } from "./ingest/email.js";
import { startScheduler, stopScheduler } from "./sync.js";

const log = logger("server");
const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, "..", "public");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);
app.use(express.json({ limit: "5mb" }));

app.get("/healthz", (_req, res) => res.json({ ok: true, browser: browser.isRunning(), at: new Date().toISOString() }));

// When PUBLIC_URL is not configured, learn it from the first browser request so
// webhook payloads and alerts can carry absolute links back to this deployment.
app.use((req, _res, next) => {
  if (!config.publicUrl && req.headers.host && !req.path.startsWith("/api/ingest") && !req.path.startsWith("/api/inbox")) {
    const proto = req.headers["x-forwarded-proto"] === "https" || req.secure ? "https" : "http";
    config.publicUrl = `${proto}://${req.headers.host}`;
    log.info(`public url detected: ${config.publicUrl}`);
  }
  next();
});

app.use("/api", api);

/* ---- noVNC: proxied through the app so it shares the single public port and the admin auth ---- */
const proxy = httpProxy.createProxyServer({ target: config.vnc.target, ws: true, changeOrigin: true });
proxy.on("error", (err, _req, res) => {
  log.warn("vnc proxy error", err.message);
  if (res && "writeHead" in res && !res.headersSent) {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end("The browser screen is not available. Is the service running with HEADLESS=false inside the Docker image?");
  }
});
app.use("/vnc", (req, res) => {
  if (!isAdmin(req)) {
    res.status(401).type("html").send(`<p>Unauthorized. Sign in on the <a href="/">dashboard</a> first.</p>`);
    return;
  }
  if (req.originalUrl === "/vnc") return res.redirect("/vnc/");
  if (req.path === "/" || req.path === "") {
    return res.redirect("/vnc/vnc.html?autoconnect=1&resize=remote&path=vnc/websockify&reconnect=1");
  }
  vncState.lastActivityAt = Date.now();
  proxy.web(req, res);
});

app.use(express.static(publicDir, { index: "index.html", extensions: ["html"] }));
app.use((_req, res) => res.status(404).json({ error: "not found" }));
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const msg = err instanceof Error ? err.message : String(err);
  log.error("request failed", err);
  if (!res.headersSent) res.status(500).json({ error: msg });
});

const server = http.createServer(app);
server.on("upgrade", (req, socket, head) => {
  if (!req.url?.startsWith("/vnc/")) {
    socket.destroy();
    return;
  }
  if (!isAdmin(req)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  req.url = req.url.replace(/^\/vnc/, "") || "/";
  vncState.connections++;
  vncState.lastActivityAt = Date.now();
  socket.on("close", () => {
    vncState.connections = Math.max(0, vncState.connections - 1);
    vncState.lastActivityAt = Date.now();
  });
  proxy.ws(req, socket, head);
});

server.listen(config.port, () => {
  log.info(`AI Control Plane listening on :${config.port} (data: ${config.dataDir})`);
  if (config.publicUrl) log.info(`public url: ${config.publicUrl}`);
  const st = storageInfo();
  if (st.persistent === false) {
    log.warn(`DATA_DIR ${st.dataDir} is NOT on a mounted volume. Logins, the database and screenshots will be lost on redeploy. Attach a volume at ${st.dataDir}.`);
  } else if (st.persistent === true) {
    log.info(`data dir is on volume ${st.mount}${st.backupAt ? `, session backup from ${st.backupAt}` : ""}`);
  }
  startScheduler();
  startEmailPoller();
  if (browser.enabled) {
    // Warm the browser so the VNC screen shows something immediately.
    browser.getContext().catch((err) => log.error("browser failed to launch", err));
  }
});

async function shutdown(signal: string) {
  log.info(`${signal} received, shutting down`);
  stopScheduler();
  server.close();
  // Back up sessions and close Chromium cleanly so the profile on the volume is flushed,
  // but never hang a redeploy: give it a few seconds, then exit regardless.
  await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 8_000))]);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (err) => log.error("unhandled rejection", err));
