import os from "node:os";
import path from "node:path";

/*
  The desktop connector, as a plain Node process: the desktop app minus its window. It runs
  this computer's Chrome for one workspace and talks to the cloud over the gateway.

    ACP_URL           the cloud's address (https://…)
    ACP_DEVICE_TOKEN  the token from Settings › Devices (or POST /api/devices), shown once
    DATA_DIR          where the Chrome profile, sessions and screenshots live
                      (default: ~/.aicontrolplane/connector)
    HEADLESS          true for a windowless Chrome (tests); a real window otherwise
    PORT              when set, a local /healthz for the shell or a harness to watch

  The environment is settled before anything that reads it loads (config.ts reads it once).
*/

const url = process.env.ACP_URL?.trim();
const token = process.env.ACP_DEVICE_TOKEN?.trim();
if (!url || !token) {
  console.error("[connector] ACP_URL and ACP_DEVICE_TOKEN are required (pair this computer in the web app under Settings › Devices)");
  process.exit(2);
}
process.env.DATA_DIR = process.env.DATA_DIR || path.join(os.homedir(), ".aicontrolplane", "connector");
process.env.BROWSER_ENABLED = process.env.BROWSER_ENABLED || "true";
process.env.ROLE = "all";
delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
delete process.env.DATABASE_URL;

await import("./run.js");
