/*
  The job queue seam. Handlers and senders speak this interface; the engine behind it is
  either the in-process executor (single-container mode: a send runs the handler on the spot,
  preserving today's latency and ordering exactly) or pg-boss (split mode: durable jobs in
  Postgres, claimed with SKIP LOCKED by whichever worker gets there first, retried per job
  policy). Nothing outside this package may import pg-boss — swapping the engine for NATS or
  Kafka later is this one file's problem.
*/

export interface JobOptions {
  /** At most one queued/active job per key (serialization + dedupe). */
  singletonKey?: string;
  /** Delay before the job becomes available. */
  startAfterSeconds?: number;
  /** Retries after failure. Default 0: never blindly retry non-idempotent work. */
  retryLimit?: number;
  /** Backoff base for retries, in seconds (exponential, from pg-boss). */
  retryDelaySeconds?: number;
  /** Job priority: higher runs first (pg-boss semantics). */
  priority?: number;
  /** Seconds a claimed job may run before it expires back to the queue. */
  expireInSeconds?: number;
}

/*
  The retry policy lives HERE, per queue name, not scattered over send sites. A send may still
  override any field explicitly, but the default is a decision, not an accident: a queue whose
  handler is idempotent (guarded run claims, the delivery re-read in jobs.ts) earns retries; a
  queue that a cron refires anyway keeps 0. handlerTimeoutSeconds is the watchdog deadline for
  the handler itself (see work()); absent, it is expireInSeconds - 30s, never under 60s.
*/
export interface QueueDefaults extends JobOptions {
  /** Watchdog deadline for one handler invocation, in seconds. */
  handlerTimeoutSeconds?: number;
}

export const QUEUE_DEFAULTS: Record<string, QueueDefaults> = {
  // Task starts and resumes claim their run with a guarded transition; redelivery is harmless.
  "task.start": { retryLimit: 3, retryDelaySeconds: 30 },
  "run.resume": { retryLimit: 3, retryDelaySeconds: 30 },
  "browser.run.resume": { retryLimit: 3, retryDelaySeconds: 30 },
  // Deliveries are made retry-safe by the handler's message re-read (a prior attempt that got
  // a run going, or finished, is never sent again). The chat deadline covers the 120s reply
  // wait twice (the in-handler fresh-tab retry) plus navigation and time queued behind the
  // per-(workspace, provider) chain.
  "browser.chat.deliver": { retryLimit: 2, retryDelaySeconds: 60, handlerTimeoutSeconds: 420 },
  "dispatch.deliver": { retryLimit: 2, retryDelaySeconds: 60 },
  "browser.dispatch.deliver": { retryLimit: 2, retryDelaySeconds: 60, handlerTimeoutSeconds: 420 },
  // The sync cron refires every interval; a failed look is simply superseded by the next one.
  "browser.sync.platform": { retryLimit: 0 },
  // Reserved for a jobified webhook delivery; today the delivery retries inside its handler
  // (the run timeline records the attempts), so nothing sends to this queue yet.
  "webhook.deliver": { retryLimit: 5, retryDelaySeconds: 30 },
};

/** The effective options for a send: the queue's defaults underneath, explicit opts on top. cron.* stays 0 by falling through. */
export function resolveJobOptions(name: string, opts: JobOptions = {}): JobOptions {
  const merged: JobOptions = { ...(QUEUE_DEFAULTS[name] ?? {}) };
  for (const k of Object.keys(opts) as (keyof JobOptions)[]) {
    if (opts[k] !== undefined) (merged as Record<string, unknown>)[k] = opts[k];
  }
  return merged;
}

/** How long one handler invocation may run before the watchdog abandons the attempt. */
export function handlerDeadlineMs(name: string): number {
  const d = QUEUE_DEFAULTS[name];
  if (d?.handlerTimeoutSeconds) return d.handlerTimeoutSeconds * 1000;
  const expire = d?.expireInSeconds ?? 15 * 60;
  return Math.max(60, expire - 30) * 1000;
}

export type JobHandler<T> = (data: T) => Promise<void>;

export interface Queue {
  readonly kind: "inline" | "boss";
  send<T>(name: string, data: T, opts?: JobOptions): Promise<void>;
  /** Register the handler for a job name. In split mode only worker processes call this. */
  work<T>(name: string, handler: JobHandler<T>, opts?: { teamSize?: number }): void;
  /** Boss mode: connect and begin claiming. Inline mode: no-op. */
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * Fire a job on a cron, once per interval across every process (boss mode). The inline
   * engine has no cron — single-process deployments keep their plain timers instead.
   */
  schedule(name: string, cron: string, data?: unknown): Promise<void>;
}

/* ---------- the job catalog: every name and payload in one place ---------- */

export interface ChatDeliverJob {
  messageId: number;
  platformId: string;
}
export interface DispatchDeliverJob {
  messageId: number;
}
export interface TaskStartJob {
  runId: number;
}
export interface RunResumeJob {
  runId: number;
  approvalId: number;
  decision: "approved" | "rejected" | "timeout";
}
export interface BrowserOpJob {
  opId: number;
}
/** One workspace's look at one provider's tasks page (the fleet's sync fan-out). */
export interface BrowserSyncJob {
  orgId: number;
  platformId: string;
}

/**
 * Job names. The `browser.` prefix marks work that may drive Chrome: those queues are claimed
 * only by browser-capable processes (ROLE=browser, or ROLE=all), so plain workers scale
 * without carrying a browser. Everything else is claimed by core workers.
 */
export const JOB = {
  chatDeliver: "browser.chat.deliver",
  dispatchDeliver: "dispatch.deliver",
  browserDispatchDeliver: "browser.dispatch.deliver",
  taskStart: "task.start",
  runResume: "run.resume",
  browserRunResume: "browser.run.resume",
  browserOp: "browser.op",
  browserSyncPlatform: "browser.sync.platform",
} as const;

/** Which resume queue continues a parked run, by its kind. */
export function resumeJobFor(kind: string): string {
  return kind === "task" || kind === "external" ? JOB.runResume : JOB.browserRunResume;
}

/* ---------- inline engine ---------- */

type AnyHandler = (data: unknown) => Promise<void>;

/**
 * Runs each job the moment it is sent, in this process — the single-container mode. An
 * undelayed send AWAITS the handler, so today's synchronous flows keep their semantics;
 * callers that want fire-and-forget say `void queue.send(...)`. Handler errors go to the
 * wired reporter, never back to the sender: the sender's contract is "accepted", and the
 * job settles its own run — in every mode.
 *
 * Retries are deliberately NOT implemented here: inline mode is the single-container
 * deployment, where a failed attempt has already settled its own run/message in the same
 * process, and the durable sweeps (stuck messages, stuck queued runs, the parked-run
 * reconciler) are the retry path. Replaying a handler in-process on the same state that
 * just failed would mostly repeat the failure with extra noise. Delayed sends likewise do
 * not survive a restart — accepted single-process semantics, stated here so nobody relies
 * on them. singletonKey IS honoured: at most one queued/active job per key.
 */
export class InlineQueue implements Queue {
  readonly kind = "inline";
  private handlers = new Map<string, AnyHandler>();
  /** Keys of jobs delayed or executing right now — the inline mirror of pg-boss singletonKey. */
  private inFlight = new Set<string>();
  constructor(private readonly onError: (jobName: string, err: unknown) => void = () => {}) {}

  async send<T>(name: string, data: T, opts?: JobOptions): Promise<void> {
    const handler = this.handlers.get(name);
    if (!handler) {
      this.onError(name, new Error(`no handler registered for job "${name}"`));
      return;
    }
    const key = opts?.singletonKey;
    if (key !== undefined) {
      if (this.inFlight.has(key)) return; // already queued or running under this key
      this.inFlight.add(key);
    }
    const run = async () => {
      try {
        await handler(data);
      } catch (err) {
        this.onError(name, err);
      } finally {
        if (key !== undefined) this.inFlight.delete(key);
      }
    };
    if (opts?.startAfterSeconds) setTimeout(() => void run(), opts.startAfterSeconds * 1000).unref?.();
    else await run();
  }
  work<T>(name: string, handler: JobHandler<T>): void {
    this.handlers.set(name, handler as AnyHandler);
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async schedule(): Promise<void> {
    /* single process: the caller keeps its local timer */
  }
}

/* ---------- pg-boss engine ---------- */

interface BossLike {
  start(): Promise<unknown>;
  stop(opts?: { wait?: boolean; timeout?: number }): Promise<void>;
  createQueue(name: string): Promise<void>;
  send(name: string, data: object, options?: object): Promise<string | null>;
  work(name: string, options: object, handler: (jobs: { id?: string; data: unknown }[]) => Promise<void>): Promise<string>;
  schedule(name: string, cron: string, data?: object, options?: object): Promise<void>;
}

export class BossQueue implements Queue {
  readonly kind = "boss";
  private boss: BossLike | null = null;
  private pending: { name: string; handler: AnyHandler; teamSize: number }[] = [];
  private queues = new Set<string>();

  constructor(
    private readonly databaseUrl: string,
    private readonly onError: (jobName: string, err: unknown) => void = () => {},
  ) {}

  private async ensureQueue(name: string): Promise<void> {
    if (this.queues.has(name)) return;
    await this.boss!.createQueue(name);
    this.queues.add(name);
  }

  async send<T>(name: string, data: T, rawOpts: JobOptions = {}): Promise<void> {
    // A failed enqueue must never be silent: `void queue.send(...)` after an HTTP response
    // has nobody awaiting it, and a swallowed rejection here is a message stuck forever.
    try {
      if (!this.boss) throw new Error("queue not started");
      await this.ensureQueue(name);
      const opts = resolveJobOptions(name, rawOpts);
      const options: Record<string, unknown> = { retryLimit: opts.retryLimit ?? 0, expireInSeconds: opts.expireInSeconds ?? 15 * 60 };
      if (opts.singletonKey !== undefined) options.singletonKey = opts.singletonKey;
      if (opts.startAfterSeconds !== undefined) options.startAfter = opts.startAfterSeconds;
      if (opts.retryDelaySeconds !== undefined) {
        options.retryDelay = opts.retryDelaySeconds;
        options.retryBackoff = true;
      }
      if (opts.priority !== undefined) options.priority = opts.priority;
      await this.boss.send(name, data as object, options);
    } catch (err) {
      this.onError(`${name} (enqueue)`, err);
      throw err; // awaited senders still learn about it
    }
  }

  work<T>(name: string, handler: JobHandler<T>, opts: { teamSize?: number } = {}): void {
    this.pending.push({ name, handler: handler as AnyHandler, teamSize: opts.teamSize ?? 1 });
  }

  async start(): Promise<void> {
    const { PgBoss } = await import("pg-boss");
    const boss = new PgBoss({ connectionString: this.databaseUrl, schema: "pgboss" }) as unknown as BossLike;
    this.boss = boss;
    await boss.start();
    for (const { name, handler, teamSize } of this.pending) {
      await this.ensureQueue(name);
      const deadlineMs = handlerDeadlineMs(name);
      await boss.work(name, { batchSize: 1, pollingIntervalSeconds: 0.5, teamSize }, async (jobs) => {
        for (const job of jobs) {
          try {
            // The watchdog: a handler that hangs (a page that never settles, a socket that
            // never times out) would otherwise wedge this worker slot until the job expires.
            // On the deadline the attempt is ABANDONED — the promise may keep running as a
            // zombie (accepted: the delivery re-read and guarded run claims make a late
            // finisher harmless) — and the throw lets pg-boss retry per the queue's policy.
            await this.withDeadline(handler(job.data), name, job.id, deadlineMs);
          } catch (err) {
            this.onError(name, err);
            throw err; // pg-boss owns the retry/failure bookkeeping
          }
        }
      });
    }
  }

  private async withDeadline(work: Promise<void>, name: string, jobId: string | undefined, ms: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`job ${jobId ?? "?"} on queue "${name}" exceeded its ${Math.round(ms / 1000)}s handler deadline; abandoning the attempt (the handler may still be running)`)), ms);
      timer.unref?.();
    });
    try {
      await Promise.race([work, deadline]);
    } finally {
      if (timer) clearTimeout(timer);
      // The abandoned promise must not surface as an unhandled rejection when it dies later.
      work.catch(() => undefined);
    }
  }

  async stop(): Promise<void> {
    await this.boss?.stop({ wait: true, timeout: 15_000 });
  }

  async schedule(name: string, cron: string, data?: unknown): Promise<void> {
    if (!this.boss) throw new Error("queue not started");
    await this.ensureQueue(name);
    // Cron-fired jobs carry the same per-queue defaults; for cron.* that means retryLimit 0
    // (the next firing IS the retry).
    const opts = resolveJobOptions(name);
    await this.boss.schedule(name, cron, (data as object) ?? {}, { retryLimit: opts.retryLimit ?? 0 });
  }
}
