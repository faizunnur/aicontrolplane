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
/** Unseal when sealed; pass anything else through (values written before sealing existed). */
export const openMaybe = async (value: string | null | undefined): Promise<string | null> => {
  if (!value) return value ?? null;
  return isSealed(value) ? get().open(value) : value;
};
export { isSealed };
