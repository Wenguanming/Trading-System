import { createHash, randomUUID } from 'node:crypto'
import Decimal from 'decimal.js'
import { z } from 'zod'
import type { AccountObservation, Baseline, PositionDetails, PositionSnapshot, Trade } from '../shared/types.js'
const finite = z.union([z.string(), z.number()]).transform(String).refine(v => {
  try { return new Decimal(v).isFinite() } catch { return false }
})
const positive = finite.refine(v => new Decimal(v).gt(0))
const rowSchema = z.object({
  symbol: z.string().regex(/^[A-Z0-9_]{2,40}USDT$/),
  positionSide: z.enum(['LONG', 'SHORT', 'BOTH']),
  positionAmount: finite, entryPrice: finite, markPrice: positive,
  leverage: positive.nullish(), isolated: z.boolean().nullish(),
  unrealizedProfit: finite, liquidationPrice: finite.nullish(),
})
export function normalizePosition(value: unknown, observedAt: number): PositionDetails {
  const r = rowSchema.parse(value)
  const qty = new Decimal(r.positionAmount).abs(), mark = new Decimal(r.markPrice)
  if (qty.gt(0) && new Decimal(r.entryPrice).lte(0)) throw new Error('仓位开仓均价无效')
  const notional = mark.mul(qty)
  const side = r.positionSide === 'BOTH' ? (new Decimal(r.positionAmount).isNegative() ? 'SHORT' : 'LONG') : r.positionSide
  return { symbol: r.symbol, positionSide: side, qty: qty.toString(), avg: r.entryPrice,
    mark: r.markPrice, markAt: observedAt, notional: notional.toString(), unrealizedPnl: r.unrealizedProfit,
    leverage: r.leverage ?? null, marginMode: r.isolated == null ? null : r.isolated ? 'ISOLATED' : 'CROSS',
    liquidationPrice: r.liquidationPrice && new Decimal(r.liquidationPrice).gt(0) ? r.liquidationPrice : null,
    roi: r.leverage && notional.gt(0) ? new Decimal(r.unrealizedProfit).div(notional.div(r.leverage)).mul(100).toString() : null,
    metadataSource: 'binance' }
}
export function normalizeAccount(value: unknown, observedAt: number): AccountObservation {
  const r = z.object({ positionShow: z.boolean().optional(), marginBalance: finite.nullish(), initInvestAsset: z.string().max(20).nullish() }).parse(value)
  return { observedAt, visibility: r.positionShow === true ? 'public' : r.positionShow === false ? 'hidden' : 'unknown',
    marginBalance: r.marginBalance ?? null, asset: r.initInvestAsset ?? null, positions: null }
}
export function tradeRevision(trades: Trade[]) {
  return createHash('sha256').update(JSON.stringify(trades.map(t => [t.id, t.revision]).sort())).digest('hex')
}
export function positionSignature(s: Pick<PositionSnapshot, 'source' | 'scope' | 'reliable' | 'warning' | 'baseline' | 'tradeRevision' | 'positions' | 'account'>) {
  // Price-only changes are sampled once a minute. Quantity/cost/revision changes are retained immediately.
  return JSON.stringify([s.source, s.scope, s.reliable, s.warning, s.baseline, s.tradeRevision, s.account?.visibility,
    s.positions.map(p => [p.symbol, p.positionSide, p.qty, p.avg, p.leverage, p.marginMode]).sort()])
}
export function buildPositionSnapshot(
  input: Omit<PositionSnapshot, 'id' | 'closed'>, previous: PositionSnapshot | null,
): PositionSnapshot {
  const sameBasis = previous?.source === input.source && previous?.scope === input.scope &&
    JSON.stringify(previous.baseline) === JSON.stringify(input.baseline)
  const keys = new Set(input.positions.map(p => p.symbol + p.positionSide))
  const closed = input.reliable && previous?.reliable && sameBasis
    ? previous.positions.filter(p => !keys.has(p.symbol + p.positionSide)).map(p => ({ symbol: p.symbol, positionSide: p.positionSide, qty: '0' as const })) : []
  return { ...input, id: randomUUID(), closed }
}
