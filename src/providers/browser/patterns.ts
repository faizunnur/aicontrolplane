import { logger } from "../../logger.js";

const log = logger("patterns");

/** Regex sources from a platform config, compiled case-insensitively; a bad one is skipped, not fatal. */
export function compilePatterns(sources: string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const s of sources ?? []) {
    try {
      out.push(new RegExp(s, "i"));
    } catch {
      log.warn(`invalid pattern ignored: ${s}`);
    }
  }
  return out;
}
