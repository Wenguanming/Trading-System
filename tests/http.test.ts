import { afterEach, beforeEach, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { config } from '../server/config.js'
import { openDatabase, migrate, type Database } from '../server/database.js'
import { Repository } from '../server/repository.js'
import { Monitor } from '../server/service.js'
import { createApp } from '../server/http.js'
let db:Database,monitor:Monitor,app:FastifyInstance
beforeEach(async()=>{
  db=await openDatabase('','memory://');await migrate(db)
  const settings={...config,SOURCE_MODE:'demo' as const,APP_PASSWORD:'test-password-long',NOTIFY_PROVIDER:'none' as const,DATABASE_URL:''}
  monitor=new Monitor(new Repository(db),settings);await monitor.init();await monitor.sync()
  app=await createApp(monitor,settings)
})
afterEach(async()=>{await app.close();await db.close()})
async function login(){
  const result=await app.inject({method:'POST',url:'/api/login',payload:{password:'test-password-long'}})
  expect(result.statusCode).toBe(200)
  return result.cookies.map(c=>c.name+'='+c.value).join('; ')
}
it('未登录无法读取快照、SSE 或操作通知',async()=>{
  for(const url of ['/api/snapshot','/api/events','/api/export','/api/positions/history','/api/positions/export']){
    expect((await app.inject({url})).statusCode).toBe(401)
  }
  expect((await app.inject({method:'POST',url:'/api/notifications/test',payload:{}})).statusCode).toBe(401)
})
it('签名 Cookie 登录后返回真实快照；登出清除 Cookie',async()=>{
  const cookie=await login()
  const result=await app.inject({url:'/api/snapshot',headers:{cookie}})
  expect(result.statusCode).toBe(200);expect(result.json().stats.totalTrades).toBe(4)
  expect(result.json().mode).toBe('demo')
  expect((await app.inject({method:'POST',url:'/api/logout',headers:{cookie},payload:{}})).cookies[0].value).toBe('')
})
it('拒绝跨站写操作和未确认的仓位校准',async()=>{
  const cookie=await login()
  expect((await app.inject({method:'POST',url:'/api/pause',headers:{cookie,origin:'https://example.com'},payload:{paused:true}})).statusCode).toBe(403)
  expect((await app.inject({method:'POST',url:'/api/baseline',headers:{cookie},payload:{baseline:null}})).statusCode).toBe(400)
})
it('分页筛选和 CSV 导出可用，密钥不会出现在状态中',async()=>{
  const cookie=await login()
  const result=await app.inject({url:'/api/trades?symbol=BTC&page=2&limit=2',headers:{cookie}})
  expect(result.json().total).toBe(4);expect(result.json().items).toHaveLength(2)
  const exported=await app.inject({url:'/api/export',headers:{cookie}})
  expect(exported.headers['content-type']).toContain('text/csv')
  expect(exported.body).toContain('BTCUSDT')
  expect((await app.inject({url:'/api/snapshot',headers:{cookie}})).body).not.toContain('test-password-long')
})
it('采集失败保留已保存的数据和水位，不回退为空仓',async()=>{
  const before=await monitor.snapshot()
  monitor.source={fetchTrades:async()=>{throw new Error('simulated network failure')},fetchMarks:async()=>new Map()}
  await monitor.sync()
  const after=await monitor.snapshot()
  expect(after.health.lastSuccess).toBe(before.health.lastSuccess)
  expect(after.stats.totalTrades).toBe(4)
  expect(after.health.error).toBe('simulated network failure')
  expect(after.health.nextPoll!).toBeGreaterThan(Date.now())
})

it('同步期间不允许并发暂停，避免水位提交覆盖暂停状态',async()=>{
  monitor.polling=true
  await expect(monitor.pause(true)).rejects.toThrow('本轮同步')
  monitor.polling=false
  await monitor.pause(true)
  expect((await monitor.repo.health()).paused).toBe(true)
})

it('仓位记录按品种日期查询并导出，快照包含计算依据',async()=>{
  const cookie=await login()
  const result=await app.inject({url:'/api/positions/history?symbol=BTCUSDT&limit=1',headers:{cookie}})
  expect(result.statusCode).toBe(200)
  expect(result.json().items[0].positions[0].qty).toBe('28.099')
  expect(result.json().items[0].tradeRevision).toHaveLength(64)
  const exported=await app.inject({url:'/api/positions/export?symbol=BTCUSDT',headers:{cookie}})
  expect(exported.headers['content-type']).toContain('text/csv')
  expect(exported.body).toContain('roi_percent_estimate')
  expect(exported.body).toContain('28.099')
  expect((await app.inject({url:'/api/positions/history?from=1&to=2',headers:{cookie}})).json().total).toBe(0)
})
it('单仓位校准拒绝空列表与非法杠杆，支持未知可选字段',async()=>{
  const cookie=await login()
  const at=monitor.health.lastSuccess!
  const send=(positions:unknown[])=>app.inject({method:'POST',url:'/api/baseline',headers:{cookie},payload:{confirmed:true,baseline:{at,scope:'selected',positions}}})
  expect((await send([])).statusCode).toBe(400)
  const seed={symbol:'BTCUSDT',positionSide:'SHORT',qty:'28.099',avg:'64354.45'}
  expect((await send([{...seed,leverage:'201'}])).statusCode).toBe(400)
  expect((await send([seed])).statusCode).toBe(200)
  expect((await monitor.snapshot()).positionScope).toBe('selected')
  expect((await monitor.snapshot()).positions[0].leverage).toBeNull()
})
