import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import httpProxy from "http-proxy";
import { backfillAgents } from "./agents.js";
import { settleCommandMessage } from "./answers.js";
import { crossOrigin, isAdmin } from "./auth.js";
import { handleLiveUpgrade } from "./browser/live.js";
import { browser, storageInfo, vncState } from "./browser/manager.js";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { api } from "./routes/api.js";
import { startEmailPoller } from "./ingest/email.js";
import { persistEnabled, saveToDatabase, startPersistLoop, stopPersistLoop } from "./persist.js";
import { recoverInterruptedApprovals } from "./policy.js";
import { UnsupportedOperationError } from "./providers/types.js";
import { onRunEnded, recoverInterruptedRuns } from "./runs.js";
import { startScheduler, stopScheduler } from "./sync.js";

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
  if (res.headersSent) return;
  // A provider that cannot do something answers with a structured 501, never a stack trace.
  if (err instanceof UnsupportedOperationError) return res.status(501).json(err.toJSON());
  const status = err && typeof err === "object" && typeof (err as { status?: unknown }).status === "number" ? (err as { status: number }).status : 500;
  const msg = err instanceof Error ? err.message : String(err);
  if (status >= 500) log.error("request failed", err);
  res.status(status).json({ error: msg });
});

const server = http.createServer(app);
server.on("upgrade", (req, socket, head) => {
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
  if (!isAdmin(req)) {
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

server.listen(config.port, () => {
  log.info(`AI Control Plane listening on :${config.port} (data: ${config.dataDir})`);
  if (config.publicUrl) log.info(`public url: ${config.publicUrl}`);
  const st = storageInfo();
  if (st.persistedBy === "none" && st.persistent === false) {
    log.warn(`DATA_DIR ${st.dataDir} is NOT on a mounted volume and no DATABASE_URL is set. Logins, chat history and settings will be lost on redeploy. Attach a volume at ${st.dataDir} or add a Postgres database.`);
  } else if (st.persistedBy === "volume") {
    log.info(`data dir is on volume ${st.mount}${st.backupAt ? `, session backup from ${st.backupAt}` : ""}`);
  } else if (st.persistedBy === "database") {
    log.info("state is mirrored to the Postgres database; no volume needed");
  }
  if (persistEnabled) startPersistLoop();
  try {
    backfillAgents();
    // Work that was in flight when the last process stopped is surfaced, never left hanging.
    const approvals = recoverInterruptedApprovals();
    const runs = recoverInterruptedRuns();
    if (approvals || runs) log.warn(`recovered after restart: ${approvals} pending approval(s), ${runs} running run(s) marked interrupted`);
  } catch (err) {
    log.error("startup recovery failed", err);
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
  stopPersistLoop();
  server.close();
  // Back up sessions and close Chromium cleanly, then push the final state to Postgres,
  // but never hang a redeploy: a few seconds each, then exit regardless.
  await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 6_000))]);
  await Promise.race([saveToDatabase(true), new Promise((r) => setTimeout(r, 5_000))]);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (err) => log.error("unhandled rejection", err));
