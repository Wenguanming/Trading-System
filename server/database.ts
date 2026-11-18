import { mkdir } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import pg from 'pg'
export interface Sql {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>
}
export interface Database extends Sql {
  transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T>
  close(): Promise<void>
}
export async function openDatabase(url: string, path: string): Promise<Database> {
  if (url) {
    const pool = new pg.Pool({ connectionString: url, max: 5 })
    return {
      query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await pool.query(sql, params)).rows as T[] }),
      transaction: async fn => {
        const c = await pool.connect()
        try {
          await c.query('BEGIN')
          const result = await fn({ query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await c.query(sql, params)).rows as T[] }) })
          await c.query('COMMIT'); return result
        } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
      },
      close: () => pool.end(),
    }
  }
  if (path !== 'memory://') await mkdir(path, { recursive: true, mode: 0o700 })
  const db = new PGlite(path)
  await db.waitReady
  return {
    query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await db.query<T>(sql, params)).rows }),
    transaction: fn => db.transaction(tx => fn({ query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await tx.query<T>(sql, params)).rows }) })),
    close: () => db.close(),
  }
}
export async function migrate(db: Database) {
  const statements = [
    'CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value JSONB NOT NULL)',
    'CREATE TABLE IF NOT EXISTS trades (id TEXT PRIMARY KEY, time BIGINT NOT NULL, symbol TEXT NOT NULL, payload JSONB NOT NULL)',
    'CREATE INDEX IF NOT EXISTS trades_time ON trades(time DESC)',
    'CREATE TABLE IF NOT EXISTS trade_versions (id TEXT NOT NULL, revision INTEGER NOT NULL, observed_at BIGINT NOT NULL, payload JSONB NOT NULL, PRIMARY KEY(id, revision))',
    "CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, body TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, due_at BIGINT NOT NULL, created_at BIGINT NOT NULL, sent_at BIGINT, error TEXT)",
    'CREATE INDEX IF NOT EXISTS notifications_due ON notifications(status, due_at)',
  ]
  for (const sql of statements) await db.query(sql)
}
export async function state<T>(db: Sql, key: string, fallback: T): Promise<T> {
  const result = await db.query<{ value: T }>('SELECT value FROM app_state WHERE key=$1', [key])
  return result.rows[0]?.value ?? fallback
}
export async function setState(db: Sql, key: string, value: unknown) {
  await db.query('INSERT INTO app_state(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [key, JSON.stringify(value)])
}
