/**
 * Log in to every platform on your own machine, then export the session so it
 * can be pushed to the deployed control plane with `npm run push-state`.
 *
 *   npm run login
 *
 * A real Chromium window opens with one tab per platform. Sign in everywhere,
 * come back to this terminal and press Enter. The session lands in
 * data/state.json (cookies only; treat it like a password).
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { chromium } from "playwright";

const platforms = [
  { id: "chatgpt", url: "https://chatgpt.com/" },
  { id: "claude", url: "https://claude.ai/" },
  { id: "grok", url: "https://grok.com/" },
];

const dataDir = path.resolve(process.env.DATA_DIR || "./data");
const profileDir = path.join(dataDir, "login-profile");
const outFile = path.join(dataDir, "state.json");
fs.mkdirSync(profileDir, { recursive: true });

const ctx = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  channel: process.env.BROWSER_CHANNEL || undefined,
  viewport: null,
  args: ["--disable-blink-features=AutomationControlled", "--window-size=1400,900"],
  ignoreDefaultArgs: ["--enable-automation"],
});

for (const p of platforms) {
  const page = await ctx.newPage();
  await page.goto(p.url, { waitUntil: "domcontentloaded" }).catch(() => undefined);
}
for (const page of ctx.pages()) if (page.url() === "about:blank") await page.close().catch(() => undefined);

console.log("\nSign in to each platform in the browser window.");
console.log("When every tab shows you logged in, press Enter here to export the session.\n");
await new Promise<void>((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question("Press Enter to export… ", () => {
    rl.close();
    resolve();
  });
});

const state = await ctx.storageState();
fs.writeFileSync(outFile, JSON.stringify(state, null, 2));
console.log(`Exported ${state.cookies.length} cookies to ${outFile}`);
console.log("Next: npm run push-state -- https://your-app.up.railway.app YOUR_ADMIN_TOKEN");
await ctx.close();
