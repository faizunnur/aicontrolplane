import WebSocket from "ws";
import { CLOSE_PROTOCOL, CLOSE_REVOKED, GATEWAY_PATH, GATEWAY_PROTOCOL, type CloudFrame, type CmdFrame, type DeviceFrame, type HelloFrame, type JobFrame, type LiveWantFrame, type WelcomeFrame } from "../../core/src/gateway.js";

/*
  The desktop end of the gateway socket: connects with the device token, says hello, keeps
  the connection alive, answers jobs, and reconnects with backoff when the line drops. It
  stops for good on the close codes that mean retrying is pointless (revoked, protocol).
  Depends on nothing but the protocol and `ws`, so the desktop app bundles it as is.
*/

export type ConnectorState = "connecting" | "connected" | "disconnected" | "stopped";

export interface ConnectorClientOptions {
  /** The cloud's base URL (http or https); the scheme becomes ws/wss and /gw is appended. */
  url: string;
  token: string;
  hello: Omit<HelloFrame, "t" | "protocol">;
  onWelcome(welcome: WelcomeFrame): void | Promise<void>;
  /** Do the job; the returned value (or thrown error) becomes the result frame. */
  onJob(job: JobFrame): Promise<unknown>;
  onLive?(want: LiveWantFrame): void | Promise<void>;
  onCmd?(cmd: CmdFrame): void | Promise<void>;
  onCancel?(runId: number): void;
  onState?(state: ConnectorState, detail?: string): void;
  log?(message: string, err?: unknown): void;
}

export function gatewayUrlFor(base: string): string {
  const u = new URL(base);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = u.pathname.replace(/\/$/, "") + GATEWAY_PATH;
  u.search = "";
  u.hash = "";
  return u.toString();
}

const MAX_BACKOFF_MS = 30_000;

export class ConnectorClient {
  private ws: WebSocket | null = null;
  private stopped = false;
  private attempt = 0;
  private timer: NodeJS.Timeout | null = null;
  connected = false;
  welcome: WelcomeFrame | null = null;

  constructor(private readonly opts: ConnectorClientOptions) {}

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close(1000, "connector stopping");
      } catch {
        ws.terminate();
      }
    }
    this.connected = false;
    this.opts.onState?.("stopped", "stopped");
  }

  send(frame: DeviceFrame): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(frame));
    return true;
  }

  sendBinary(buf: Buffer): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(buf, { binary: true });
    return true;
  }

  /** Bytes queued on the socket and not yet sent: the screencast sink uses it to drop frames instead of piling them up. */
  get bufferedAmount(): number {
    return this.ws?.bufferedAmount ?? 0;
  }

  private open() {
    if (this.stopped) return;
    this.opts.onState?.("connecting");
    const ws = new WebSocket(gatewayUrlFor(this.opts.url), { headers: { authorization: `Bearer ${this.opts.token}` } });
    this.ws = ws;
    ws.on("open", () => {
      this.attempt = 0;
      ws.send(JSON.stringify({ t: "hello", protocol: GATEWAY_PROTOCOL, ...this.opts.hello }));
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      let frame: CloudFrame;
      try {
        frame = JSON.parse(data.toString()) as CloudFrame;
      } catch {
        return;
      }
      this.handle(frame).catch((err) => this.opts.log?.(`handling a ${frame.t} frame failed`, err));
    });
    ws.on("unexpected-response", (_req, res) => {
      this.opts.log?.(`the gateway refused the connection: HTTP ${res.statusCode}`);
      if (res.statusCode === 401) {
        // The token is not known there (revoked, or another install): retrying cannot help.
        this.stopped = true;
        this.opts.onState?.("stopped", "the device token was refused; pair this computer again");
      }
      ws.terminate();
    });
    ws.on("close", (code, reason) => {
      if (this.ws === ws) this.ws = null;
      const wasConnected = this.connected;
      this.connected = false;
      this.welcome = null;
      if (this.stopped) return;
      if (code === CLOSE_REVOKED || code === CLOSE_PROTOCOL) {
        this.stopped = true;
        this.opts.onState?.("stopped", reason.toString() || `closed with ${code}`);
        return;
      }
      this.opts.onState?.("disconnected", `${code} ${reason.toString()}`.trim());
      if (wasConnected) this.attempt = 0;
      this.scheduleReconnect();
    });
    ws.on("error", (err) => this.opts.log?.("gateway socket error", err));
  }

  private scheduleReconnect() {
    if (this.stopped || this.timer) return;
    const delay = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.min(this.attempt++, 5));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.open();
    }, delay);
    this.timer.unref?.();
  }

  private async handle(frame: CloudFrame) {
    switch (frame.t) {
      case "welcome":
        this.connected = true;
        this.welcome = frame;
        this.opts.onState?.("connected");
        await this.opts.onWelcome(frame);
        return;
      case "ping":
        this.send({ t: "pong" });
        return;
      case "job": {
        this.send({ t: "ack", jobId: frame.jobId });
        try {
          const value = await this.opts.onJob(frame);
          this.send({ t: "result", jobId: frame.jobId, ok: true, value });
        } catch (err) {
          this.send({ t: "result", jobId: frame.jobId, ok: false, error: (err instanceof Error ? err.message : String(err)).slice(0, 500) });
        }
        return;
      }
      case "cancel":
        this.opts.onCancel?.(frame.runId);
        return;
      case "live":
        await this.opts.onLive?.(frame);
        return;
      case "cmd":
        await this.opts.onCmd?.(frame);
        return;
      case "bye":
        this.opts.log?.(`the gateway said bye: ${frame.reason}`);
        return;
    }
  }
}
