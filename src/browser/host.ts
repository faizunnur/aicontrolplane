import type { PlatformConfig, PlatformState } from "../../packages/core/src/index.js";

/*
  The host seam. Everything the browser code needs from the world outside a tab goes through
  this interface: platform state, captured payloads, screenshots, session blobs, provider
  claims, audit, cancellation. (A run's step reporter is the one exception: callers pass it
  in with the execution context.)

  The cloud implements it with the database (host-local.ts, installed by default). The
  desktop connector implements it with the gateway. Browser code never imports the database,
  so it can run where there is none — that is the whole point of the seam.
*/

export type PlatformStatePatch = Partial<Omit<PlatformState, "platform">>;

export interface CaptureInput {
  platform: string;
  url: string;
  method: string;
  status: number;
  content_type: string;
  body: string;
}

export interface AuditInput {
  actor: string;
  action: string;
  target?: string | null;
  detail?: string | null;
}

export interface ConnectorHost {
  /** Bookkeeping the browser flows write as they go (session status, last error, screenshot path). */
  setPlatformState(platformId: string, patch: PlatformStatePatch): Promise<void>;
  /** JSON a provider's tasks page fetched, kept for normalisation and debugging. */
  addCapture(c: CaptureInput): Promise<void>;
  pruneCaptures(platformId: string): Promise<void>;
  /** Store the provider's screenshot; returns what platform_state.screenshot_path should hold. */
  saveScreenshot(platformId: string, png: Buffer): Promise<string>;
  /** Session blobs: one provider's (platformId given) or the whole profile's (legacy browser). */
  loadSessionState(platformId?: string): Promise<string | null>;
  saveSessionState(stateJson: string, platformId?: string): Promise<void>;
  /** The cross-worker provider claim (see the note above ProviderBusyError in fleet.ts). A host with one worker always answers true. */
  claimProvider(platformId: string, owner: string, ttlMs: number): Promise<boolean>;
  renewProviderClaim(platformId: string, owner: string, ttlMs: number): Promise<boolean>;
  releaseProviderClaim(platformId: string, owner: string): Promise<void>;
  /** The provider's configuration as this host knows it. */
  platform(platformId: string): Promise<PlatformConfig | undefined>;
  audit(entry: AuditInput): Promise<void>;
  /** Has someone pressed Stop on this run? Checked at step boundaries. */
  isCancelled(runId: number): Promise<boolean>;
}

let current: ConnectorHost | null = null;

/** Install the host for this process; null goes back to the database-backed default. */
export function setHost(h: ConnectorHost | null): void {
  current = h;
}

/**
 * The host in use. Until one is installed, calls go to the local (database) host, loaded on
 * first use rather than imported here: a static import would drag the database into every
 * process that loads browser code, which is exactly what the seam exists to prevent.
 */
export function host(): ConnectorHost {
  return current ?? deferredLocal;
}

const local = () => import("./host-local.js").then((m) => m.localHost);
const deferredLocal: ConnectorHost = {
  setPlatformState: (id, patch) => local().then((h) => h.setPlatformState(id, patch)),
  addCapture: (c) => local().then((h) => h.addCapture(c)),
  pruneCaptures: (id) => local().then((h) => h.pruneCaptures(id)),
  saveScreenshot: (id, png) => local().then((h) => h.saveScreenshot(id, png)),
  loadSessionState: (id) => local().then((h) => h.loadSessionState(id)),
  saveSessionState: (json, id) => local().then((h) => h.saveSessionState(json, id)),
  claimProvider: (id, owner, ttl) => local().then((h) => h.claimProvider(id, owner, ttl)),
  renewProviderClaim: (id, owner, ttl) => local().then((h) => h.renewProviderClaim(id, owner, ttl)),
  releaseProviderClaim: (id, owner) => local().then((h) => h.releaseProviderClaim(id, owner)),
  platform: (id) => local().then((h) => h.platform(id)),
  audit: (e) => local().then((h) => h.audit(e)),
  isCancelled: (runId) => local().then((h) => h.isCancelled(runId)),
};
