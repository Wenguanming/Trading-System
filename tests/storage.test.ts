import { afterEach, beforeEach, expect, it } from 'vitest'
import { openDatabase, migrate, type Database } from '../server/database.js'
import { Repository, emptyHealth } from '../server/repository.js'
import { normalize } from '../server/domain.js'
import { Notifier } from '../server/notifications.js'
let db: Database, repo: Repository
beforeEach(async()=>{db=await openDatabase('','memory://');await migrate(db);repo=new Repository(db)})
afterEach(async()=>{await db.close()})
const trade=(qty:string,time:number,updated=time)=>normalize({symbol:'BTCUSDT',side:'SELL',positionSide:'SHORT',executedQty:qty,avgPrice:'100',totalPnl:'0',orderTime:time,orderUpdateTime:updated},'5075281354358777856',Date.now())
const health={...emptyHealth,initialized:true,lastSuccess:1000,coverageStart:1}
it('首次导入不通知，重启和重复查询不产生重复记录或通知',async()=>{
  await repo.ingest([trade('1',100)],health,'测试',true,Date.now())
  expect((await repo.notificationStats()).pending).toBe(0)
  const restarted=new Repository(db)
  await restarted.ingest([trade('1',100),trade('2',200)],health,'测试',true,Date.now())
  await restarted.ingest([trade('1',100),trade('2',200)],health,'测试',true,Date.now())
  expect(await restarted.trades()).toHaveLength(2)
  expect((await restarted.notificationStats()).pending).toBe(1)
})
it('累计成交更新修改原记录、保存版本，不重复累加；旧版本不能回滚数据',async()=>{
  await repo.ingest([trade('1',100)],health,'测试',true,Date.now())
  await repo.ingest([trade('2',100,200)],health,'测试',true,Date.now())
  await repo.ingest([trade('1',100,100)],health,'测试',true,Date.now())
  expect(await repo.trades()).toHaveLength(1)
  expect((await repo.trades())[0].qty).toBe('2')
  expect((await repo.trades())[0].revision).toBe(2)
  expect((await db.query('SELECT * FROM trade_versions')).rows).toHaveLength(2)
})
it('批次冲突整体回滚，水位和历史保持不变',async()=>{
  await repo.ingest([trade('1',100)],health,'测试',true,Date.now())
  await expect(repo.ingest([trade('1',200),trade('2',100)],{...health,lastSuccess:3000},'测试',true,Date.now())).rejects.toThrow('冲突')
  expect(await repo.trades()).toHaveLength(1)
  expect((await repo.health()).lastSuccess).toBe(1000)
})
it('无通知配置时保留 skipped 记录，之后不会突然推送旧成交',async()=>{
  await repo.ingest([trade('1',100)],health,'测试',false,Date.now())
  await repo.ingest([trade('2',200)],health,'测试',false,Date.now())
  expect((await db.query<{status:string}>('SELECT status FROM notifications')).rows[0].status).toBe('skipped')
})
it('通知失败进入退避重试，成功只发送一次',async()=>{
  await repo.ingest([trade('1',100)],health,'测试',true,Date.now())
  await repo.ingest([trade('2',200)],health,'测试',true,Date.now())
  let calls=0
  const request:typeof fetch=async()=>{calls++;return new Response(JSON.stringify({errcode:calls===1?310000:0}),{status:200})}
  const n=new Notifier(db,{provider:'dingtalk',webhook:'https://oapi.dingtalk.com/robot/send?access_token=test',secret:'SECtest'},request)
  await n.drain()
  expect((await repo.notificationStats()).pending).toBe(1)
  await n.drain(Date.now()+60000)
  await n.drain(Date.now()+60000)
  expect(calls).toBe(2)
  expect((await repo.notificationStats()).sent).toBe(1)
})
