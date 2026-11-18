import type { Baseline, Health, Trade } from '../shared/types.js'
import type { Database } from './database.js'
import { setState, state } from './database.js'
import { fingerprint, notificationText, replay } from './domain.js'
export const emptyHealth: Health = { initialized: false, paused: false, lastAttempt: null, lastSuccess: null, coverageStart: null, failures: 0, error: null, nextPoll: null }
export class Repository {
  constructor(readonly db: Database) {}
  async trades() { return (await this.db.query<{ payload: Trade }>('SELECT payload FROM trades ORDER BY time ASC,id ASC')).rows.map(r => r.payload) }
  health() { return state(this.db, 'health', { ...emptyHealth }) }
  baseline() { return state<Baseline | null>(this.db, 'baseline', null) }
  async initializeIdentity(portfolio: string, mode: string) {
    const expected = { portfolio, mode }
    const current = await state<typeof expected | null>(this.db, 'identity', null)
    if (current && (current.portfolio !== portfolio || current.mode !== mode)) throw new Error('数据库属于另一个交易员或模式，请更换 DATA_DIR / DATABASE_URL')
    await setState(this.db, 'identity', expected)
  }
  async ingest(input: Trade[], health: Health, name: string, notify: boolean, now: number) {
    return this.db.transaction(async tx => {
      const previous = await state(tx, 'health', { ...emptyHealth })
      const changed: Trade[] = []
      for (const t of input) {
        const old = (await tx.query<{ payload: Trade }>('SELECT payload FROM trades WHERE id=$1', [t.id])).rows[0]?.payload
        if (old && t.updatedAt < old.updatedAt) continue
        if (old && fingerprint(old) === fingerprint(t)) {
          if (t.updatedAt > old.updatedAt) await tx.query('UPDATE trades SET payload=$2::jsonb WHERE id=$1', [t.id, JSON.stringify({ ...old, updatedAt: t.updatedAt, raw: t.raw })])
          continue
        }
        if (old && t.updatedAt === old.updatedAt) throw new Error('相同时间戳的成交内容冲突，本次同步已回滚')
        const updated = { ...t, revision: (old?.revision ?? 0) + 1 }
        await tx.query('INSERT INTO trades(id,time,symbol,payload) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload', [t.id, t.time, t.symbol, JSON.stringify(updated)])
        await tx.query('INSERT INTO trade_versions(id,revision,observed_at,payload) VALUES($1,$2,$3,$4::jsonb)', [t.id, updated.revision, now, JSON.stringify(updated)])
        changed.push(updated)
      }
      const all = (await tx.query<{ payload: Trade }>('SELECT payload FROM trades ORDER BY time ASC,id ASC')).rows.map(r => r.payload)
      const view = replay(all, await state<Baseline | null>(tx, 'baseline', null), new Map(), now)
      const byId = new Map(view.trades.map(t => [t.id, t]))
      if (previous.initialized) {
        for (const t of changed) await tx.query('INSERT INTO notifications(id,body,status,due_at,created_at) VALUES($1,$2,$3,$4,$4) ON CONFLICT(id) DO NOTHING',
          [t.id + ':' + t.revision, notificationText(name, byId.get(t.id)!, now), notify ? 'pending' : 'skipped', now])
      }
      await setState(tx, 'health', health)
      return changed.length
    })
  }
  async notificationStats() {
    const rows = await this.db.query<{ status: string; count: string }>('SELECT status,COUNT(*) AS count FROM notifications GROUP BY status')
    const counts = Object.fromEntries(rows.rows.map(r => [r.status, Number(r.count)]))
    const err = await this.db.query<{ error: string }>("SELECT error FROM notifications WHERE status IN ('pending','failed') AND error IS NOT NULL ORDER BY created_at DESC LIMIT 1")
    const last = await this.db.query<{ sent: string | null }>('SELECT MAX(sent_at) AS sent FROM notifications')
    return { pending: (counts.pending || 0) + (counts.sending || 0), failed: counts.failed || 0, sent: counts.sent || 0,
      lastError: err.rows[0]?.error ?? null, lastSentAt: last.rows[0]?.sent ? Number(last.rows[0].sent) : null }
  }
}
