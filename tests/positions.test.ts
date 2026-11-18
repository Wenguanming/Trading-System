import { afterEach, beforeEach, expect, it } from 'vitest'
import { normalizeAccount, normalizePosition, buildPositionSnapshot } from '../server/positions.js'
import { BinanceSource } from '../server/source.js'
import { normalize, replay } from '../server/domain.js'
import { openDatabase, migrate, type Database } from '../server/database.js'
import { Repository } from '../server/repository.js'
import { Monitor } from '../server/service.js'
import { config } from '../server/config.js'
import type { PositionSnapshot } from '../shared/types.js'
let db: Database, monitor: Monitor
beforeEach(async () => {
  db = await openDatabase('', 'memory://'); await migrate(db)
  monitor = new Monitor(new Repository(db), { ...config, SOURCE_MODE: 'demo', NOTIFY_PROVIDER: 'none' })
  await monitor.init(); await monitor.sync()
})
afterEach(async () => { await monitor.stop(); await db.close() })
const seed = { symbol: 'BTCUSDT', positionSide: 'SHORT' as const, qty: '28.099', avg: '64354.451976251467', leverage: '10', marginMode: 'CROSS' as const }
it('单仓位校准只跟踪所填方向，截图 ROI 使用十进制且不虚构强平价', () => {
  const other = normalize({ symbol: 'ETHUSDT', side: 'SELL', positionSide: 'LONG', executedQty: '100', avgPrice: '2000', totalPnl: '0', orderTime: 100, orderUpdateTime: 100 }, 'trader', 1000)
  const v = replay([other], { at: 99, scope: 'selected', positions: [seed] }, new Map([['BTCUSDT', { price: '64678', at: 1000 }]]), 1000)
  expect(v.reliable).toBe(true)
  expect(v.trades[0].after).toBeNull()
  expect(v.positions).toHaveLength(1)
  expect(Number(v.positions[0].roi)).toBeCloseTo(-5.002443, 5)
  expect(v.positions[0].liquidationPrice).toBeNull()
  expect(v.positions[0].metadataSource).toBe('manual')
})
it('平仓后重开不沿用之前手动确认的杠杆与模式', () => {
  const trade = (side: string, time: number) => normalize({ symbol: 'BTCUSDT', side, positionSide: 'SHORT', executedQty: '28.099', avgPrice: '64000', totalPnl: '0', orderTime: time, orderUpdateTime: time }, 'trader', 1000)
  const v = replay([trade('BUY', 100), trade('SELL', 200)], { at: 99, scope: 'selected', positions: [seed] }, new Map(), 1000)
  expect(v.positions[0].leverage).toBeNull()
  expect(v.positions[0].marginMode).toBeNull()
})
it('隐藏持仓时不请求受限仓位，不把空列表当作空仓', async () => {
  const urls: string[] = []
  const source = new BinanceSource('5075281354358777856', async url => {
    urls.push(String(url))
    return new Response(JSON.stringify({ code: '000000', success: true, data: { positionShow: false, marginBalance: '356314.68', initInvestAsset: 'USDT' } }))
  }, 0)
  const observation = await source.fetchObservation()
  expect(urls).toHaveLength(1)
  expect(observation.visibility).toBe('hidden')
  expect(observation.positions).toBeNull()
  expect(normalizeAccount({ marginBalance: '10' }, 1000).visibility).toBe('unknown')
})
it('公开空仓和隐藏状态不同；上游不完整仓位整批拒绝', async () => {
  let positions: unknown[] = []
  const source = new BinanceSource('5075281354358777856', async url => new Response(JSON.stringify({
    code: '000000', success: true, data: String(url).includes('/detail?') ? { positionShow: true } : positions,
  })), 0)
  expect((await source.fetchObservation()).positions).toEqual([])
  positions = [{ symbol: 'BTCUSDT', positionAmount: '2' }]
  await expect(source.fetchObservation()).rejects.toThrow()
})
it('公开净持仓按数量符号确定方向，使用上游强平价且拒绝 NaN', () => {
  const raw = { symbol: 'BTCUSDT', positionSide: 'BOTH', positionAmount: '-2', entryPrice: '100', markPrice: '110', unrealizedProfit: '-20', leverage: '10', isolated: false, liquidationPrice: '180' }
  expect(normalizePosition(raw, 1000)).toMatchObject({ positionSide: 'SHORT', qty: '2', marginMode: 'CROSS', liquidationPrice: '180' })
  expect(() => normalizePosition({ ...raw, unrealizedProfit: 'NaN' }, 1000)).toThrow()
})
it('记录持久保存，重复同步不增加快照，重新校准不改写旧快照', async () => {
  const before = await monitor.repo.latestPositionSnapshot()
  expect(before?.positions[0].qty).toBe('28.099')
  const firstCount = (await monitor.repo.positionHistory({ page: 1, limit: 100 })).total
  await monitor.sync()
  expect((await monitor.repo.positionHistory({ page: 1, limit: 100 })).total).toBe(firstCount)
  await monitor.setBaseline({ at: monitor.health.lastSuccess!, scope: 'selected', positions: [seed] })
  const stored = (await monitor.repo.positionHistory({ page: 1, limit: 100 })).items
  expect(stored.find(s => s.id === before!.id)).toEqual(before)
  expect(stored.some(s => s.reason === 'calibration')).toBe(true)
  const restarted = new Monitor(new Repository(db), { ...config, SOURCE_MODE: 'demo', NOTIFY_PROVIDER: 'none' })
  await restarted.init()
  expect((await restarted.snapshot()).positionRecording.lastAt).toBe(stored[0].observedAt)
  expect((await restarted.repo.positionHistory({ page: 1, limit: 10, symbol: 'BTCUSDT' })).total).toBeGreaterThan(0)
  expect((await restarted.repo.positionHistory({ page: 1, limit: 10, symbol: 'ETHUSDT' })).total).toBe(0)
  await restarted.stop()
})
it('全平产生零仓位记录；权限错误或校准范围改变不产生假平仓', async () => {
  const previous = (await monitor.repo.latestPositionSnapshot())!
  const input: Omit<PositionSnapshot, 'id' | 'closed'> = { ...previous, observedAt: previous.observedAt + 1, positions: [] }
  const closed = buildPositionSnapshot(input, previous)
  expect(closed.closed).toEqual([{ symbol: 'BTCUSDT', positionSide: 'SHORT', qty: '0' }])
  expect(buildPositionSnapshot({ ...input, reliable: false }, previous).closed).toEqual([])
  expect(buildPositionSnapshot({ ...input, scope: 'selected' }, previous).closed).toEqual([])
  await monitor.repo.savePositionSnapshot(closed)
  expect((await monitor.repo.positionHistory({ page: 1, limit: 1, symbol: 'BTCUSDT' })).items[0].closed).toHaveLength(1)
})
it('行情中断时保存的是未知浮盈，不用过期价格回填', async () => {
  monitor.marks.set('BTCUSDT', { price: '100000', at: Date.now() - 120000 })
  await monitor.recordPositions('calibration')
  const last = await monitor.repo.latestPositionSnapshot()
  expect(last!.positions[0].mark).toBeNull()
  expect(last!.positions[0].unrealizedPnl).toBeNull()
})
it('仓位数据失败保留上一份观察和真实错误，并从已校准成交继续推算', async () => {
  monitor.observation = { observedAt: Date.now(), marginBalance: '10', asset: 'USDT', visibility: 'public', positions: [] }
  monitor.source.fetchObservation = async () => { throw new Error('HTTP 403') }
  await monitor.refreshObservation()
  const snapshot = await monitor.snapshot()
  expect(snapshot.positionFeed.error).toBe('HTTP 403')
  expect(snapshot.account?.marginBalance).toBe('10')
  expect(snapshot.positionSource).toBe('reconstructed')
  expect(snapshot.positions[0].qty).toBe('28.099')
})
