import { EventEmitter } from 'node:events'
import Decimal from 'decimal.js'
import type { Baseline, Health, Snapshot, Trade } from '../shared/types.js'
import type { Config } from './config.js'
import { setState, state } from './database.js'
import { replay, type Mark } from './domain.js'
import { Repository, emptyHealth } from './repository.js'
import { BinanceSource, DemoSource, type Source } from './source.js'
import { Notifier } from './notifications.js'
export class Monitor extends EventEmitter {
  health: Health = { ...emptyHealth }
  baseline: Baseline | null = null
  trades: Trade[] = []
  marks = new Map<string, Mark>()
  polling = false
  marketError: string | null = null
  marketUpdated: number | null = null
  private marketBusy = false
  private timer?: NodeJS.Timeout
  private active = new Set<Promise<unknown>>()
  private stopped = false
  source!: Source
  notifier: Notifier
  constructor(readonly repo: Repository, readonly config: Config) {
    super()
    this.notifier = new Notifier(repo.db, {
      provider: config.SOURCE_MODE === 'demo' ? 'none' : config.NOTIFY_PROVIDER,
      webhook: config.NOTIFY_WEBHOOK, secret: config.NOTIFY_SECRET,
    })
  }
  async init() {
    await this.repo.initializeIdentity(this.config.PORTFOLIO_ID, this.config.SOURCE_MODE)
    this.health = await this.repo.health()
    this.baseline = await this.repo.baseline()
    this.trades = await this.repo.trades()
    this.health.nextPoll = Date.now()
    if (this.config.SOURCE_MODE === 'demo') {
      const started = await state(this.repo.db, 'demoStart', Date.now() - 3600000)
      await setState(this.repo.db, 'demoStart', started)
      this.source = new DemoSource(this.config.PORTFOLIO_ID, started)
      if (!this.health.initialized) {
        this.baseline = { at: started - 1, positions: [] }
        await setState(this.repo.db, 'baseline', this.baseline)
      }
    } else this.source = new BinanceSource(this.config.PORTFOLIO_ID)
    await this.notifier.recover()
  }
  private track(p: Promise<unknown>) {
    this.active.add(p)
    void p.catch(error => { console.error('后台任务异常：', error instanceof Error ? error.message : '未知错误') }).finally(() => this.active.delete(p))
  }
  start() {
    let lastMarket = 0, lastNotifications = 0
    this.timer = setInterval(() => {
      if (this.stopped) return
      const now = Date.now()
      if (!this.health.paused && !this.polling && now >= (this.health.nextPoll || 0)) this.track(this.sync())
      if (now - lastMarket > 5000) { lastMarket = now; this.track(this.refreshMarks()) }
      if (now - lastNotifications > 5000) {
        lastNotifications = now
        this.track(this.notifier.drain().then(() => this.publish()))
      }
    }, 1000)
  }
  async stop() { this.stopped = true; clearInterval(this.timer); await Promise.allSettled([...this.active]) }
  async publish() { this.emit('change', await this.snapshot()) }
  async sync() {
    if (this.polling) return false
    this.polling = true
    const now = Date.now()
    this.health.lastAttempt = now
    await this.publish()
    try {
      const maxAge = now - 30 * 86400000
      const requested = this.health.lastSuccess ? this.health.lastSuccess - 10 * 60000 : now - this.config.BACKFILL_DAYS * 86400000
      if (requested < maxAge) throw new Error('停机超过 30 天，已停止推进数据水位。请导出历史并使用新数据目录重新同步、校准仓位')
      const from = requested
      const input = await this.source.fetchTrades(from, now)
      const health: Health = { ...this.health, initialized: true, lastSuccess: now, coverageStart: this.health.coverageStart ?? from,
        failures: 0, error: null, nextPoll: Date.now() + this.config.POLL_INTERVAL_MS }
      await this.repo.ingest(input, health, this.config.TRADER_NAME, this.notifier.enabled, Date.now())
      this.health = health
      this.trades = await this.repo.trades()
    } catch (error) {
      this.health.failures++
      this.health.error = error instanceof Error ? error.message.slice(0, 400) : '采集失败'
      this.health.nextPoll = Date.now() + Math.min(300000, this.config.POLL_INTERVAL_MS * 2 ** Math.min(this.health.failures, 5))
      await setState(this.repo.db, 'health', this.health)
      if (this.health.failures === 3 && this.notifier.enabled) {
        const text = '望潮 · 数据源异常\n' + this.health.error + '\n看板数据可能过期，服务正在自动重试。'
        await this.repo.db.query("INSERT INTO notifications(id,body,status,due_at,created_at) VALUES($1,$2,'pending',$3,$3) ON CONFLICT DO NOTHING",
          ['health:' + now, text, Date.now()])
      }
    } finally {
      this.polling = false
      await this.publish()
    }
    return true
  }
  async refreshMarks() {
    if (this.marketBusy || !this.trades.length) return
    this.marketBusy = true
    try {
      const book = replay(this.trades, this.baseline, this.marks, Date.now())
      const symbols = [...new Set(book.positions.map(p => p.symbol))]
      if (!symbols.length) return
      const incoming = await this.source.fetchMarks(symbols)
      for (const [symbol, mark] of incoming) this.marks.set(symbol, mark)
      this.marketUpdated = incoming.size ? Math.max(...[...incoming.values()].map(m => m.at)) : null
      this.marketError = incoming.size < symbols.length ? '部分合约标记价格暂不可用' : null
    } catch (error) { this.marketError = error instanceof Error ? error.message : '行情暂不可用' }
    finally { this.marketBusy = false; await this.publish() }
  }
  async pause(paused: boolean) {
    if (this.polling) throw new Error('正在完成本轮同步，请稍后暂停或恢复')
    this.health.paused = paused
    this.health.nextPoll = paused ? null : Date.now()
    await setState(this.repo.db, 'health', this.health)
    await this.publish()
  }
  async setBaseline(baseline: Baseline | null) {
    if (this.polling) throw new Error('正在同步，请稍后保存校准')
    if (baseline && (!this.health.coverageStart || !this.health.lastSuccess ||
      baseline.at < this.health.coverageStart || baseline.at > this.health.lastSuccess)) throw new Error('校准时间必须处于已成功采集的历史范围内')
    if (baseline) {
      const view = replay(this.trades, baseline, this.marks, Date.now())
      if (!view.reliable) throw new Error(view.warning || '校准与成交不一致')
    }
    await setState(this.repo.db, 'baseline', baseline)
    this.baseline = baseline
    await this.publish()
    await this.refreshMarks()
  }
  async snapshot(): Promise<Snapshot> {
    const now = Date.now()
    const view = replay(this.trades, this.baseline, this.marks, now)
    const today = Math.floor((now + 8 * 3600000) / 86400000) * 86400000 - 8 * 3600000
    const todays = this.trades.filter(t => t.time >= today)
    const sum = (values: string[]) => values.reduce((a, b) => a.add(b), new Decimal(0)).toString()
    return {
      trader: { id: this.config.PORTFOLIO_ID, name: this.config.TRADER_NAME, url: 'https://www.binance.com/zh-CN/copy-trading/lead-details/' + this.config.PORTFOLIO_ID },
      mode: this.config.SOURCE_MODE, serverTime: now, connected: true, health: { ...this.health }, polling: this.polling,
      pollIntervalMs: this.config.POLL_INTERVAL_MS, baseline: this.baseline,
      positionReliable: view.reliable, positionWarning: view.warning, positions: view.positions,
      recentTrades: view.trades.slice(0, 12),
      stats: { totalTrades: this.trades.length, todayTrades: todays.length,
        todayRealizedPnl: sum(todays.map(t => t.realizedPnl)),
        unrealizedPnl: view.reliable && view.positions.every(p => p.unrealizedPnl !== null) ? sum(view.positions.map(p => p.unrealizedPnl!)) : null,
        trackedSymbols: new Set(this.trades.map(t => t.symbol)).size },
      market: { updatedAt: this.marketUpdated, error: this.marketError },
      notifications: { provider: this.notifier.config.provider, configured: this.notifier.enabled, ...await this.repo.notificationStats() },
    }
  }
  tradeViews() { return replay(this.trades, this.baseline, this.marks, Date.now()).trades }
}
