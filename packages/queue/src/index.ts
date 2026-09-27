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

export type JobHandler<T> = (data: T) => Promise<void>;

export interface Queue {
  readonly kind: "inline" | "boss";
  send<T>(name: string, data: T, opts?: JobOptions): Promise<void>;
  /** Register the handler for a job name. In split mode only worker processes call this. */
  work<T>(name: string, handler: JobHandler<T>, opts?: { teamSize?: number }): void;
  /** Boss mode: connect and begin claiming. Inline mode: no-op. */
  start(): Promise<void>;
  stop(): Promise<void>;
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
 */
export class InlineQueue implements Queue {
  readonly kind = "inline";
  private handlers = new Map<string, AnyHandler>();
  constructor(private readonly onError: (jobName: string, err: unknown) => void = () => {}) {}

  async send<T>(name: string, data: T, opts?: JobOptions): Promise<void> {
    const handler = this.handlers.get(name);
    if (!handler) {
      this.onError(name, new Error(`no handler registered for job "${name}"`));
      return;
    }
    const run = async () => {
      try {
        await handler(data);
      } catch (err) {
        this.onError(name, err);
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
}

/* ---------- pg-boss engine ---------- */

interface BossLike {
  start(): Promise<unknown>;
  stop(opts?: { wait?: boolean; timeout?: number }): Promise<void>;
  createQueue(name: string): Promise<void>;
  send(name: string, data: object, options?: object): Promise<string | null>;
  work(name: string, options: object, handler: (jobs: { data: unknown }[]) => Promise<void>): Promise<string>;
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

  async send<T>(name: string, data: T, opts: JobOptions = {}): Promise<void> {
    if (!this.boss) throw new Error("queue not started");
    await this.ensureQueue(name);
    const options: Record<string, unknown> = { retryLimit: opts.retryLimit ?? 0, expireInSeconds: opts.expireInSeconds ?? 15 * 60 };
    if (opts.singletonKey !== undefined) options.singletonKey = opts.singletonKey;
    if (opts.startAfterSeconds !== undefined) options.startAfter = opts.startAfterSeconds;
    if (opts.retryDelaySeconds !== undefined) {
      options.retryDelay = opts.retryDelaySeconds;
      options.retryBackoff = true;
    }
    if (opts.priority !== undefined) options.priority = opts.priority;
    await this.boss.send(name, data as object, options);
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
      await boss.work(name, { batchSize: 1, pollingIntervalSeconds: 0.5, teamSize }, async (jobs) => {
        for (const job of jobs) {
          try {
            await handler(job.data);
          } catch (err) {
            this.onError(name, err);
            throw err; // pg-boss owns the retry/failure bookkeeping
          }
        }
      });
    }
  }

  async stop(): Promise<void> {
    await this.boss?.stop({ wait: true, timeout: 15_000 });
  }
}
