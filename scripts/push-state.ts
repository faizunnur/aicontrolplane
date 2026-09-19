/**
 * Push the session exported by `npm run login` to a running control plane.
 *
 *   npm run push-state -- https://your-app.up.railway.app YOUR_ADMIN_TOKEN [data/state.json]
 */
import fs from "node:fs";
import path from "node:path";

const [base, token, file] = process.argv.slice(2);
if (!base || !token) {
  console.error("usage: npm run push-state -- <control-plane-url> <admin-token> [state.json]");
  process.exit(1);
}
const statePath = path.resolve(file || path.join(process.env.DATA_DIR || "./data", "state.json"));
if (!fs.existsSync(statePath)) {
  console.error(`state file not found: ${statePath}. Run "npm run login" first.`);
  process.exit(1);
}
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const res = await fetch(`${base.replace(/\/$/, "")}/api/browser/import-state`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify({ cookies: state.cookies }),
});
const body = await res.text();
if (!res.ok) {
  console.error(`failed (${res.status}): ${body}`);
  process.exit(1);
}
console.log(`ok: ${body}`);
console.log("Now press Sync on the dashboard. If a platform still shows login required, sign in through the browser screen.");
