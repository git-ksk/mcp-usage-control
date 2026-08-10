declare module 'cloudflare:workers' {
  export type SqlStorageValue = ArrayBuffer | string | number | null;

  export interface SqlStorageCursor<T extends Record<string, SqlStorageValue>> extends Iterable<T> {
    toArray(): T[];
    one(): T;
  }

  export interface DurableObjectSqlStorage {
    exec<T extends Record<string, SqlStorageValue> = Record<string, SqlStorageValue>>(
      query: string,
      ...bindings: SqlStorageValue[]
    ): SqlStorageCursor<T>;
  }

  export interface DurableObjectStorage {
    readonly sql: DurableObjectSqlStorage;
    transactionSync<T>(callback: () => T): T;
  }

  export interface DurableObjectState {
    readonly storage: DurableObjectStorage;
  }

  export class DurableObject<Env = unknown> {
    protected readonly ctx: DurableObjectState;
    protected readonly env: Env;
    constructor(ctx: DurableObjectState, env: Env);
  }
}
