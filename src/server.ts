import { randomUUID } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import httpProxy from "http-proxy";
import { settleCommandMessage } from "./answers.js";
import { crossOrigin, isAdmin } from "./auth.js";
import { handleLiveUpgrade } from "./browser/live.js";
import { browser, storageInfo, vncState } from "./browser/manager.js";
import { config } from "./config.js";
import { withLogContext } from "./context.js";
import { dbReady } from "./db.js";
import { logger } from "./logger.js";
import { api } from "./routes/api.js";
import { saveToDatabase, stopPersistLoop } from "./persist.js";
import { initPlatforms } from "./platforms.js";
import { UnsupportedOperationError } from "./providers/types.js";
import { onRunEnded } from "./runs.js";
import { queue } from "./queue.js";
import { startExecutionServices } from "./services.js";
import { stopScheduler } from "./sync.js";

const log = logger("server");
const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, "..", "public");

onRunEnded(settleCommandMessage);

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);
app.use(express.json({ limit: "5mb" }));

// Security headers. The app pages get a content-security policy; the noVNC pages under /vnc keep their own.
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (!req.path.startsWith("/vnc")) {
    res.setHeader("X-Frame-Options", "DENY");
    if (req.path === "/" || req.path.endsWith(".html")) {
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      );
    }
  }
  next();
});

// Every request gets a correlation id, echoed back and stamped onto every log line it causes.
app.use((req, res, next) => {
  const fromHeader = req.headers["x-request-id"];
  const requestId = (typeof fromHeader === "string" && /^[\w.-]{1,64}$/.test(fromHeader) ? fromHeader : "") || randomUUID();
  (req as express.Request & { requestId?: string }).requestId = requestId;
  res.setHeader("X-Request-Id", requestId);
  withLogContext({ request_id: requestId }, () => next());
});

// Request log: every change and every failure at info or above, reads at debug. Streams and health checks stay quiet.
app.use((req, res, next) => {
  if (req.path === "/healthz" || req.path === "/readyz" || req.path === "/api/stream" || req.path.startsWith("/vnc") || (!req.path.startsWith("/api") && req.method === "GET")) return next();
  const t0 = Date.now();
  const requestId = (req as express.Request & { requestId?: string }).requestId;
  res.on("finish", () => {
    // The finish event fires outside the request's async context, so the id travels explicitly.
    const line = `${req.method} ${req.originalUrl.split("?")[0]} → ${res.statusCode} in ${Date.now() - t0}ms`;
    if (res.statusCode >= 500) log.error(line, { request_id: requestId });
    else if (res.statusCode >= 400) log.warn(line, { request_id: requestId });
    else if (req.method === "GET") log.debug(line, { request_id: requestId });
    else log.info(line, { request_id: requestId });
  });
  next();
});

// Liveness: is the process alive? Never checks dependencies, so a database blip cannot restart the fleet.
app.get("/healthz", (_req, res) => res.json({ ok: true, browser: browser.isRunning(), at: new Date().toISOString() }));
// Readiness: can this instance do useful work right now?
app.get("/readyz", async (_req, res) => {
  try {
    await dbReady();
    res.json({ ok: true });
  } catch (err) {
    res.status(503).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
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
app.use("/vnc", async (req, res) => {
  if (!await isAdmin(req)) {
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
  if (res.headersSent) return;
  // A provider that cannot do something answers with a structured 501, never a stack trace.
  if (err instanceof UnsupportedOperationError) return res.status(501).json(err.toJSON());
  const status = err && typeof err === "object" && typeof (err as { status?: unknown }).status === "number" ? (err as { status: number }).status : 500;
  const msg = err instanceof Error ? err.message : String(err);
  if (status >= 500) log.error(`${_req.method} ${_req.originalUrl.split("?")[0]} failed`, err);
  else log.warn(`${_req.method} ${_req.originalUrl.split("?")[0]} refused (${status}): ${msg}`);
  res.status(status).json({ error: msg });
});

const server = http.createServer(app);
server.on("upgrade", async (req, socket, head) => {
  const isLive = req.url === "/live" || req.url?.startsWith("/live?");
  if (!isLive && !req.url?.startsWith("/vnc/")) {
    socket.destroy();
    return;
  }
  // A socket that drives the signed-in browser must come from this app's own pages.
  if (crossOrigin(req)) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  if (!await isAdmin(req)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  if (isLive) {
    // The live browser view: Chromium screencast frames + input, see src/browser/live.ts.
    handleLiveUpgrade(req, socket, head);
    return;
  }
  req.url = req.url!.replace(/^\/vnc/, "") || "/";
  vncState.connections++;
  vncState.lastActivityAt = Date.now();
  socket.on("close", () => {
    vncState.connections = Math.max(0, vncState.connections - 1);
    vncState.lastActivityAt = Date.now();
  });
  proxy.ws(req, socket, head);
});

server.listen(config.port, async () => {
  log.info(`AI Control Plane listening on :${config.port} (data: ${config.dataDir})`);
  if (config.publicUrl) log.info(`public url: ${config.publicUrl} (from ${config.publicUrlSource === "env" ? "PUBLIC_URL" : "the host's own domain"})`);
  else log.warn("PUBLIC_URL is not set: alerts and agent report URLs will have no address, and pairing commands fall back to each request's Host header. Set PUBLIC_URL (or run where RAILWAY_PUBLIC_DOMAIN is provided) to pin it.");
  const st = await storageInfo();
  if (st.persistedBy === "none" && st.persistent === false) {
    log.warn(`DATA_DIR ${st.dataDir} is NOT on a mounted volume and no DATABASE_URL is set. Logins, chat history and settings will be lost on redeploy. Attach a volume at ${st.dataDir} or add a Postgres database.`);
  } else if (st.persistedBy === "volume") {
    log.info(`data dir is on volume ${st.mount}${st.backupAt ? `, session backup from ${st.backupAt}` : ""}`);
  } else if (st.persistedBy === "database") {
    log.info("state is mirrored to the Postgres database; no volume needed");
  } else if (st.persistedBy === "postgres") {
    log.info("Postgres is the database; the data folder only caches the browser profile and screenshots");
  }
  await initPlatforms();
  if (config.role === "all") {
    // Single-container mode: this process also executes everything it accepts.
    await startExecutionServices();
    await queue.start();
  } else {
    // ROLE=api: enqueue and serve only; workers execute. Connect the shared queue for sends.
    log.info(`role: ${config.role} — execution happens on worker processes`);
    await queue.start();
  }
});

async function shutdown(signal: string) {
  log.info(`${signal} received, shutting down`);
  stopScheduler();
  stopPersistLoop();
  server.close();
  // Stop claiming jobs, back up sessions and close Chromium cleanly, then push the final
  // state to Postgres — but never hang a redeploy: a few seconds each, then exit regardless.
  await Promise.race([queue.stop(), new Promise((r) => setTimeout(r, 8_000))]);
  await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 6_000))]);
  await Promise.race([saveToDatabase(true), new Promise((r) => setTimeout(r, 5_000))]);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (err) => log.error("unhandled rejection", err));
