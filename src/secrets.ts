import { config } from "./config.js";
import { logger } from "./logger.js";
import { Envelope, EnvKeystore, isSealed, loadMasterKey } from "../packages/security/src/index.js";

const log = logger("secrets");

/*
  The deployment's envelope for secrets at rest. One master key (ACP_MASTER_KEY, or a
  generated key file in the data folder) wraps a fresh data key per sealed record.
*/

let envelope: Envelope | null = null;

function get(): Envelope {
  if (!envelope) envelope = new Envelope(new EnvKeystore(loadMasterKey(config.dataDir, (m) => log.warn(m))));
  return envelope;
}

export const seal = (plaintext: string): Promise<string> => get().seal(plaintext);
export const open = (sealed: string): Promise<string> => get().open(sealed);
export { isSealed };
