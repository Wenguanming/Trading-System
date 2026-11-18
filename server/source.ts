import Decimal from 'decimal.js'
import { normalize, uniqueTrades, type Mark } from './domain.js'
import { normalizeAccount, normalizePosition } from './positions.js'
import type { AccountObservation, Trade } from '../shared/types.js'
export interface Source {
  fetchTrades(from: number, to: number): Promise<Trade[]>
  fetchObservation?(): Promise<AccountObservation>
  fetchMarks(symbols: string[]): Promise<Map<string, Mark>>
}
export type Fetcher = typeof fetch
export class BinanceSource implements Source {
  private lastRequest = 0
  private queue = Promise.resolve()
  private bapi<T>(path: string, init: RequestInit = {}): Promise<T> {
    const result = this.queue.then(async () => {
      const wait = Math.max(0, this.minimumGap - (Date.now() - this.lastRequest))
      if (wait) await new Promise(resolve => setTimeout(resolve, wait))
      this.lastRequest = Date.now()
      const response = await this.request('https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/' + path,
        { ...init, headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, signal: AbortSignal.timeout(12000) })
      if (!response.ok) throw new Error(`币安接口 HTTP ${response.status}，稍后自动重试`)
      const body = await response.json() as { code?: string; success?: boolean; data?: T }
      if (body.code === '11012005') throw new Error('币安接口暂忙（11012005），已停止本轮请求并自动退避')
      if (body.code !== '000000' || body.success === false || body.data == null) throw new Error('币安接口格式或权限发生变化，本次未导入')
      return body.data
    })
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }
  async fetchObservation(): Promise<AccountObservation> {
    const detail = await this.bapi<unknown>('lead-portfolio/detail?portfolioId=' + this.portfolioId)
    const observation = normalizeAccount(detail, Date.now())
    // Hidden/unspecified visibility is never interpreted as an empty account.
    if (observation.visibility !== 'public') return observation
    const rows = await this.bapi<unknown>('lead-data/positions?portfolioId=' + this.portfolioId)
    if (!Array.isArray(rows)) throw new Error('币安当前仓位格式异常')
    observation.observedAt = Date.now()
    observation.positions = rows.map(r => normalizePosition(r, observation.observedAt)).filter(p => new Decimal(p.qty).gt(0))
    if (new Set(observation.positions.map(p => p.symbol + p.positionSide)).size !== observation.positions.length) throw new Error('币安当前仓位存在重复品种与方向')
    return observation
  }
  constructor(readonly portfolioId: string, readonly request: Fetcher = fetch, readonly minimumGap = 6000) {}
  async fetchTrades(from: number, to: number): Promise<Trade[]> {
    const all: Trade[] = []
    // 每个窗口最多七天；请求间隔至少六秒，完整分页成功后才推进水位。
    for (let start = from; start <= to; start += 7 * 86400000 + 1) {
      const end = Math.min(start + 7 * 86400000, to)
      let cursor: string | number | undefined, ended = false, fetched = 0
      const cursors = new Set<string>()
      for (let page = 0; page < 100; page++) {
        const data = await this.bapi<{ list?: unknown[]; total?: number; indexValue?: string | number }>('lead-portfolio/order-history', {
          method: 'POST', body: JSON.stringify({ portfolioId: this.portfolioId, startTime: start, endTime: end, pageSize: 50, ...(cursor === undefined ? {} : { indexValue: cursor }) }),
        })
        if (!Array.isArray(data.list)) throw new Error('币安成交接口格式或权限发生变化，本次未导入')
        const rows = data.list.map(r => normalize(r, this.portfolioId, Date.now()))
        if (rows.some(r => r.time < start || r.time > end)) throw new Error('成交接口返回了查询范围外的数据，需检查上游接口')
        all.push(...rows); fetched += rows.length
        if (data.total != null && Number.isFinite(Number(data.total)) && fetched >= Number(data.total)) { ended = true; break }
        const next = data.indexValue
        const hasNext = next !== undefined && next !== null && String(next) !== '-1' && String(next) !== '0' && String(next) !== ''
        if (!hasNext) {
          if (data.total != null && Number(data.total) > fetched) throw new Error('成交分页缺少游标，未推进采集水位')
          ended = true; break
        }
        if (!rows.length || cursors.has(String(next))) throw new Error('成交分页游标未推进，未导入不完整结果')
        cursors.add(String(next)); cursor = next
      }
      if (!ended) throw new Error('成交分页超过保护上限，需缩小查询窗口')
    }
    return uniqueTrades(all)
  }
  async fetchMarks(symbols: string[]): Promise<Map<string, Mark>> {
    const result = new Map<string, Mark>()
    if (!symbols.length) return result
    const response = await this.request('https://fapi.binance.com/fapi/v1/premiumIndex', { signal: AbortSignal.timeout(10000) })
    if (!response.ok) throw new Error(`合约标记价格 HTTP ${response.status}`)
    const data = await response.json() as { symbol: string; markPrice: string; time: number }[]
    if (!Array.isArray(data)) throw new Error('合约标记价格格式异常')
    const selected = new Set(symbols)
    for (const r of data) {
      if (!selected.has(r.symbol)) continue
      const px = new Decimal(r.markPrice)
      if (px.isFinite() && px.gt(0) && Number.isFinite(r.time)) result.set(r.symbol, { price: px.toString(), at: Number(r.time) })
    }
    return result
  }
}
export class DemoSource implements Source {
  constructor(readonly portfolioId: string, readonly started: number) {}
  async fetchTrades(from: number, to: number) {
    const specs = [
      { offset: 0, qty: '8.491', price: '64345.38545' },
      { offset: 5000, qty: '8.489', price: '64345.4' },
      { offset: 136000, qty: '3.108', price: '64343.3' },
      { offset: 149000, qty: '8.011', price: '64377.98043' },
    ]
    return specs.map(s => normalize({ symbol: 'BTCUSDT', side: 'SELL', positionSide: 'SHORT', executedQty: s.qty,
      avgPrice: s.price, totalPnl: '0', orderTime: this.started + s.offset, orderUpdateTime: this.started + s.offset }, this.portfolioId, Date.now()))
      .filter(t => t.time >= from && t.time <= to)
  }
  async fetchMarks(symbols: string[]) {
    return new Map(symbols.map(s => [s, { price: '64678', at: Date.now() }]))
  }
}
