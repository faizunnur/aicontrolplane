import { randomBytes } from "node:crypto";
import { DEVICE_TOKEN_PREFIX } from "../packages/core/src/gateway.js";
import { tokenHash, type AuthUser } from "./auth.js";
import { addAudit, findDeviceByTokenHash, getDevice, insertDevice, listDevices, updateDevice, type DeviceRow } from "./db.js";
import { closeConnectorsOfDevice, connectorFor } from "./gateway/registry.js";

/*
  Desktop devices: the computers a workspace's owner has installed the connector on. Each
  gets one token, shown once at creation and kept only as its hash; the connector presents
  it on every gateway connection. Revoking a device cuts its live socket and refuses the
  token from then on. A device token satisfies nothing else: it is not a login.
*/

export interface DeviceView {
  id: number;
  name: string;
  os: string | null;
  app_version: string | null;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  /** Connected to the gateway right now. */
  online: boolean;
}

export function deviceView(d: DeviceRow): DeviceView {
  const c = connectorFor(d.org_id);
  return { id: d.id, name: d.name, os: d.os, app_version: d.app_version, created_at: d.created_at, last_seen_at: d.last_seen_at, revoked_at: d.revoked_at, online: !!c && c.deviceId === d.id };
}

export async function createDevice(name: string, by: AuthUser): Promise<{ device: DeviceView; token: string }> {
  const token = DEVICE_TOKEN_PREFIX + randomBytes(24).toString("hex");
  const row = await insertDevice({ name: name.trim().slice(0, 80) || "My computer", user_id: by.id || null, token_hash: tokenHash(token) });
  await addAudit({ actor: by.email, action: "device.created", target: row.name });
  return { device: deviceView(row), token };
}

/** The device a presented token belongs to, if it is one and has not been revoked. Global: the token is the capability. */
export async function deviceFromToken(token: string | undefined): Promise<DeviceRow | undefined> {
  if (!token || !token.startsWith(DEVICE_TOKEN_PREFIX)) return undefined;
  return findDeviceByTokenHash(tokenHash(token));
}

export async function listDevicesView(): Promise<DeviceView[]> {
  return (await listDevices()).map(deviceView);
}

export async function revokeDevice(id: number, by: string): Promise<DeviceRow | undefined> {
  const d = await getDevice(id);
  if (!d) return undefined;
  if (d.revoked_at) return d;
  const row = await updateDevice(id, { revoked_at: new Date().toISOString() });
  closeConnectorsOfDevice(id, "this device was revoked");
  await addAudit({ actor: by, action: "device.revoked", target: d.name });
  return row;
}

/** What the connector said about itself at hello, and when it was last here. */
export async function touchDevice(id: number, patch: { os?: string; app_version?: string } = {}): Promise<void> {
  await updateDevice(id, { ...patch, last_seen_at: new Date().toISOString() });
}
