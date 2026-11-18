import 'dotenv/config'
import { resolve } from 'node:path'
import { z } from 'zod'
const env = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  HOST: z.string().default('127.0.0.1'),
  PORTFOLIO_ID: z.string().regex(/^\d{10,30}$/).default('5075281354358777856'),
  TRADER_NAME: z.string().min(1).max(80).default('熬鹰资本'),
  POLL_INTERVAL_MS: z.coerce.number().int().min(10000).max(300000).default(15000),
  BACKFILL_DAYS: z.coerce.number().int().min(1).max(30).default(7),
  SOURCE_MODE: z.enum(['binance', 'demo']).default('binance'),
  DATA_DIR: z.string().default('./data/live'),
  DATABASE_URL: z.string().default(''),
  APP_PASSWORD: z.string().default(''),
  COOKIE_SECURE: z.enum(['true', 'false']).default('false'),
  NOTIFY_PROVIDER: z.enum(['none', 'dingtalk', 'feishu']).default('none'),
  NOTIFY_WEBHOOK: z.string().default(''),
  NOTIFY_SECRET: z.string().default(''),
}).parse(process.env)
if (!['127.0.0.1', 'localhost', '::1'].includes(env.HOST) && env.APP_PASSWORD.length < 12) {
  throw new Error('监听非本机地址时必须设置至少 12 位 APP_PASSWORD')
}
if (env.APP_PASSWORD && env.APP_PASSWORD.length < 12) throw new Error('APP_PASSWORD 至少 12 位')
if (env.NOTIFY_PROVIDER !== 'none' && env.SOURCE_MODE !== 'demo') {
  const url = new URL(env.NOTIFY_WEBHOOK)
  const valid = env.NOTIFY_PROVIDER === 'dingtalk'
    ? url.hostname === 'oapi.dingtalk.com' && url.pathname === '/robot/send' && url.searchParams.has('access_token')
    : url.hostname === 'open.feishu.cn' && url.pathname.startsWith('/open-apis/bot/v2/hook/')
  if (url.protocol !== 'https:' || !valid || !env.NOTIFY_SECRET) throw new Error('请配置正确的通知 Webhook 与加签密钥')
}
export const config = { ...env, DATA_DIR: resolve(env.DATA_DIR) }
export type Config = typeof config
