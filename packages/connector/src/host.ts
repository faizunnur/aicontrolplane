import fs from "node:fs";
import path from "node:path";
import { packEnvelope } from "../../core/src/gateway.js";
import { CancelledError, type PlatformConfig, type StepStatus } from "../../core/src/index.js";
import type { AuditInput, CaptureInput, ConnectorHost, PlatformStatePatch, StepReporter } from "../../../src/browser/host.js";
import type { ConnectorClient } from "./client.js";

/*
  The host seam, implemented over the gateway: what the browser code writes (platform state,
  captures, screenshots, run steps, audit) becomes frames to the cloud, which writes them
  into the workspace. What must stay on this computer (session blobs) stays in its data
  folder. There is one workspace here and one browser, so provider claims always succeed.
*/

export class GatewayHost implements ConnectorHost {
  /** Provider configurations, from the welcome and refreshed by every job that names one. */
  readonly platforms = new Map<string, PlatformConfig>();
  /** Runs the cloud said to stop; checked at step boundaries. */
  readonly cancelled = new Set<number>();

  constructor(
    private readonly client: ConnectorClient,
    private readonly dataDir: string,
  ) {}

  setPlatforms(list: PlatformConfig[]): void {
    for (const p of list) this.platforms.set(p.id, p);
  }
  remember(p: PlatformConfig): void {
    this.platforms.set(p.id, p);
  }

  async setPlatformState(platformId: string, patch: PlatformStatePatch): Promise<void> {
    this.client.send({ t: "platform", platformId, patch: patch as Record<string, unknown> });
  }
  async addCapture(c: CaptureInput): Promise<void> {
    this.client.send({ t: "capture", ...c });
  }
  async pruneCaptures(): Promise<void> {
    /* the cloud keeps captures; nothing to prune here */
  }
  async saveScreenshot(platformId: string, png: Buffer): Promise<string> {
    // Kept locally for the app's own view, and sent up: the cloud stores it where the web app reads it.
    const dir = path.join(this.dataDir, "screenshots");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${platformId}.png`);
    fs.writeFileSync(file, png);
    this.client.sendBinary(packEnvelope({ t: "screenshot", platformId }, png));
    return file;
  }

  private sessionFile(platformId?: string): string {
    return platformId ? path.join(this.dataDir, "sessions", `${platformId}.json`) : path.join(this.dataDir, "sessions.json");
  }
  async loadSessionState(platformId?: string): Promise<string | null> {
    try {
      return fs.readFileSync(this.sessionFile(platformId), "utf8");
    } catch {
      return null;
    }
  }
  async saveSessionState(stateJson: string, platformId?: string): Promise<void> {
    // Never leaves this computer. The desktop shell wraps this file with the OS keychain (safeStorage).
    const file = this.sessionFile(platformId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, stateJson, { mode: 0o600 });
  }

  async claimProvider(): Promise<boolean> {
    return true;
  }
  async renewProviderClaim(): Promise<boolean> {
    return true;
  }
  async releaseProviderClaim(): Promise<void> {}

  async platform(platformId: string): Promise<PlatformConfig | undefined> {
    return this.platforms.get(platformId);
  }
  async audit(entry: AuditInput): Promise<void> {
    this.client.send({ t: "audit", action: entry.action, target: entry.target ?? null, detail: entry.detail ?? null });
  }
  async isCancelled(runId: number): Promise<boolean> {
    return this.cancelled.has(runId);
  }

  /** The step reporter for a run this computer is executing: each step is a run-event frame. */
  reporter(runId: number, messageId: number | null = null): StepReporter {
    return new GatewayStepReporter(this.client, this, runId, messageId);
  }
}

export class GatewayStepReporter implements StepReporter {
  constructor(
    private readonly client: ConnectorClient,
    private readonly host: GatewayHost,
    readonly runId: number,
    readonly messageId: number | null,
  ) {}

  private emit(key: string, label: string, status: StepStatus, detail?: string | null) {
    this.client.send({ t: "run-event", runId: this.runId, key, label, status, detail: detail ?? null });
  }
  async set(key: string, label: string, status: StepStatus, detail?: string | null): Promise<void> {
    this.emit(key, label, status, detail);
  }
  async start(key: string, label: string, detail?: string | null): Promise<void> {
    await this.checkCancel();
    this.emit(key, label, "running", detail);
  }
  async done(key: string, detail?: string | null): Promise<void> {
    this.emit(key, "", "done", detail);
  }
  async fail(key: string, detail?: string | null): Promise<void> {
    this.emit(key, "", "failed", detail);
  }
  async skip(key: string, detail?: string | null): Promise<void> {
    this.emit(key, "", "skipped", detail);
  }
  async waiting(key: string, label: string, detail?: string | null): Promise<void> {
    this.emit(key, label, "waiting", detail);
  }
  async log(label: string, detail?: string | null): Promise<void> {
    // The wire has steps only; a log line is a step that is done the moment it exists.
    this.emit(`log-${Date.now().toString(36)}`, label, "done", detail);
  }
  async failRunning(): Promise<void> {
    /* the cloud's own tracker closes whatever is still running when the job fails */
  }
  async checkCancel(): Promise<void> {
    if (this.host.cancelled.has(this.runId)) throw new CancelledError();
  }
}
