import { createHash } from 'node:crypto'
import Decimal from 'decimal.js'
import { z } from 'zod'
import type { Baseline, Effect, Position, Trade, TradeView } from '../shared/types.js'
Decimal.set({ precision: 32 })
const numeric = z.union([z.string(), z.number()]).transform(String).refine(v => {
  try { return new Decimal(v).isFinite() } catch { return false }
}, '无效数值')
const positive = numeric.refine(v => new Decimal(v).gt(0), '必须为正数')
const schema = z.object({
  symbol: z.string().regex(/^[A-Z0-9_]{2,40}$/),
  side: z.enum(['BUY', 'SELL']), positionSide: z.enum(['LONG', 'SHORT']),
  executedQty: positive, avgPrice: positive, totalPnl: numeric,
  orderTime: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  orderUpdateTime: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).passthrough()
export function normalize(raw: unknown, portfolioId: string, now: number): Trade {
  const r = schema.parse(raw)
  if (r.orderUpdateTime < r.orderTime) throw new Error('成交更新时间早于下单时间')
  const id = createHash('sha256').update(JSON.stringify([portfolioId, r.symbol, r.positionSide, r.side, r.orderTime])).digest('hex')
  return { id, portfolioId, symbol: r.symbol, side: r.side, positionSide: r.positionSide,
    qty: new Decimal(r.executedQty).toString(), price: new Decimal(r.avgPrice).toString(),
    realizedPnl: new Decimal(r.totalPnl).toString(), time: r.orderTime, updatedAt: r.orderUpdateTime,
    detectedAt: now, revision: 1, raw: r }
}
export function fingerprint(t: Trade) { return [t.qty, t.price, t.realizedPnl].join('|') }
export function uniqueTrades(trades: Trade[]): Trade[] {
  const map = new Map<string, Trade>()
  for (const t of trades) {
    const old = map.get(t.id)
    // 无订单 ID，不能可靠区分同毫秒的独立订单与累计成交更新。
    if (old && fingerprint(old) !== fingerprint(t)) throw new Error('同一查询中出现无法区分的成交记录，本次未写入')
    if (!old || t.updatedAt > old.updatedAt) map.set(t.id, t)
  }
  return [...map.values()].sort((a, b) => a.time - b.time || a.id.localeCompare(b.id))
}
export type Mark = { price: string; at: number }
export function replay(trades: Trade[], baseline: Baseline | null, marks: Map<string, Mark>, now: number) {
  const views = new Map<string, TradeView>()
  const book = new Map<string, { symbol: string; positionSide: 'LONG' | 'SHORT'; qty: Decimal; avg: Decimal }>()
  const invalid = new Set<string>()
  let warning: string | null = baseline ? null : '尚未设置期初仓位。确认完整的仓位起点后，才能推算当前持仓。'
  for (const p of baseline?.positions || []) book.set(p.symbol + '|' + p.positionSide, { ...p, qty: new Decimal(p.qty), avg: new Decimal(p.avg) })
  for (const t of [...trades].sort((a, b) => a.time - b.time || a.id.localeCompare(b.id))) {
    const { raw: _raw, ...clean } = t
    let effect: Effect = 'unknown', after: string | null = null
    if (baseline && t.time > baseline.at) {
      const key = t.symbol + '|' + t.positionSide
      const b = book.get(key) || { symbol: t.symbol, positionSide: t.positionSide, qty: new Decimal(0), avg: new Decimal(0) }
      const q = new Decimal(t.qty), price = new Decimal(t.price)
      const increases = (t.positionSide === 'LONG' && t.side === 'BUY') || (t.positionSide === 'SHORT' && t.side === 'SELL')
      if (!invalid.has(key)) {
        if (increases) {
          effect = b.qty.isZero() ? 'open' : 'add'
          b.avg = b.avg.mul(b.qty).add(price.mul(q)).div(b.qty.add(q))
          b.qty = b.qty.add(q)
        } else if (q.gt(b.qty)) {
          invalid.add(key)
          warning = '成交与期初仓位不一致（减仓超过持仓），已停止展示仓位。请重新校准。'
        } else {
          b.qty = b.qty.sub(q)
          effect = b.qty.isZero() ? 'close' : 'reduce'
          if (b.qty.isZero()) b.avg = new Decimal(0)
        }
        book.set(key, b)
        if (!invalid.has(key)) after = b.qty.toString()
      }
    }
    views.set(t.id, { ...clean, effect, after })
  }
  const reliable = !!baseline && invalid.size === 0
  const positions: Position[] = reliable ? [...book.values()].filter(b => b.qty.gt(0)).map(b => {
    const mark = marks.get(b.symbol)
    const fresh = mark && now - mark.at < 60000 && now >= mark.at - 5000
    const px = fresh ? new Decimal(mark.price) : null
    return { symbol: b.symbol, positionSide: b.positionSide, qty: b.qty.toString(), avg: b.avg.toString(),
      mark: px?.toString() ?? null, markAt: fresh ? mark.at : null,
      notional: px?.mul(b.qty).toString() ?? null,
      unrealizedPnl: px ? (b.positionSide === 'LONG' ? px.sub(b.avg) : b.avg.sub(px)).mul(b.qty).toString() : null }
  }) : []
  return { positions, reliable, warning, trades: [...views.values()].sort((a, b) => b.time - a.time || a.id.localeCompare(b.id)) }
}
export const effectNames = { open: '开仓', add: '加仓', reduce: '减仓', close: '平仓', unknown: '成交' }
export function notificationText(name: string, t: TradeView, now: number): string {
  const fmt = (ms: number) => new Date(ms).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
  return [`望潮 · ${name}｜${t.revision > 1 ? '成交更新' : effectNames[t.effect]}${now - t.time > 120000 ? '（延迟发现）' : ''}`,
    `${t.symbol} · ${t.positionSide === 'LONG' ? '多' : '空'} · ${t.side === 'BUY' ? '买入' : '卖出'}`,
    `累计成交：${t.qty}，均价：${t.price} USDT`,
    `成交时间：${fmt(t.time)}`, `检测时间：${fmt(now)}`,
    t.after === null ? '持仓尚未校准' : `推算剩余持仓：${t.after}`,
    `记录：${t.id.slice(0, 10)} / v${t.revision}`].join('\n')
}
