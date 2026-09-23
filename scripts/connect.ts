/**
 * Sign in to a provider on THIS computer and hand the session to your cloud control plane.
 *
 *   npm run connect -- https://your-app.up.railway.app ABCD-EFGH
 *
 * Get the code from the app: open a provider's menu and choose "Connect from this computer".
 * What happens here:
 *   1. the code is traded for a token that can do one thing: import this one provider's session
 *   2. your real Google Chrome opens as a plain window (no automation attached) on the sign-in page
 *   3. you sign in as you always do; when the site shows you signed in, the session is read out
 *   4. only that provider's cookies (and its localStorage) are sent to the control plane, over HTTPS
 * Nothing is written to disk here except Chrome's own profile under ~/.aicontrolplane, which you can delete.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { chromeInstallCandidates } from "../src/browser/executable.js";
import { cookieMatchesDomain, selectProviderState, type StoredOrigin } from "../src/providers/browser/domains.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const VERSION = (() => {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8")).version ?? "dev");
  } catch {
    return "dev";
  }
})();
const IMPORT_RETRY_MS = 5_000;
const IMPORT_RETRY_FOR_MS = 2 * 60_000;
const POLL_MS = 2_000;

const say = (s: string) => console.log(s);
function die(s: string, code = 1): never {
  console.error(s);
  process.exit(code);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ---------- arguments ---------- */

const [rawBase, rawCode] = process.argv.slice(2);
if (!rawBase || !rawCode) die("usage: npm run connect -- <control-plane-url> <code>\n\nGet the code from the app: a provider's menu › Connect from this computer.", 2);
function parseBase(s: string): URL {
  try {
    return new URL(s);
  } catch {
    return die(`That does not look like a URL: ${s}`, 2);
  }
}
const base = parseBase(rawBase);
const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(base.hostname.toLowerCase());
if (base.protocol !== "https:" && !loopback) die(`Refusing to send a sign-in over plain HTTP to ${base.host}. Use the https:// address of your deployment.`, 2);
const origin = base.origin;

/* ---------- 1. the code becomes a token ---------- */

interface Exchange {
  token: string;
  expiresAt: string;
  platform: { id: string; name: string; appUrl: string; sessionCookie: string; domains: string[]; loginUrlPatterns: string[] };
  importPath: string;
}
async function exchange(): Promise<Exchange> {
  let res: Response;
  try {
    res = await fetch(`${origin}/api/pairing/exchange`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: rawCode }), signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    return die(`Could not reach ${origin}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const body = (await res.json().catch(() => ({}))) as Partial<Exchange> & { error?: string };
  if (res.status === 404) return die(body.error || "That code is not valid or has expired. Make a new one in the app.");
  if (res.status === 429) return die("Too many attempts from this address. Wait ten minutes and make a new code.");
  if (!res.ok || !body.token || !body.platform) return die(`The control plane refused the code (${res.status}): ${body.error || "unknown error"}`);
  return body as Exchange;
}

/* ---------- 2. a plain Chrome window on the sign-in page ---------- */

function findBrowser(): { path: string; chrome: boolean } {
  const env = process.env.BROWSER_EXECUTABLE;
  if (env && fs.existsSync(env)) return { path: env, chrome: /chrome/i.test(env) };
  const found = chromeInstallCandidates().find((c) => c && fs.existsSync(c));
  if (found) return { path: found, chrome: true };
  try {
    const bundled = chromium.executablePath();
    if (bundled && fs.existsSync(bundled)) return { path: bundled, chrome: false };
  } catch {
    /* no bundled browser */
  }
  return die("No browser found. Install Google Chrome, or run: npx playwright install chromium");
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

async function devtools<T>(port: number, p: string): Promise<T | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(1_500) });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

function stopChrome(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32" && child.pid) spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" });
  else child.kill("SIGTERM");
}

/* ---------- main ---------- */

const ex = await exchange();
const p = ex.platform;
const domains = p.domains.length ? p.domains : [new URL(p.appUrl).hostname];
const loginPatterns = p.loginUrlPatterns.map((s) => new RegExp(s, "i"));
say(`Paired with ${origin} for ${p.name}. The token is good until ${new Date(ex.expiresAt).toLocaleTimeString()}.`);

const exe = findBrowser();
if (!exe.chrome) say("Note: Google Chrome was not found; using the bundled Chromium. If the site refuses it, install Chrome and run this again.");
const profileDir = path.join(os.homedir(), ".aicontrolplane", "connect-profile", p.id);
fs.mkdirSync(profileDir, { recursive: true });
for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie", "lockfile"]) fs.rmSync(path.join(profileDir, f), { force: true });
const port = await freePort();
const child = spawn(exe.path, [`--user-data-dir=${profileDir}`, `--remote-debugging-port=${port}`, "--no-first-run", "--no-default-browser-check", "--window-size=1200,860", "--new-window", p.appUrl], { stdio: "ignore" });
let exited = false;
child.on("exit", () => (exited = true));

let version: { Browser?: string } | null = null;
for (let i = 0; i < 60 && !version; i++) {
  if (exited) break;
  await sleep(300);
  version = await devtools<{ Browser?: string }>(port, "/json/version");
}
if (!version) {
  stopChrome(child);
  die(exited ? "Chrome closed at once. An earlier Connect window is probably still open with this profile; close it and run this again." : "Chrome started but did not answer. Close any Connect window that is open and run this again.");
}
say(`\nOpened ${version?.Browser ?? "the browser"}. Sign in to ${p.name} in that window, exactly as you always do.`);
say("This waits until it sees you signed in. Press Enter here to hand the session over sooner, or Ctrl+C to give up.\n");

let manual = false;
let rl: readline.Interface | null = null;
if (process.stdin.isTTY) {
  rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on("line", () => (manual = true));
}

/* ---------- 3. wait for the sign-in, then read the session ---------- */

interface Target {
  type: string;
  url: string;
}
// Held in an object: it is assigned inside a closure, which plain `let` narrowing cannot follow.
const attached: { cdp: Browser | null } = { cdp: null };
let signedInPolls = 0;
const deadline = new Date(ex.expiresAt).getTime() - 30_000;
let state: { cookies: unknown[]; origins: StoredOrigin[] } | null = null;

const onSessionPage = async () => {
  const targets = (await devtools<Target[]>(port, "/json/list")) ?? [];
  return targets.some((t) => {
    if (t.type !== "page") return false;
    let host = "";
    try {
      host = new URL(t.url).hostname;
    } catch {
      return false;
    }
    return cookieMatchesDomain(host, domains) && !loginPatterns.some((r) => r.test(t.url));
  });
};

const readSession = async () => {
  if (!attached.cdp) attached.cdp = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const ctx = attached.cdp.contexts()[0];
  if (!ctx) return null;
  const cookies = await ctx.cookies();
  const mine = cookies.filter((c) => cookieMatchesDomain(c.domain, domains));
  const sessionPresent = !p.sessionCookie || mine.some((c) => c.name === p.sessionCookie || c.name.startsWith(p.sessionCookie + "."));
  return { cookies: mine, sessionPresent };
};

while (!state) {
  if (exited) {
    rl?.close();
    die(`The Chrome window closed before you were signed in to ${p.name}. Run this again when you are ready.`);
  }
  if (Date.now() > deadline) {
    stopChrome(child);
    rl?.close();
    die("The token expired before the sign-in finished. Make a new code in the app and run this again.");
  }
  const candidate = manual || (await onSessionPage());
  if (candidate) signedInPolls++;
  else signedInPolls = 0;
  if (manual || signedInPolls >= 3) {
    // Only now does anything attach to the browser: the sign-in itself ran in a plain window.
    const s = await readSession().catch((err) => {
      say(`Could not read the session yet (${err instanceof Error ? err.message : String(err)}); trying again.`);
      return null;
    });
    if (s && (s.sessionPresent || manual)) {
      const ctx = attached.cdp!.contexts()[0];
      const origins: StoredOrigin[] = [];
      for (const page of ctx.pages()) {
        let host = "";
        try {
          host = new URL(page.url()).hostname;
        } catch {
          continue;
        }
        if (!cookieMatchesDomain(host, domains)) continue;
        const entries = await page.evaluate(() => Object.keys(localStorage).map((name) => ({ name, value: String(localStorage.getItem(name) ?? "") }))).catch(() => []);
        if (entries.length) origins.push({ origin: new URL(page.url()).origin, localStorage: entries });
      }
      state = { cookies: s.cookies, origins };
      if (!s.sessionPresent) say(`The session cookie "${p.sessionCookie}" is not there yet; sending what there is because you pressed Enter. The control plane decides.`);
    } else if (s && manual === false) {
      say(`On ${p.name}'s pages, but the session cookie "${p.sessionCookie}" has not appeared yet; still waiting.`);
      signedInPolls = 0;
    }
  }
  if (!state) await sleep(POLL_MS);
}
rl?.close();

/* ---------- 4. hand it over ---------- */

const picked = selectProviderState(state, domains);
if (!picked.cookies.length) {
  stopChrome(child);
  die(`No cookies for ${domains.join(", ")} were found in the window. Sign in there first, then run this again.`);
}
say(`\nSigned in. Handing ${picked.cookies.length} cookies and ${picked.origins.length} origin(s) for ${domains.join(", ")} to the control plane…`);

interface ImportResult {
  ok?: boolean;
  status?: string;
  name?: string;
  error?: string;
  imported?: { cookies: number; origins: number; cleared: number };
}
const t0 = Date.now();
let result: ImportResult | null = null;
while (!result) {
  let res: Response;
  try {
    res = await fetch(`${origin}${ex.importPath}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ex.token}` },
      body: JSON.stringify({ cookies: picked.cookies, origins: picked.origins, helper: { version: VERSION, os: `${os.platform()} ${os.release()}` } }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    say(`Could not reach ${origin} (${err instanceof Error ? err.message : String(err)}); trying again in ${IMPORT_RETRY_MS / 1000}s.`);
    await sleep(IMPORT_RETRY_MS);
    if (Date.now() - t0 > IMPORT_RETRY_FOR_MS) die("Gave up reaching the control plane. Make a new code and run this again.");
    continue;
  }
  const body = (await res.json().catch(() => ({}))) as ImportResult;
  if (res.status === 409 && Date.now() - t0 < IMPORT_RETRY_FOR_MS) {
    say(`The cloud browser is busy (${body?.error ?? "try again"}); trying again in ${IMPORT_RETRY_MS / 1000}s.`);
    await sleep(IMPORT_RETRY_MS);
    continue;
  }
  if (!res.ok) {
    stopChrome(child);
    die(`The control plane refused the session (${res.status}): ${body?.error ?? "unknown error"}`);
  }
  result = body;
}

// Close the window through the browser itself so the profile is flushed cleanly; force it only if needed.
try {
  await attached.cdp?.close();
} catch {
  /* already closing */
}
await sleep(500);
stopChrome(child);

if (result.ok) {
  say(`\nImported ${result.imported?.cookies ?? picked.cookies.length} cookies. ${result.name ?? p.name} is connected. You can close this terminal.`);
  process.exit(0);
}
die(`\nThe session was imported, but ${result.name ?? p.name} still looks signed out on the control plane (status: ${result.status ?? "unknown"}). Make sure you could see your chats in the Chrome window, then make a new code and try again.`);
