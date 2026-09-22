import type { NextFunction, Request, Response } from "express";
import { addAudit } from "./db.js";
import { clientIp } from "./auth.js";

/*
  A small fixed-window limiter for the login endpoints: a password guessed from the internet must
  not be guessable quickly. In memory, per client address; enough for a single-user deployment.
*/

interface Bucket {
  count: number;
  resetAt: number;
}
const buckets = new Map<string, Bucket>();

export function rateLimit(opts: { name: string; max: number; windowMs: number }) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = `${opts.name}:${clientIp(req)}`;
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + opts.windowMs };
      buckets.set(key, b);
    }
    b.count++;
    if (b.count > opts.max) {
      if (b.count === opts.max + 1) addAudit({ actor: clientIp(req), action: `ratelimit.${opts.name}`, detail: `${opts.max} attempts in ${Math.round(opts.windowMs / 60_000)} min` });
      res.setHeader("Retry-After", String(Math.ceil((b.resetAt - now) / 1000)));
      return res.status(429).json({ error: "Too many attempts. Try again later." });
    }
    next();
  };
}

/** For tests and admin tooling. */
export function resetRateLimits() {
  buckets.clear();
}
