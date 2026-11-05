/** The small slice of a Postgres client that server code depends on. */
export interface Queryable {
  /** One statement, with $1-style parameters. */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** One or more statements, no parameters (used for migrations). */
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  /** Runs fn inside BEGIN/COMMIT; rolls back and rethrows if fn throws. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}
