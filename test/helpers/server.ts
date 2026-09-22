/**
 * Boots the real server as a child process (tsx on the TypeScript source), with headless
 * Chromium and a throw-away data folder, and gives tests an authenticated API client.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface TestServer {
  base: string;
  dataDir: string;
  cookie: string;
  api<T = any>(path: string, opts?: { method?: string; body?: unknown; headers?: Record<string, string> }): Promise<T>;
  raw(path: string, init?: RequestInit): Promise<Response>;
  stop(opts?: { keepData?: boolean }): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

export async function startServer(env: Record<string, string> = {}, opts: { dataDir?: string } = {}): Promise<TestServer> {
  const port = await freePort();
  const dataDir = opts.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "acp-e2e-"));
  fs.mkdirSync(dataDir, { recursive: true });
  const base = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", "src/bootstrap.ts"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      HEADLESS: "true",
      BROWSER_ENABLED: "true",
      SYNC_ENABLED: "false",
      ROUTER_PROVIDER: "none",
      NODE_ENV: "test",
      LOG_LEVEL: process.env.ACP_TEST_LOG || "warn",
      DATABASE_URL: "",
      RAILWAY_VOLUME_MOUNT_PATH: "",
      ...env,
    },
    // ACP_TEST_STDIO=inherit streams the server's log into the test output for debugging.
    stdio: process.env.ACP_TEST_STDIO === "inherit" ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
  });
  const logs: string[] = [];
  child.stdout?.on("data", (d) => logs.push(String(d)));
  child.stderr?.on("data", (d) => logs.push(String(d)));

  const deadline = Date.now() + 90_000;
  let up = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) {
        up = true;
        break;
      }
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (!up) {
    stopChild(child);
    throw new Error(`server did not come up on ${base}\n${logs.join("")}`);
  }

  let cookie = "";
  const raw = (p: string, init: RequestInit = {}) => fetch(base + p, { ...init, headers: { cookie, ...(init.headers as Record<string, string> | undefined) } });
  const api = async <T = any>(p: string, opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> => {
    const res = await fetch(base + "/api" + p, {
      method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
      headers: { "content-type": "application/json", cookie, ...(opts.headers ?? {}) },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const sc = res.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    const data = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw Object.assign(new Error(`${opts.method ?? "GET"} ${p} -> ${res.status} ${data.error ?? ""}`), { status: res.status, data });
    return data as T;
  };

  // First run: create the password and keep the session cookie. A reused data folder already has one: sign in instead.
  try {
    await api("/setup", { body: { password: "test-password-123" } });
  } catch (err) {
    if ((err as { status?: number }).status !== 409) throw err;
    await api("/session", { body: { password: "test-password-123" } });
  }

  return {
    base,
    dataDir,
    get cookie() {
      return cookie;
    },
    api,
    raw,
    stop: async (o: { keepData?: boolean } = {}) => {
      stopChild(child);
      if (o.keepData) {
        await new Promise((r) => setTimeout(r, 800));
        return;
      }
      // Chromium releases its profile files a moment after the kill; a temp folder that will not
      // go is not worth failing a test run over, so try a few times and then leave it.
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 300));
        try {
          fs.rmSync(dataDir, { recursive: true, force: true });
          return;
        } catch {
          /* still busy */
        }
      }
    },
  };
}

function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || !child.pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" });
  else child.kill("SIGTERM");
}

/** Poll until fn returns something truthy or the timeout passes. */
export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 60_000, everyMs = 400): Promise<T | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return null;
}

/** Collect server-sent events from /api/stream into an array, until stop() is called. */
export async function listenSse(server: TestServer): Promise<{ events: { ev: string; data: any }[]; stop(): void }> {
  const ctrl = new AbortController();
  const res = await server.raw("/api/stream", { signal: ctrl.signal });
  const events: { ev: string; data: any }[] = [];
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (.*)$/m.exec(chunk)?.[1];
          const data = /^data: (.*)$/m.exec(chunk)?.[1];
          if (ev) events.push({ ev, data: data ? JSON.parse(data) : null });
        }
      }
    } catch {
      /* aborted */
    }
  })();
  return { events, stop: () => ctrl.abort() };
}
