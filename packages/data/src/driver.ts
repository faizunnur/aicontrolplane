/*
  The one seam between the data functions and an engine. Every data function speaks this
  interface with `?` placeholders and engine-neutral SQL (TEXT ISO timestamps, INTEGER 0/1
  booleans, RETURNING id on inserts); the drivers translate. Keeping the stored types
  identical across engines is deliberate: the Postgres cutover changes where rows live,
  not what they mean. Type modernization (timestamptz, boolean) is a later, PG-only step.
*/

export interface RunResult {
  changes: number;
}

export interface SqlDriver {
  readonly kind: "sqlite" | "pg";
  all<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T = unknown>(sql: string, params?: unknown[]): Promise<T | undefined>;
  run(sql: string, params?: unknown[]): Promise<RunResult>;
  /** Multi-statement DDL. */
  exec(sql: string): Promise<void>;
  /** Everything inside fn shares one transaction; queries made during fn are routed to it. */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  /** Applied schema migrations, oldest first. */
  schemaVersion(): Promise<{ id: number; name: string; applied_at: string }[]>;
  close(): Promise<void>;
}
