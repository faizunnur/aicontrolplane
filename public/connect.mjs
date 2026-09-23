#!/usr/bin/env node
/*
  AI Control Plane — sign in on THIS computer and hand that one session to your deployment.

      node acp-connect.mjs https://your-app.up.railway.app ABCD-EFGH

  Get the code from the app: open a provider's menu and choose "Connect from this computer".
  Some sign-in pages refuse any browser running in a datacenter, automated or not. This signs you
  in on your own machine instead, and sends only the resulting session for that one provider.

  You need nothing but Node 22 or newer and a Chrome-family browser (Chrome, Edge, Brave, Chromium).
  No project folder, no npm install: this is one plain file, downloaded from your own deployment.
  Read it before you run it if you like.

  What happens:
    1. the code is traded for a token that can do exactly one thing: import that provider's session
    2. your browser opens as a plain window, with nothing attached to it, on the sign-in page
    3. you sign in the way you always do; it waits until the site shows you signed in
    4. only that provider's cookies and localStorage are read and sent to your deployment over HTTPS

  Nothing is written to disk here except the browser profile under ~/.aicontrolplane, which you can
  delete at any time. Your other browsers, profiles and sessions are never touched.
*/
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const VERSION = "1";
const POLL_MS = 2_000;
const SETTLE_POLLS = 3; // consecutive polls on a signed-in page before the session is read
const IMPORT_RETRY_MS = 5_000;
const IMPORT_RETRY_FOR_MS = 2 * 60_000;

const say = (s) => console.log(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

/* ---------- what this needs ---------- */

if (Number(process.versions.node.split(".")[0]) < 22 || typeof WebSocket !== "function") {
  die(`This needs Node 22 or newer; you are running Node ${process.versions.node}.\nGet it from https://nodejs.org and run the command again.`, 2);
}

const [rawBase, rawCode] = process.argv.slice(2);
if (!rawBase || !rawCode) die("usage: node acp-connect.mjs <control-plane-url> <code>\n\nGet the code from the app: a provider's menu › Connect from this computer.", 2);

let base;
try {
  base = new URL(rawBase);
} catch {
  die(`That does not look like a URL: ${rawBase}`, 2);
}
const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(base.hostname.toLowerCase());
if (base.protocol !== "https:" && !loopback) die(`Refusing to send a sign-in over plain HTTP to ${base.host}. Use the https:// address of your control plane.`, 2);
const origin = base.origin;

/* ---------- the browser on this machine ---------- */

/** Real browsers first: a bot check is likelier to accept the browser you use every day. */
function browserCandidates() {
  const env = process.env.BROWSER_EXECUTABLE;
  if (env) return [{ path: env, name: "the browser you named in BROWSER_EXECUTABLE" }];
  if (process.platform === "win32") {
    const pf = process.env["PROGRAMFILES"] ?? "C:\\Program Files";
    const pf86 = process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)";
    const local = process.env.LOCALAPPDATA ?? "";
    const win = (root, ...rest) => (root ? { path: path.join(root, ...rest), name: rest[rest.length - 1] } : null);
    return [
      win(pf, "Google", "Chrome", "Application", "chrome.exe"),
      win(pf86, "Google", "Chrome", "Application", "chrome.exe"),
      win(local, "Google", "Chrome", "Application", "chrome.exe"),
      win(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
      win(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
      win(pf, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
      win(local, "Chromium", "Application", "chrome.exe"),
    ].filter(Boolean);
  }
  if (process.platform === "darwin") {
    const home = process.env.HOME ?? "";
    return [
      { path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", name: "Google Chrome" },
      { path: path.join(home, "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"), name: "Google Chrome" },
      { path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", name: "Microsoft Edge" },
      { path: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", name: "Brave" },
      { path: "/Applications/Chromium.app/Contents/MacOS/Chromium", name: "Chromium" },
    ];
  }
  return [
    { path: "/opt/google/chrome/chrome", name: "Google Chrome" },
    { path: "/usr/bin/google-chrome-stable", name: "Google Chrome" },
    { path: "/usr/bin/google-chrome", name: "Google Chrome" },
    { path: "/usr/bin/microsoft-edge", name: "Microsoft Edge" },
    { path: "/usr/bin/brave-browser", name: "Brave" },
    { path: "/usr/bin/chromium", name: "Chromium" },
    { path: "/usr/bin/chromium-browser", name: "Chromium" },
  ];
}

function findBrowser() {
  const found = browserCandidates().find((c) => {
    try {
      return fs.existsSync(c.path);
    } catch {
      return false;
    }
  });
  if (found) return found;
  return die("No Chrome-family browser was found on this computer.\nInstall Google Chrome (https://www.google.com/chrome/) and run the command again,\nor set BROWSER_EXECUTABLE to the browser you want to use.");
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

async function devtools(port, p) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(2_000) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/** A minimal DevTools protocol client over the WebSocket that Node has built in. */
function cdp(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    let seq = 0;
    ws.addEventListener("open", () =>
      resolve({
        send(method, params = {}) {
          const id = ++seq;
          return new Promise((res, rej) => {
            pending.set(id, { res, rej });
            ws.send(JSON.stringify({ id, method, params }));
            const t = setTimeout(() => {
              if (pending.delete(id)) rej(new Error(`${method} did not answer in time`));
            }, 20_000);
            t.unref?.();
          });
        },
        close() {
          try {
            ws.close();
          } catch {
            /* already closed */
          }
        },
      }),
    );
    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      const waiting = msg.id && pending.get(msg.id);
      if (!waiting) return;
      pending.delete(msg.id);
      if (msg.error) waiting.rej(new Error(msg.error.message || "the browser refused that request"));
      else waiting.res(msg.result);
    });
    ws.addEventListener("error", () => reject(new Error("could not talk to the browser window")));
    ws.addEventListener("close", () => {
      for (const [, w] of pending) w.rej(new Error("the browser window closed"));
      pending.clear();
    });
  });
}

/** Same rule the control plane applies: ".x.ai" and "accounts.x.ai" belong to "x.ai", "notx.ai" does not. */
function belongs(host, domains) {
  const h = String(host ?? "")
    .toLowerCase()
    .replace(/^\./, "");
  return !!h && domains.some((d) => h === d || h.endsWith("." + d));
}

/* ---------- 1. the code becomes a token ---------- */

let res;
try {
  res = await fetch(`${origin}/api/pairing/exchange`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: rawCode }), signal: AbortSignal.timeout(20_000) });
} catch (err) {
  die(`Could not reach ${origin}: ${err instanceof Error ? err.message : String(err)}`);
}
const ex = await res.json().catch(() => ({}));
if (res.status === 404) die(ex.error || "That code is not valid or has expired. Make a new one in the app.");
if (res.status === 429) die("Too many attempts from this address. Wait ten minutes and make a new code.");
if (!res.ok || !ex.token || !ex.platform) die(`The control plane refused the code (${res.status}): ${ex.error || "unknown error"}`);

const p = ex.platform;
const domains = p.domains?.length ? p.domains : [new URL(p.appUrl).hostname];
const loginPatterns = (p.loginUrlPatterns ?? []).map((s) => {
  try {
    return new RegExp(s, "i");
  } catch {
    return null;
  }
}).filter(Boolean);
say(`Paired with ${origin} for ${p.name}. The token is good until ${new Date(ex.expiresAt).toLocaleTimeString()}.`);

/* ---------- 2. a plain browser window on the sign-in page ---------- */

const exe = findBrowser();
const profileDir = path.join(os.homedir(), ".aicontrolplane", "connect-profile", p.id);
fs.mkdirSync(profileDir, { recursive: true });
// A window killed last time can leave these behind, and they block the next launch.
for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie", "lockfile"]) {
  try {
    fs.rmSync(path.join(profileDir, f), { force: true });
  } catch {
    /* not there */
  }
}
const port = await freePort();
const args = [
  `--user-data-dir=${profileDir}`,
  `--remote-debugging-port=${port}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--window-size=1200,860",
  ...(process.platform === "linux" ? ["--password-store=basic"] : []),
  "--new-window",
  p.appUrl,
];
const child = spawn(exe.path, args, { stdio: "ignore" });
let exited = false;
child.on("exit", () => (exited = true));
child.on("error", (err) => die(`Could not start ${exe.name}: ${err.message}`));

function stopBrowser() {
  if (exited) return;
  if (process.platform === "win32" && child.pid) spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" });
  else child.kill("SIGTERM");
}

let version = null;
for (let i = 0; i < 60 && !version && !exited; i++) {
  await sleep(300);
  version = await devtools(port, "/json/version");
}
if (!version) {
  stopBrowser();
  die(exited ? "The browser closed at once. An earlier connect window is probably still open with this profile; close it and run the command again." : "The browser started but did not answer. Close any connect window that is open and run the command again.");
}
say(`\nOpened ${version.Browser ?? exe.name}. Sign in to ${p.name} in that window, exactly as you always do.`);
say("This waits until it sees you signed in. Press Enter here to hand the session over sooner, or Ctrl+C to give up.\n");

let manual = false;
let keys = null;
if (process.stdin.isTTY) {
  keys = readline.createInterface({ input: process.stdin, output: process.stdout });
  keys.on("line", () => (manual = true));
}

/* ---------- 3. wait for the sign-in, then read that one session ---------- */

async function readSession() {
  const browserWs = version.webSocketDebuggerUrl;
  if (!browserWs) throw new Error("this browser did not offer a debugging endpoint");
  const client = await cdp(browserWs);
  try {
    const all = await client.send("Storage.getCookies");
    const cookies = (all.cookies ?? [])
      .filter((c) => belongs(c.domain, domains))
      .map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || "/",
        expires: typeof c.expires === "number" && c.expires > 0 ? Math.round(c.expires) : -1,
        httpOnly: !!c.httpOnly,
        secure: !!c.secure,
        sameSite: c.sameSite === "Strict" || c.sameSite === "None" ? c.sameSite : "Lax",
      }));
    const present = !p.sessionCookie || cookies.some((c) => c.name === p.sessionCookie || c.name.startsWith(p.sessionCookie + "."));
    return { cookies, present };
  } finally {
    client.close();
  }
}

/** localStorage for the provider's own pages, read from the tabs that are open. Best effort. */
async function readOrigins() {
  const targets = (await devtools(port, "/json/list")) ?? [];
  const origins = [];
  for (const t of targets) {
    if (t.type !== "page" || !t.webSocketDebuggerUrl) continue;
    let u;
    try {
      u = new URL(t.url);
    } catch {
      continue;
    }
    if (!belongs(u.hostname, domains) || origins.some((o) => o.origin === u.origin)) continue;
    try {
      const client = await cdp(t.webSocketDebuggerUrl);
      try {
        const r = await client.send("Runtime.evaluate", { expression: "JSON.stringify(Object.entries(localStorage))", returnByValue: true });
        const entries = JSON.parse(r?.result?.value ?? "[]").map(([name, value]) => ({ name: String(name), value: String(value) }));
        if (entries.length) origins.push({ origin: u.origin, localStorage: entries });
      } finally {
        client.close();
      }
    } catch {
      /* a tab that will not talk is not worth failing over */
    }
  }
  return origins;
}

const deadline = new Date(ex.expiresAt).getTime() - 30_000;
let settled = 0;
let session = null;
while (!session) {
  if (exited) {
    keys?.close();
    die(`The browser window closed before you were signed in to ${p.name}. Run the command again when you are ready.`);
  }
  if (Date.now() > deadline) {
    stopBrowser();
    keys?.close();
    die("The token expired before the sign-in finished. Make a new code in the app and run the command again.");
  }
  // Nothing is attached to the browser while you sign in: this only reads the list of open tabs.
  const targets = (await devtools(port, "/json/list")) ?? [];
  const onSite = targets.some((t) => {
    if (t.type !== "page") return false;
    try {
      return belongs(new URL(t.url).hostname, domains) && !loginPatterns.some((r) => r.test(t.url));
    } catch {
      return false;
    }
  });
  settled = onSite ? settled + 1 : 0;
  if (manual || settled >= SETTLE_POLLS) {
    const s = await readSession().catch((err) => {
      say(`Could not read the session yet (${err.message}); trying again.`);
      return null;
    });
    if (s && (s.present || manual)) {
      if (!s.present) say(`The session cookie "${p.sessionCookie}" is not there yet; sending what there is because you pressed Enter. The control plane decides.`);
      session = { cookies: s.cookies, origins: await readOrigins() };
    } else if (s) {
      say(`On ${p.name}'s pages, but the session cookie "${p.sessionCookie}" has not appeared yet; still waiting.`);
      settled = 0;
    }
  }
  if (!session) await sleep(POLL_MS);
}
keys?.close();

/* ---------- 4. hand it over ---------- */

if (!session.cookies.length) {
  stopBrowser();
  die(`No cookies for ${domains.join(", ")} were found in that window. Sign in there first, then run the command again.`);
}
say(`\nSigned in. Handing ${session.cookies.length} cookies and ${session.origins.length} origin(s) for ${domains.join(", ")} to the control plane…`);

const started = Date.now();
let result = null;
while (!result) {
  let r;
  try {
    r = await fetch(`${origin}${ex.importPath}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ex.token}` },
      body: JSON.stringify({ cookies: session.cookies, origins: session.origins, helper: { version: VERSION, os: `${os.platform()} ${os.release()}` } }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    if (Date.now() - started > IMPORT_RETRY_FOR_MS) {
      stopBrowser();
      die("Gave up reaching the control plane. Make a new code and run the command again.");
    }
    say(`Could not reach ${origin} (${err instanceof Error ? err.message : String(err)}); trying again in ${IMPORT_RETRY_MS / 1000}s.`);
    await sleep(IMPORT_RETRY_MS);
    continue;
  }
  const body = await r.json().catch(() => ({}));
  // 409 means the cloud browser is held by something else; the token survives, so wait and retry.
  if (r.status === 409 && Date.now() - started < IMPORT_RETRY_FOR_MS) {
    say(`The cloud browser is busy (${body.error ?? "try again"}); trying again in ${IMPORT_RETRY_MS / 1000}s.`);
    await sleep(IMPORT_RETRY_MS);
    continue;
  }
  if (!r.ok) {
    stopBrowser();
    die(`The control plane refused the session (${r.status}): ${body.error ?? "unknown error"}`);
  }
  result = body;
}

// Ask the window to close itself so the profile is written out cleanly; force it only if it will not.
try {
  const client = await cdp(version.webSocketDebuggerUrl);
  await client.send("Browser.close").catch(() => undefined);
  client.close();
} catch {
  /* it may already be gone */
}
await sleep(800);
stopBrowser();

if (result.ok) {
  say(`\nImported ${result.imported?.cookies ?? session.cookies.length} cookies. ${result.name ?? p.name} is connected. You can close this window.`);
  process.exit(0);
}
die(`\nThe session was imported, but ${result.name ?? p.name} still looks signed out on the control plane (status: ${result.status ?? "unknown"}).\nMake sure you could see your chats in the browser window, then make a new code and try again.`);
