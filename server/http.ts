import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import rateLimit from '@fastify/rate-limit'
import staticFiles from '@fastify/static'
import Decimal from 'decimal.js'
import { z } from 'zod'
import type { Monitor } from './service.js'
import type { Config } from './config.js'
const decimalPositive = z.string().max(64).refine(v => {
  try { const n = new Decimal(v); return n.isFinite() && n.gt(0) && n.lt('1e20') } catch { return false }
})
export async function createApp(monitor: Monitor, config: Config) {
  const app = Fastify({ logger: false, bodyLimit: 32768 })
  await app.register(cookie, { secret: createHash('sha256').update(config.APP_PASSWORD || randomBytes(32)).digest('hex') })
  await app.register(rateLimit, { global: false })
  const authorized = (value: string | undefined) => {
    if (!config.APP_PASSWORD) return true
    if (!value) return false
    const unsigned = app.unsignCookie(value)
    if (!unsigned.valid || !unsigned.value) return false
    const exp = Number(unsigned.value.split(':')[0])
    return Number.isFinite(exp) && exp > Date.now()
  }
  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('X-Frame-Options', 'DENY').header('Referrer-Policy', 'same-origin')
    if (!req.url.startsWith('/api/')) return
    reply.header('Cache-Control', 'no-store')
    if (!config.APP_PASSWORD && !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.host || '')) return reply.code(403).send({ error: '本地模式只允许本机访问' })
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin) {
      let origin: URL
      try { origin = new URL(req.headers.origin) } catch { return reply.code(403).send({ error: '请求来源无效' }) }
      if (origin.host !== req.headers.host) return reply.code(403).send({ error: '不允许跨站操作' })
    }
    if (['/api/auth', '/api/login', '/api/health'].includes(req.url.split('?')[0])) return
    if (!authorized(req.cookies.session)) return reply.code(401).send({ error: '请先登录看板' })
  })
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: '参数无效：' + error.issues.map(i => i.message).join('；') })
    const status = error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 400
    reply.code(status).send({ error: error instanceof Error ? error.message : '请求失败' })
  })
  app.get('/api/health', async () => ({ ok: true }))
  app.get('/api/auth', async req => ({ required: !!config.APP_PASSWORD, authenticated: authorized(req.cookies.session) }))
  app.post('/api/login', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { password } = z.object({ password: z.string().max(256) }).parse(req.body)
    const hash = (v: string) => createHash('sha256').update(v).digest()
    if (!config.APP_PASSWORD || !timingSafeEqual(hash(password), hash(config.APP_PASSWORD))) return reply.code(401).send({ error: '访问密码不正确' })
    reply.setCookie('session', (Date.now() + 7 * 86400000) + ':' + randomBytes(16).toString('hex'),
      { path: '/', signed: true, httpOnly: true, secure: config.COOKIE_SECURE === 'true', sameSite: 'strict', maxAge: 7 * 86400 })
    return { ok: true }
  })
  app.post('/api/logout', async (_req, reply) => { reply.clearCookie('session', { path: '/' }); return { ok: true } })
  app.get('/api/snapshot', () => monitor.snapshot())
  app.get('/api/trades', async req => {
    const q = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(30),
      symbol: z.string().max(40).default(''), from: z.coerce.number().nonnegative().optional(), to: z.coerce.number().nonnegative().optional() }).parse(req.query)
    const all = monitor.tradeViews().filter(t => (!q.symbol || t.symbol.includes(q.symbol.toUpperCase())) && (!q.from || t.time >= q.from) && (!q.to || t.time <= q.to))
    return { items: all.slice((q.page - 1) * q.limit, q.page * q.limit), total: all.length, page: q.page, limit: q.limit }
  })
  app.get('/api/export', async (_req, reply) => {
    const cell = (value: unknown) => '"' + String(value ?? '').replaceAll('"', '""') + '"'
    const rows = monitor.tradeViews().map(t => [new Date(t.time).toISOString(), t.symbol, t.side, t.positionSide, t.qty, t.price, t.realizedPnl, t.effect, t.after, t.revision])
    const csv = '\uFEFF' + [['time_utc', 'symbol', 'side', 'position_side', 'quantity', 'average_price', 'realized_pnl', 'effect', 'position_after', 'revision'], ...rows].map(r => r.map(cell).join(',')).join('\r\n')
    reply.header('Content-Disposition', 'attachment; filename="wangchao-trades.csv"').type('text/csv; charset=utf-8')
    return csv
  })
  app.post('/api/sync', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (_req, reply) => {
    if (monitor.polling) return reply.code(409).send({ error: '正在同步，请等待完成' })
    if (monitor.health.failures > 0 && (monitor.health.nextPoll || 0) > Date.now()) return reply.code(429).send({ error: '数据源处于退避重试中，请等待下一次自动重试' })
    await monitor.sync()
    return monitor.snapshot()
  })
  app.post('/api/pause', async req => {
    const { paused } = z.object({ paused: z.boolean() }).parse(req.body)
    await monitor.pause(paused); return { ok: true }
  })
  app.post('/api/baseline', async req => {
    const body = z.object({
      confirmed: z.literal(true),
      baseline: z.object({ at: z.number().int().positive(), positions: z.array(z.object({
        symbol: z.string().regex(/^[A-Z0-9_]{2,40}USDT$/), positionSide: z.enum(['LONG', 'SHORT']),
        qty: decimalPositive, avg: decimalPositive,
      })).max(50) }).nullable(),
    }).parse(req.body)
    if (body.baseline && new Set(body.baseline.positions.map(p => p.symbol + p.positionSide)).size !== body.baseline.positions.length) throw new Error('期初仓位存在重复品种与方向')
    await monitor.setBaseline(body.baseline); return { ok: true }
  })
  app.post('/api/notifications/test', { config: { rateLimit: { max: 2, timeWindow: '1 minute' } } }, async () => {
    await monitor.notifier.test(); return { ok: true }
  })
  app.post('/api/notifications/retry', async () => {
    if (!monitor.notifier.enabled) throw new Error('通知通道未配置')
    await monitor.repo.db.query("UPDATE notifications SET status='pending',attempts=0,due_at=$1 WHERE status='failed' AND created_at>$2", [Date.now(), Date.now() - 86400000])
    await monitor.publish(); return { ok: true }
  })
  const connections = new Set<() => void>()
  app.get('/api/events', async (req, reply) => {
    reply.hijack()
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
    const send = (data: unknown) => {
      if (!reply.raw.destroyed && !reply.raw.writableNeedDrain) reply.raw.write('event: snapshot\ndata: ' + JSON.stringify(data) + '\n\n')
    }
    send(await monitor.snapshot())
    monitor.on('change', send)
    const heartbeat = setInterval(() => {
      if (config.APP_PASSWORD && !authorized(req.cookies.session)) { close(); return }
      if (!reply.raw.destroyed) reply.raw.write(': heartbeat\n\n')
    }, 15000)
    const close = () => { clearInterval(heartbeat); monitor.off('change', send); connections.delete(close); reply.raw.end() }
    connections.add(close)
    reply.raw.on('close', close)
  })
  app.addHook('preClose', async () => { for (const close of connections) close() })
  const web = resolve('dist/web')
  if (existsSync(web)) {
    await app.register(staticFiles, { root: web, prefix: '/' })
    app.setNotFoundHandler((req, reply) => req.url.startsWith('/api/') ? reply.code(404).send({ error: '接口不存在' }) : reply.sendFile('index.html'))
  }
  return app
}
