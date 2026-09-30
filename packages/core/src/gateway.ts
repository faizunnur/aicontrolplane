import type { PlatformConfig, StepStatus } from "./index.js";

/*
  The gateway protocol: one WebSocket between the cloud control plane and a desktop
  connector (the app on the workspace owner's computer that drives their own Chrome).

    desktop → cloud   hello · ack · result · run-event · state · platform · capture · audit ·
                      live-error · pong, plus binary envelopes: screenshot, frame
    cloud → desktop   welcome · job · live · cmd · ping · bye

  The socket is authenticated once, at the upgrade, by the device token (Authorization:
  Bearer acp_dev_…), and is bound to that device's workspace for its whole life: every frame
  is read in that workspace and no other. JSON text frames carry state; binary envelopes (a
  JSON header line, then raw bytes) carry screenshots and screencast frames.

  This module has no dependencies beyond core types, so the desktop app bundles it as is.
*/

export const GATEWAY_PATH = "/gw";
export const GATEWAY_PROTOCOL = 1;
export const DEVICE_TOKEN_PREFIX = "acp_dev_";

export type LiveLevel = "low" | "medium" | "high";

export interface LiveMeta {
  platform: string;
  url: string;
  title: string;
  width: number;
  height: number;
}

/* ---------- desktop → cloud ---------- */

export interface HelloFrame {
  t: "hello";
  protocol: number;
  /** The connector's name and version, for the devices list and for minimum-version gates. */
  app: string;
  version: string;
  os: string;
  /** The Chrome the connector drives, if it found one. */
  chrome?: string | null;
  /** Providers the connector holds a session for, as far as it knows. */
  providers?: string[];
}
export interface AckFrame {
  t: "ack";
  jobId: string;
}
export interface ResultFrame {
  t: "result";
  jobId: string;
  ok: boolean;
  value?: unknown;
  error?: string;
}
/** A step of a run the connector is executing (the host seam's step reporter, on the wire). */
export interface RunEventFrame {
  t: "run-event";
  runId: number;
  key: string;
  label: string;
  status: StepStatus;
  detail?: string | null;
}
/** The connector's browser snapshot (open tabs, busy task, sign-in), shown as the workspace's live view. */
export interface StateFrame {
  t: "state";
  snapshot: Record<string, unknown>;
}
export interface PlatformFrame {
  t: "platform";
  platformId: string;
  patch: Record<string, unknown>;
}
export interface CaptureFrame {
  t: "capture";
  platform: string;
  url: string;
  method: string;
  status: number;
  content_type: string;
  body: string;
}
export interface AuditFrame {
  t: "audit";
  action: string;
  target?: string | null;
  detail?: string | null;
}
export interface LiveErrorFrame {
  t: "live-error";
  platform: string;
  message: string;
}
export interface PongFrame {
  t: "pong";
}
export type DeviceFrame = HelloFrame | AckFrame | ResultFrame | RunEventFrame | StateFrame | PlatformFrame | CaptureFrame | AuditFrame | LiveErrorFrame | PongFrame;

/** Binary envelope headers (desktop → cloud). */
export interface ScreenshotHeader {
  t: "screenshot";
  platformId: string;
}
export interface FrameHeader {
  t: "frame";
  platform: string;
  meta: LiveMeta;
  metaChanged?: boolean;
}

/* ---------- cloud → desktop ---------- */

export interface WelcomeFrame {
  t: "welcome";
  protocol: number;
  deviceId: number;
  org: number;
  /** The workspace's provider configurations, as the connector must drive them. */
  platforms: PlatformConfig[];
  serverTime: string;
}
/** One piece of browser work. The connector answers with a result frame carrying the same jobId. */
export interface JobFrame {
  t: "job";
  jobId: string;
  op: string;
  payload: unknown;
  timeoutMs: number;
}
/** A web viewer wants (level) or stops wanting (null) this tab's screencast. */
export interface LiveWantFrame {
  t: "live";
  platform: string;
  level: LiveLevel | null;
}
/** A viewer's command on a tab (navigate, click, type), forwarded as the live view sends it. */
export interface CmdFrame {
  t: "cmd";
  platform: string;
  override: boolean;
  msg: Record<string, unknown>;
}
export interface PingFrame {
  t: "ping";
}
export interface ByeFrame {
  t: "bye";
  reason: string;
}
export type CloudFrame = WelcomeFrame | JobFrame | LiveWantFrame | CmdFrame | PingFrame | ByeFrame;

/** Close codes the cloud uses; the connector reads them to decide whether reconnecting makes sense. */
export const CLOSE_REVOKED = 4001;
export const CLOSE_SUPERSEDED = 4002;
export const CLOSE_PROTOCOL = 4003;
export const CLOSE_NO_HELLO = 4004;

/* ---------- binary envelopes: a JSON header line, then the bytes ---------- */

export function packEnvelope(header: Record<string, unknown>, body?: Uint8Array | null): Buffer {
  const head = Buffer.from(JSON.stringify(header) + "\n", "utf8");
  return body && body.length ? Buffer.concat([head, Buffer.from(body)]) : head;
}

export function unpackEnvelope(buf: Buffer): { header: Record<string, unknown>; body: Buffer } {
  const nl = buf.indexOf(0x0a);
  const headEnd = nl === -1 ? buf.length : nl;
  const header = JSON.parse(buf.subarray(0, headEnd).toString("utf8")) as Record<string, unknown>;
  return { header, body: nl === -1 ? Buffer.alloc(0) : buf.subarray(nl + 1) };
}
