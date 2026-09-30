import type { PlatformConfig } from "../../core/src/index.js";
import { browser } from "../../../src/browser/manager.js";
import { screenshotProvider } from "../../../src/providers/browser/actions.js";
import { checkSignIn, sendThroughBrowser } from "../../../src/providers/browser/chat.js";
import { detectChallenge } from "../../../src/providers/browser/login.js";
import type { GatewayHost } from "./host.js";

/*
  What this computer can do when the cloud asks (the job's `op`). The same browser flows the
  cloud's browser service runs, minus their database bookkeeping — that stays with the
  caller in the cloud, fed by this host's frames. Ops the connector does not do yet answer
  with a clear error rather than a silent no.
*/

export interface OpContext {
  host: GatewayHost;
  platform: PlatformConfig;
}
export type OpHandler = (payload: Record<string, unknown>, ctx: OpContext) => Promise<unknown>;

export const CONNECTOR_OPS: Record<string, OpHandler> = {
  "auth.check": async (_p, { platform }) => checkSignIn(platform),
  "auth.connect": async (_p, { platform }) =>
    browser.withLock(
      async () => {
        const page = await browser.consolePage(platform.id, platform.appUrl);
        await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
        await page.waitForTimeout(1_500); // a bot check renders after load
        return await detectChallenge(page);
      },
      { label: `Opening ${platform.name}`, platform: platform.id },
    ),
  "chat.send": async (p, { host, platform }) => {
    const runId = typeof p.runId === "number" ? p.runId : null;
    const messageId = typeof p.messageId === "number" ? p.messageId : null;
    return sendThroughBrowser(platform, String(p.text ?? ""), runId ? host.reporter(runId, messageId) : undefined);
  },
  "console.open": async (p, { platform }) => {
    const url = String(p.url ?? platform.appUrl);
    await browser.withLock(() => browser.consolePage(platform.id, url), { label: `Opening ${platform.name}`, platform: platform.id });
    return { ok: true, action: "open", message: `console tab is on ${url}. Watch it in the live view.`, url };
  },
  "screenshot.take": async (_p, { platform }) => ({ file: await screenshotProvider(platform) }),
};

/** Ops that belong to the cloud browser service's own display, or are not yet done here. */
const NOT_HERE: Record<string, string> = {
  "desktop.start": "sign in from the desktop app itself: it opens your own Chrome",
  "desktop.state": "sign in from the desktop app itself: it opens your own Chrome",
  "desktop.cancel": "there is no cloud desktop sign-in to cancel on this computer",
  "session.import": "sessions live on this computer already; nothing to import",
  "sync.all": "reading task pages from this computer is not available yet",
  "sync.provider": "reading task pages from this computer is not available yet",
  "action.run": "running configured actions from this computer is not available yet",
};

export async function runOp(op: string, payload: unknown, host: GatewayHost, platformFromJob?: PlatformConfig): Promise<unknown> {
  const handler = CONNECTOR_OPS[op];
  if (!handler) throw new Error(NOT_HERE[op] ?? `this computer cannot do "${op}"`);
  const p = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const platformId = typeof p.platformId === "string" ? p.platformId : platformFromJob?.id;
  const platform = platformFromJob ?? (platformId ? host.platforms.get(platformId) : undefined);
  if (!platform) throw new Error(`this computer does not know the provider "${platformId ?? "?"}"`);
  host.remember(platform);
  return handler(p, { host, platform });
}
