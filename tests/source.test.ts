import { expect, it } from 'vitest'
import { BinanceSource } from '../server/source.js'
import { sendNotification } from '../server/notifications.js'
const row={symbol:'BTCUSDT',side:'SELL',positionSide:'SHORT',executedQty:'1',avgPrice:'100',totalPnl:'0',orderTime:100,orderUpdateTime:100}
it('按 indexValue 读取下一页，并覆盖所有成交',async()=>{
  const bodies:Record<string,unknown>[]=[]
  const request:typeof fetch=async(_url,init)=>{
    const b=JSON.parse(String(init?.body));bodies.push(b)
    return new Response(JSON.stringify({code:'000000',success:true,data:{list:[{...row,orderTime:b.indexValue?200:100,orderUpdateTime:b.indexValue?200:100}],total:2,indexValue:b.indexValue?-1:20}}))
  }
  const trades=await new BinanceSource('5075281354358777856',request,0).fetchTrades(1,1000)
  expect(trades).toHaveLength(2);expect(bodies[1].indexValue).toBe(20)
})
it('截断分页和访问限制都明确报错，不作为空仓',async()=>{
  const incomplete:typeof fetch=async()=>new Response(JSON.stringify({code:'000000',data:{list:[row],total:10,indexValue:-1}}))
  await expect(new BinanceSource('5075281354358777856',incomplete,0).fetchTrades(1,1000)).rejects.toThrow('分页')
  const forbidden:typeof fetch=async()=>new Response('',{status:403})
  await expect(new BinanceSource('5075281354358777856',forbidden,0).fetchTrades(1,1000)).rejects.toThrow('403')
})
it('钉钉发送包含加签，HTTP 200 的业务错误也会失败',async()=>{
  const request:typeof fetch=async(url,init)=>{
    expect(new URL(String(url)).searchParams.get('sign')).toBeTruthy()
    expect(JSON.parse(String(init?.body)).text.content).toBe('hello')
    return new Response(JSON.stringify({errcode:310000}))
  }
  await expect(sendNotification({provider:'dingtalk',webhook:'https://oapi.dingtalk.com/robot/send?access_token=test',secret:'SECtest'},'hello',request)).rejects.toThrow('310000')
})
it('飞书使用自己的签名和消息格式',async()=>{
  const request:typeof fetch=async(_url,init)=>{
    const body=JSON.parse(String(init?.body))
    expect(body.msg_type).toBe('text');expect(body.sign).toBeTruthy();expect(body.timestamp.length).toBe(10)
    return new Response(JSON.stringify({code:0}))
  }
  await sendNotification({provider:'feishu',webhook:'https://open.feishu.cn/open-apis/bot/v2/hook/test',secret:'secret'},'hello',request)
})

it('已达到 total 时不继续请求残留游标',async()=>{
  let calls=0
  const request:typeof fetch=async()=>{calls++;return new Response(JSON.stringify({code:'000000',success:true,data:{list:[row],total:1,indexValue:'100'}}))}
  expect(await new BinanceSource('5075281354358777856',request,0).fetchTrades(1,1000)).toHaveLength(1)
  expect(calls).toBe(1)
})
