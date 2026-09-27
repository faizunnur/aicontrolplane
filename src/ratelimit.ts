import type { NextFunction, Request, Response } from "express";
import { clientIp } from "./auth.js";
import { config } from "./config.js";
import { addAudit } from "./db.js";
import { logger } from "./logger.js";
import { redisRateLimiter } from "../packages/realtime/src/index.js";

const log = logger("ratelimit");

/*
  A small fixed-window limiter for the login and pairing endpoints: a password guessed from
  the internet must not be guessable quickly. With REDIS_URL set the window is shared by
  every instance (N replicas must not mean N times the guesses); without it, per process.
  Redis being down fails open with a log line — a login outage is worse than a wider window.
*/

interface Bucket {
  count: number;
  resetAt: number;
}
const buckets = new Map<string, Bucket>();

const shared = config.redisUrl ? redisRateLimiter(config.redisUrl, (err) => log.warn("redis rate limiter error", err)) : null;

function countLocal(key: string, windowMs: number): { count: number; resetAt: number } {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count++;
  return { count: b.count, resetAt: b.resetAt };
}

export function rateLimit(opts: { name: string; max: number; windowMs: number }) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const key = `${opts.name}:${clientIp(req)}`;
    let count: number;
    let retryAfterS = Math.ceil(opts.windowMs / 1000);
    if (shared) {
      try {
        count = await shared(key, opts.windowMs);
      } catch (err) {
        log.warn("shared rate limit unavailable; counting locally", err);
        const local = countLocal(key, opts.windowMs);
        count = local.count;
        retryAfterS = Math.ceil((local.resetAt - Date.now()) / 1000);
      }
    } else {
      const local = countLocal(key, opts.windowMs);
      count = local.count;
      retryAfterS = Math.ceil((local.resetAt - Date.now()) / 1000);
    }
    if (count > opts.max) {
      if (count === opts.max + 1) await addAudit({ actor: clientIp(req), action: `ratelimit.${opts.name}`, detail: `${opts.max} attempts in ${Math.round(opts.windowMs / 60_000)} min` });
      res.setHeader("Retry-After", String(Math.max(retryAfterS, 1)));
      return res.status(429).json({ error: "Too many attempts. Try again later." });
    }
    next();
  };
}

/** For tests and admin tooling. Clears only the local fallback window. */
export function resetRateLimits() {
  buckets.clear();
}
