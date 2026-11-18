import { useEffect, useState } from 'react'
import { ArrowDownRight, ArrowUpRight, Download, ChevronLeft, ChevronRight, Crosshair } from 'lucide-react'
import type { AccountObservation, PositionDetails, PositionSnapshot } from '../shared/types'
const numeric = (v: string | null | undefined, digits = 2) => v == null ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: digits })
const px = (v: string | null) => v == null ? '—' : Number(v).toLocaleString('en-US', { maximumSignificantDigits: 10 })
const at = (v: number | null | undefined) => !v ? '尚无记录' : new Date(v).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
const color = (v: string | null) => v == null ? '' : Number(v) < 0 ? 'negative' : Number(v) > 0 ? 'positive' : ''
export const sourceName = { binance: '币安公开仓位', reconstructed: '校准后推算', unavailable: '仓位未知' }
export function AccountBalance({ account }: { account: AccountObservation | null }) {
  return <div className="account-balance"><div><span>带单保证金余额</span><strong>{numeric(account?.marginBalance)} <small>{account?.asset || 'USDT'}</small></strong></div><p>{account ? '币安页面数据 · 采集于 ' + at(account.observedAt) : '等待币安账户数据'}<br /><span>此带单项目的保证金余额，不代表交易员全部资产；上游可能延迟。</span></p></div>
}
export function PositionCards({ positions, source }: { positions: PositionDetails[]; source: PositionSnapshot['source'] }) {
  return <div className="position-list">{positions.map(p => <article className="position" key={p.symbol + p.positionSide}>
    <div className="position-header"><span className="coin">{p.symbol.slice(0, 1)}</span><div><h3>{p.symbol.replace(/USDT$/, '')}<span> / USDT</span></h3>
      <span className={'trade-tag ' + (p.positionSide === 'LONG' ? 'long' : 'short')}>{p.positionSide === 'LONG' ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}{p.positionSide === 'LONG' ? '做多' : '做空'}</span>
      <span className="position-meta">{p.leverage ? p.leverage + 'x' : '杠杆未知'} · {p.marginMode === 'CROSS' ? '全仓' : p.marginMode === 'ISOLATED' ? '逐仓' : '模式未知'}{p.metadataSource === 'manual' ? '（手动确认）' : ''}</span>
    </div><div className={'position-pnl ' + color(p.unrealizedPnl)}>{numeric(p.unrealizedPnl)}<small>浮动盈亏 / USDT</small></div></div>
    <div className="position-values detailed">
      <div><span>持仓数量</span><strong>{numeric(p.qty, 8)} <small>{p.symbol.replace(/USDT$/, '')}</small></strong></div>
      <div><span>开仓均价</span><strong>{px(p.avg)}</strong></div>
      <div><span>标记价格</span><strong>{px(p.mark)}</strong></div>
      <div><span>仓位价值 · USDT</span><strong>{numeric(p.notional)}</strong></div>
      <div><span>ROI · 估算</span><strong className={color(p.roi)}>{p.roi === null ? '—' : numeric(p.roi) + '%'}</strong></div>
      <div><span>强平价 · 上游提供</span><strong>{p.liquidationPrice === null ? '未提供' : px(p.liquidationPrice)}</strong></div>
    </div>
    <div className="position-foot"><span>{sourceName[source]}</span><span>{p.markAt ? at(p.markAt) + ' 行情' : '标记价格暂不可用'}</span></div>
  </article>)}</div>
}
type HistoryResult = { items: PositionSnapshot[]; total: number }
export function PositionHistory({ lastAt }: { lastAt: number | null }) {
  const [data, setData] = useState<HistoryResult | null>(null)
  const [symbol, setSymbol] = useState('')
  const [date, setDate] = useState('')
  const [page, setPage] = useState(1)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const params = new URLSearchParams({ page: String(page), limit: '10' })
  const normalized = symbol.trim().toUpperCase()
  if (normalized) params.set('symbol', normalized.endsWith('USDT') ? normalized : normalized + 'USDT')
  if (date) { const from = new Date(date + 'T00:00:00+08:00').getTime(); params.set('from', String(from)); params.set('to', String(from + 86400000 - 1)) }
  const query = params.toString()
  useEffect(() => {
    let active = true
    const timer = setTimeout(async () => {
      setLoading(true); setError('')
      try {
        const r = await fetch('/api/positions/history?' + query)
        if (r.status === 401) window.dispatchEvent(new Event('auth-expired'))
        const body = await r.json()
        if (!r.ok) throw new Error(body.error || '仓位记录加载失败')
        if (active) setData(body)
      } catch (e) { if (active) setError(e instanceof Error ? e.message : '仓位记录加载失败') }
      finally { if (active) setLoading(false) }
    }, 200)
    return () => { active = false; clearTimeout(timer) }
  }, [query, lastAt])
  return <section className="panel">
    <div className="history-filters">
      <label>合约品种<input placeholder="BTC、ETH…" value={symbol} onChange={e => { setSymbol(e.target.value); setPage(1) }} /></label>
      <label>记录日期 · 北京时间<input type="date" value={date} onChange={e => { setDate(e.target.value); setPage(1) }} /></label>
      <button className="text-button" onClick={() => { setSymbol(''); setDate(''); setPage(1) }}>重置筛选</button>
      <a className="button" href={'/api/positions/export?' + query}><Download size={15} />导出筛选 CSV</a>
      <span>{loading ? '查询中…' : '共 ' + (data?.total ?? 0) + ' 条快照'}</span>
    </div>
    <div className="panel-note">变化时记录，平时每分钟留存。这里保存的是采集时的仓位与价格，不能作为历史成交瞬间的仓位。ROI = 浮盈 ÷（仓位价值 ÷ 杠杆）。</div>
    {error ? <div className="empty"><h3>暂时无法加载</h3><p>{error}</p></div> : !data || loading ? <div className="empty">正在读取仓位快照…</div> : !data.items.length ? <div className="empty"><Crosshair size={30} /><h3>暂无匹配的仓位记录</h3><p>校准后会自动留存具体仓位；未校准时仅保留可获取的账户状态。</p></div> :
      <div className="snapshot-list">{data.items.map(s => <details className="snapshot-record" key={s.id}>
        <summary><div><strong>{at(s.observedAt)}</strong><small>{sourceName[s.source]} · {s.scope === 'selected' ? '指定仓位' : '整个账户'} · {s.reason === 'calibration' ? '校准留档' : s.reason === 'change' ? '状态变化' : '定时快照'}</small></div>
          <div className="snapshot-brief">{s.positions.length ? s.positions.map(p => p.symbol.replace(/USDT$/, '') + (p.positionSide === 'LONG' ? ' 多 ' : ' 空 ') + numeric(p.qty, 8)).join(' / ') : s.reliable ? '当前为空仓' : '仓位未知'}{s.closed.length ? ' · 平仓 ' + s.closed.map(p => p.symbol).join(', ') : ''}<span className="subtle-badge">{s.reliable ? '展开详情' : '数据不完整'}</span></div>
        </summary>
        <div className="snapshot-body"><AccountBalance account={s.account} />
          {s.warning && <p className="inline-warning">{s.warning}</p>}
          <PositionCards positions={s.positions} source={s.source} />
          {s.closed.map(p => <p className="closed-position" key={p.symbol + p.positionSide}>{p.symbol} · {p.positionSide === 'LONG' ? '多' : '空'} · 已平仓，剩余数量 0</p>)}
          {!s.positions.length && <p className="muted">{s.reliable ? '该次采集范围内没有未平仓仓位。' : '没有可确认的仓位明细，不能据此判断空仓。'}</p>}
          <div className="snapshot-audit"><span>成交已同步至 {at(s.tradeThrough)}</span><span>校准起点 {at(s.baseline?.at)}</span><span>成交版本摘要 {s.tradeRevision.slice(0, 16)}</span><span>记录 ID {s.id}</span></div>
        </div>
      </details>)}</div>}
    <div className="pagination"><span>每页 10 条 · 历史快照保留当时数值</span><div><button aria-label="上一页仓位记录" disabled={page === 1 || loading} onClick={() => setPage(p => p - 1)}><ChevronLeft size={16} /></button><span>{page} / {Math.max(1, Math.ceil((data?.total || 0) / 10))}</span><button aria-label="下一页仓位记录" disabled={loading || page * 10 >= (data?.total || 0)} onClick={() => setPage(p => p + 1)}><ChevronRight size={16} /></button></div></div>
  </section>
}
