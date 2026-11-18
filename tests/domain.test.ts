import { describe, expect, it } from 'vitest'
import { normalize, replay, uniqueTrades } from '../server/domain.js'
const row = (qty: string, price: string, time: number, side = 'SELL', positionSide = 'SHORT') =>
  normalize({ symbol: 'BTCUSDT', side, positionSide, executedQty: qty, avgPrice: price, totalPnl: '0', orderTime: time, orderUpdateTime: time }, '5075281354358777856', 100000)
describe('仓位重建', () => {
  it('按真实四笔成交精确重建截图中的仓位与浮盈', () => {
    const trades = [row('8.491','64345.38545',100),row('8.489','64345.4',200),row('3.108','64343.3',300),row('8.011','64377.98043',400)]
    const view = replay(trades, { at: 99, positions: [] }, new Map([['BTCUSDT', { price:'64678', at:1000 }]]), 1000)
    expect(view.reliable).toBe(true)
    expect(view.positions[0].qty).toBe('28.099')
    expect(Number(view.positions[0].avg)).toBeCloseTo(64354.451976,6)
    expect(Number(view.positions[0].unrealizedPnl)).toBeCloseTo(-9091.37591932,6)
    expect(view.trades.map(t=>t.effect)).toEqual(['add','add','add','open'])
  })
  it('初始仓位未知时不会把成交误标成开仓、平仓', () => {
    const v = replay([row('2','10',100)], null, new Map(), 1000)
    expect(v.positions).toHaveLength(0); expect(v.reliable).toBe(false); expect(v.trades[0].effect).toBe('unknown')
  })
  it('减仓保持成本，全部平仓清空，超量减仓停止推算', () => {
    const base = { at: 99, positions: [] }
    const trades = [row('2','10',100),row('1','9',200,'BUY')]
    expect(replay(trades,base,new Map(),1000).positions[0].avg).toBe('10')
    expect(replay([...trades,row('1','8',300,'BUY')],base,new Map(),1000).positions).toHaveLength(0)
    expect(replay([...trades,row('2','8',300,'BUY')],base,new Map(),1000).reliable).toBe(false)
  })
  it('过期标记价格不产生看似最新的浮盈', () => {
    const v = replay([row('2','10',100)],{at:99,positions:[]},new Map([['BTCUSDT',{price:'9',at:1000}]]),62000)
    expect(v.positions[0].unrealizedPnl).toBeNull()
  })
  it('去除完全重复记录，遇到同毫秒冲突拒绝导入', () => {
    expect(uniqueTrades([row('2','10',100),row('2','10',100)])).toHaveLength(1)
    expect(()=>uniqueTrades([row('2','10',100),row('3','10',100)])).toThrow('无法区分')
  })
  it('拒绝非数字与不支持的净持仓模式', () => {
    expect(()=>row('NaN','10',100)).toThrow()
    expect(()=>row('2','10',100,'SELL','BOTH')).toThrow()
  })
})
