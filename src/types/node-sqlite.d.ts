/**
 * Minimal type declarations for the built-in `node:sqlite` module.
 * @types/node 20 predates it; we only declare the subset we use.
 * See: https://nodejs.org/api/sqlite.html
 */
declare module "node:sqlite" {
  interface StatementResultingChanges {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  }

  class StatementSync {
    run(...params: unknown[]): StatementResultingChanges;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }

  export class DatabaseSync {
    constructor(path: string, options?: { open?: boolean; readOnly?: boolean });
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
