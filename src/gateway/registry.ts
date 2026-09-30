import type { CloudFrame } from "../../packages/core/src/gateway.js";

/*
  Which desktop connectors are online right now, by workspace. One connector per workspace
  at a time: a newer connection from the same workspace supersedes the older one (a laptop
  that woke up twice, or a second computer), because two Chromes driving one set of
  accounts at once is exactly what the provider claim exists to prevent.

  Kept apart from the socket code so the live view and the browser-op router can ask
  "is this workspace's computer here?" without importing the gateway server.
*/

export interface Connector {
  org: number;
  deviceId: number;
  name: string;
  app: string;
  version: string;
  os: string;
  chrome: string | null;
  providers: string[];
  connectedAt: string;
  send(frame: CloudFrame): void;
  sendBinary(buf: Buffer): void;
  close(code: number, reason: string): void;
}

const byOrg = new Map<number, Connector>();
const listeners = new Set<(org: number, conn: Connector | null) => void>();

function notify(org: number, conn: Connector | null) {
  for (const l of listeners) {
    try {
      l(org, conn);
    } catch {
      /* a listener's failure is its own */
    }
  }
}

export function registerConnector(conn: Connector): void {
  const prev = byOrg.get(conn.org);
  byOrg.set(conn.org, conn);
  if (prev && prev !== conn) prev.close(4002, "superseded by a newer connection from this workspace");
  notify(conn.org, conn);
}

export function unregisterConnector(conn: Connector): void {
  if (byOrg.get(conn.org) !== conn) return;
  byOrg.delete(conn.org);
  notify(conn.org, null);
}

export function connectorFor(org: number): Connector | undefined {
  return byOrg.get(org);
}

export function connectorOnline(org: number): boolean {
  return byOrg.has(org);
}

export function connectors(): Connector[] {
  return [...byOrg.values()];
}

/** A revoked device's live socket goes with it. */
export function closeConnectorsOfDevice(deviceId: number, reason: string): number {
  let n = 0;
  for (const c of byOrg.values()) {
    if (c.deviceId !== deviceId) continue;
    c.close(4001, reason);
    n++;
  }
  return n;
}

/** Called with the connector when a workspace's computer arrives, with null when it leaves. */
export function onConnectorChange(cb: (org: number, conn: Connector | null) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
