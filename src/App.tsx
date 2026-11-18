import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Activity, ArrowDownRight, ArrowUpRight, ArrowUpRight as External, Bell, Check, ChevronLeft, ChevronRight, CircleHelp, Clock3, Download, Eye, History, LayoutDashboard, LockKeyhole, LogOut, Menu, Pause, Play, Plus, Radio, RefreshCw, Settings2, ShieldCheck, Trash2, Waves, WifiOff, X, Crosshair } from 'lucide-react'
import type { Baseline, Snapshot, TradeView } from '../shared/types'

type Page = 'overview' | 'history' | 'settings'
const labels = { open: '开仓', add: '加仓', reduce: '减仓', close: '平仓', unknown: '成交' }
const number = (v: string | number | null | undefined, digits = 2) => v == null ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits })
const quantity = (v: string | null) => v == null ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 8 })
const price = (v: string | null) => v == null ? '—' : Number(v) >= 100 ? number(v) : Number(v).toLocaleString('en-US', { maximumSignificantDigits: 10 })
const money = (v: string | null) => v == null ? '—' : (Number(v) > 0 ? '+' : '') + number(v)
const time = (v: number | null, date = false) => !v ? '尚无记录' : new Date(v).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', ...(date ? { month: '2-digit', day: '2-digit' } : {}), hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
const localDateInput = (ms: number) => { const d = new Date(ms); return new Date(ms - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19) }
const tone = (v: string | null) => v == null || Number(v) === 0 ? '' : Number(v) > 0 ? 'positive' : 'negative'
async function api<T = { ok: boolean }>(url: string, body?: unknown): Promise<T> {
  const response = await fetch('/api' + url, { credentials: 'same-origin', ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) })
  let data
  try { data = await response.json() } catch { throw new Error('服务暂时不可用，请稍后重新连接') }
  if (response.status === 401) window.dispatchEvent(new Event('auth-expired'))
  if (!response.ok) throw new Error(data.error || '暂时无法连接服务')
  return data as T
}
function Empty({ title, children, icon = <Crosshair size={30} /> }: { title: string; children: ReactNode; icon?: ReactNode }) {
  return <div className="empty"><div className="empty-icon">{icon}</div><h3>{title}</h3><div>{children}</div></div>
}
function TradeTable({ trades }: { trades: TradeView[] }) {
  return <div className="table-scroll"><table><thead><tr><th>成交时间 · 北京时间</th><th>合约 / 操作</th><th className="right">成交数量</th><th className="right">成交均价</th><th className="right">剩余持仓</th><th className="right">已实现盈亏</th></tr></thead><tbody>{trades.map(t => <tr key={t.id}>
    <td><span className="table-time">{time(t.time, true)}</span><small>检测 {time(t.detectedAt)}{t.revision > 1 ? ' · 已更新' : ''}</small></td>
    <td><div className="symbol">{t.symbol.replace(/USDT$/, '')}<span>USDT</span></div><span className={'trade-tag ' + (t.positionSide === 'LONG' ? 'long' : 'short')}>{t.effect === 'unknown' ? (t.side === 'BUY' ? '买入' : '卖出') : labels[t.effect]} · {t.positionSide === 'LONG' ? '多' : '空'}</span></td>
    <td className="right numeric">{quantity(t.qty)}</td><td className="right numeric">{price(t.price)}</td>
    <td className="right numeric">{quantity(t.after)}</td><td className={'right numeric ' + tone(t.realizedPnl)}>{money(t.realizedPnl)}</td>
  </tr>)}</tbody></table></div>
}
export function App() {
  const [auth, setAuth] = useState<boolean | null>(null)
  const [authRequired, setAuthRequired] = useState(false)
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [page, setPage] = useState<Page>('overview')
  const [connected, setConnected] = useState(false)
  const [now, setNow] = useState(Date.now())
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null)
  const [busy, setBusy] = useState('')
  const [fatal, setFatal] = useState('')
  const [password, setPassword] = useState('')
  const [menu, setMenu] = useState(false)
  const [history, setHistory] = useState<{ items: TradeView[]; total: number } | null>(null)
  const [historyPage, setHistoryPage] = useState(1)
  const [search, setSearch] = useState('')
  const [date, setDate] = useState('')
  const [historyError, setHistoryError] = useState('')
  const [historyLoading, setHistoryLoading] = useState(false)
  const [baselineAt, setBaselineAt] = useState('')
  const [seeds, setSeeds] = useState<Baseline['positions']>([])
  const [confirmed, setConfirmed] = useState(false)
  const notify = (text: string, error = false) => setToast({ text, error })
  useEffect(() => {
    api<{ authenticated: boolean; required: boolean }>('/auth').then(r => { setAuth(r.authenticated); setAuthRequired(r.required) }).catch(e => setFatal(e.message))
    const expired = () => setAuth(false)
    window.addEventListener('auth-expired', expired)
    return () => window.removeEventListener('auth-expired', expired)
  }, [])
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [])
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(null), 6500); return () => clearTimeout(timer) }, [toast])
  useEffect(() => {
    if (!auth) return
    let mounted = true
    api<Snapshot>('/snapshot').then(s => { if (mounted) { setSnapshot(s); setFatal('') } }).catch(e => { if (mounted) setFatal(e.message) })
    const source = new EventSource('/api/events')
    source.onopen = () => { setConnected(true); setFatal('') }
    source.onerror = () => setConnected(false)
    source.addEventListener('snapshot', event => {
      try { setSnapshot(JSON.parse((event as MessageEvent).data)); setConnected(true); setFatal('') } catch {}
    })
    return () => { mounted = false; source.close() }
  }, [auth])
  useEffect(() => {
    if (page !== 'history' || !auth) return
    let cancelled = false
    const timer = setTimeout(() => {
      setHistoryLoading(true); setHistoryError('')
      const params = new URLSearchParams({ page: String(historyPage), symbol: search.trim(), limit: '30' })
      if (date) { const from = new Date(date + 'T00:00:00+08:00').getTime(); params.set('from', String(from)); params.set('to', String(from + 86400000 - 1)) }
      api<{ items: TradeView[]; total: number }>('/trades?' + params).then(r => { if (!cancelled) setHistory(r) }).catch(e => { if (!cancelled) setHistoryError(e.message) }).finally(() => { if (!cancelled) setHistoryLoading(false) })
    }, 200)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [page, auth, historyPage, search, date, snapshot?.health.lastSuccess])
  async function action(name: string, path: string, body: unknown = {}) {
    setBusy(name)
    try {
      const result = await api<Partial<Snapshot>>(path, body)
      if (result.health?.error) throw new Error(result.health.error)
      notify(name === 'sync' ? '同步完成，数据已更新' : name === 'test' ? '测试通知已发送，请查看手机' : '设置已保存')
    } catch (e) { notify(e instanceof Error ? e.message : '操作失败', true) }
    finally { setBusy('') }
  }
  function navigate(next: Page) {
    setPage(next); setMenu(false); window.scrollTo({ top: 0, behavior: 'instant' })
    if (next === 'settings' && snapshot) {
      setBaselineAt(localDateInput(snapshot.baseline?.at ?? snapshot.health.lastSuccess ?? Date.now()))
      setSeeds(snapshot.baseline?.positions.map(p => ({ ...p })) ?? [])
      setConfirmed(false)
    }
  }
  async function login(e: FormEvent) {
    e.preventDefault(); setBusy('login')
    try { await api('/login', { password }); setAuth(true); setPassword(''); setFatal('') } catch (e) { notify((e as Error).message, true) } finally { setBusy('') }
  }
  if (auth === false) return <div className="login"><div className="login-card"><div className="brand-icon"><Waves /></div><div className="eyebrow">WANGCHAO / PRIVATE OBSERVATORY</div><h1>欢迎回到望潮</h1><p>输入访问密码，查看你的交易员观察台。</p><form onSubmit={login}><label>访问密码<input type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} /></label><button className="primary" disabled={!!busy}><LockKeyhole size={16} />进入看板</button></form>{toast && <p className="negative">{toast.text}</p>}</div></div>
  if (!snapshot) return <div className="loading-screen"><Waves size={42} /><h2>{fatal ? '暂时无法连接服务' : '正在连接观察台'}</h2><p>{fatal || '读取监控状态与历史成交…'}</p>{fatal && <button onClick={() => window.location.reload()}>重新连接</button>}</div>
  const age = snapshot.health.lastSuccess ? Math.max(0, Math.floor((now - snapshot.health.lastSuccess) / 1000)) : null
  const stale = !connected || snapshot.health.paused || age === null || age > Math.max(45, snapshot.pollIntervalMs / 1000 * 3)
  const stateLabel = !connected ? '连接中断' : snapshot.health.paused ? '监控已暂停' : snapshot.health.failures ? '采集异常' : !snapshot.health.initialized ? '首次同步中' : stale ? '数据待更新' : '监控运行中'
  const navs: { page: Page; label: string; icon: ReactNode }[] = [{ page: 'overview', label: '监控总览', icon: <LayoutDashboard size={18} /> }, { page: 'history', label: '交易记录', icon: <History size={18} /> }, { page: 'settings', label: '提醒与设置', icon: <Settings2 size={18} /> }]
  return <div className="shell">
    {menu && <div className="nav-scrim" onClick={() => setMenu(false)} />}
    <aside className={'sidebar ' + (menu ? 'visible' : '')}>
      <a className="brand" href="/" aria-label="望潮首页"><span className="brand-icon"><Waves size={25} /></span><span>望潮<small>WANGCHAO</small></span></a>
      <div className="nav-caption">工作空间</div>
      <nav>{navs.map(n => <button key={n.page} className={page === n.page ? 'active' : ''} onClick={() => navigate(n.page)}>{n.icon}{n.label}{n.page === 'history' && <span className="nav-count">{snapshot.stats.totalTrades}</span>}</button>)}</nav>
      <div className="side-observer"><div className="side-label"><span className={'dot ' + (stale ? 'warning' : '')} />当前观察对象</div><strong>{snapshot.trader.name}</strong><span>币安合约 · 公开成交</span><a href={snapshot.trader.url} target="_blank" rel="noreferrer">在币安查看 <External size={13} /></a></div>
      <div className="sidebar-bottom"><ShieldCheck size={17} /><span>只读观察，持续记录<small>不接入交易权限</small></span></div>
    </aside>
    <main>
      <header className="topbar"><div><button className="icon-button mobile-menu" aria-label="打开导航" onClick={() => setMenu(true)}><Menu size={21} /></button><span className="breadcrumb">工作空间 <ChevronRight size={13} /> <strong>{navs.find(n => n.page === page)?.label}</strong></span></div><div className="top-meta"><span className="timezone">北京时间 UTC+8</span><span className={'status-pill ' + (stale || snapshot.health.failures ? 'warn' : '')}><span className="dot" />{stateLabel}</span>{authRequired && <button className="icon-button" aria-label="退出登录" onClick={() => { void api('/logout', {}).then(() => { setAuth(false); setSnapshot(null) }).catch(e => notify(e.message, true)) }}><LogOut size={16} /></button>}</div></header>
      <div className="content">
        {snapshot.mode === 'demo' && <div className="banner demo"><Eye size={17} /><span><strong>演示模式</strong> · 使用明确标记的固定示例数据，外部通知已禁用。</span></div>}
        {(!connected || snapshot.health.error || snapshot.health.paused) && <div className="banner warning-banner"><WifiOff size={17} /><span>{!connected ? '看板与服务器连接中断，当前显示上次收到的数据，正在自动重连。' : snapshot.health.error || '监控已暂停，当前仓位可能过期。'}{connected && snapshot.health.nextPoll && snapshot.health.failures > 0 ? ' · ' + Math.max(0, Math.ceil((snapshot.health.nextPoll - now) / 1000)) + ' 秒后重试' : ''}</span></div>}
        <div className="page-heading"><div><div className="eyebrow">SIGNAL OBSERVATORY <span>/ 01</span></div><h1>{page === 'overview' ? '交易员观察台' : page === 'history' ? '每一笔，都有记录' : '让变化主动找到你'}</h1><p>{page === 'overview' ? '持续追踪公开成交，把注意力留给真正重要的变化。' : page === 'history' ? '保留成交与修订记录，按品种和日期回看。' : '连接手机提醒，校准仓位起点，管理监控状态。'}</p></div>{page === 'overview' ? <button className="button" disabled={!!busy || snapshot.polling} onClick={() => action('sync', '/sync')}><RefreshCw size={15} className={snapshot.polling ? 'spin' : ''} />{snapshot.polling ? '正在同步' : '立即同步'}</button> : page === 'history' ? <a className="button" href="/api/export"><Download size={15} />导出全部 CSV</a> : null}</div>
        {page === 'overview' && <>
          <section className="trader-strip"><div className="avatar">熬</div><div className="trader-info"><div><h2>{snapshot.trader.name}</h2><span className="subtle-badge">BINANCE FUTURES</span></div><p>带单 ID <span className="numeric">{snapshot.trader.id}</span></p></div><div className="trader-sync"><span className="dot" /><div>{snapshot.polling ? '正在读取最新成交' : age === null ? '等待首次同步' : age + ' 秒前完成采集'}<small>公开数据可能存在上游延迟</small></div></div><a className="icon-button" href={snapshot.trader.url} target="_blank" rel="noreferrer" aria-label="打开币安交易员主页"><External size={20} /></a></section>
          <section className="metrics">
            <Metric title="今日成交" value={String(snapshot.stats.todayTrades)} unit="笔" note="北京时间 00:00 至今" icon={<Activity size={17} />} />
            <Metric title="推算持仓浮盈" value={money(snapshot.stats.unrealizedPnl)} unit={snapshot.stats.unrealizedPnl === null ? '' : 'USDT'} note={snapshot.positionReliable ? (stale ? '旧仓位估算 · 等待同步' : '依据币安合约标记价格') : '完成仓位校准后显示'} icon={<ArrowUpRight size={17} />} className={tone(snapshot.stats.unrealizedPnl)} />
            <Metric title="累计记录" value={number(snapshot.stats.totalTrades, 0)} unit="笔" note={snapshot.stats.trackedSymbols + ' 个合约品种'} icon={<History size={17} />} />
            <Metric title="采集间隔" value={String(snapshot.pollIntervalMs / 1000)} unit="秒" note="异常时自动延长重试间隔" icon={<Radio size={17} />} />
          </section>
          <div className="overview-grid"><div>
            <section className="panel positions-panel"><div className="panel-heading"><h2><Crosshair size={18} />当前仓位 <span className="count">{snapshot.positionReliable ? snapshot.positions.length : '—'}</span></h2><button className="text-button" onClick={() => navigate('settings')}>校准仓位 <ChevronRight size={14} /></button></div>
              {!snapshot.positionReliable ? <Empty title="先确认仓位起点"><p>{snapshot.positionWarning}</p><button className="button" onClick={() => navigate('settings')}>设置期初仓位 <External size={14} /></button></Empty> : !snapshot.positions.length ? <Empty title="当前推算为空仓" icon={<Check size={28} />}><p>已校准的成交记录中，没有尚未平仓的仓位。</p></Empty> : <div className="position-list">{snapshot.positions.map(p => <article className="position" key={p.symbol + p.positionSide}><div className="position-header"><span className="coin">{p.symbol.slice(0, 1)}</span><div><h3>{p.symbol.replace(/USDT$/, '')}<span> / USDT</span></h3><span className={'trade-tag ' + (p.positionSide === 'LONG' ? 'long' : 'short')}>{p.positionSide === 'LONG' ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}{p.positionSide === 'LONG' ? '做多' : '做空'} · 推算</span></div><div className={'position-pnl ' + tone(p.unrealizedPnl)}>{money(p.unrealizedPnl)}<small>浮动盈亏 / USDT</small></div></div><div className="position-values"><div><span>持仓数量</span><strong>{quantity(p.qty)} <small>{p.symbol.replace(/USDT$/, '')}</small></strong></div><div><span>开仓均价</span><strong>{price(p.avg)}</strong></div><div><span>标记价格</span><strong>{price(p.mark)}</strong></div><div><span>仓位价值</span><strong>{number(p.notional)} <small>USDT</small></strong></div></div><div className="position-foot"><span>期初仓位＋公开成交重建</span><span>{p.markAt ? time(p.markAt) + ' 行情' : '标记价格暂不可用'}</span></div></article>)}</div>}
              <div className="panel-note"><CircleHelp size={13} />仓位与浮盈为推算值；公开成交可能延迟，未包含资金费与全部费用。</div>
            </section>
            <section className="panel trades-panel"><div className="panel-heading"><h2><Activity size={18} />最新动态</h2><button className="text-button" onClick={() => navigate('history')}>全部记录 <ChevronRight size={14} /></button></div>{snapshot.recentTrades.length ? <TradeTable trades={snapshot.recentTrades.slice(0, 6)} /> : <Empty title={snapshot.polling ? '正在同步历史成交' : '暂无成交记录'}><p>{snapshot.health.error ? '采集恢复后，这里会展示真实成交。' : '首次导入不会推送历史通知，之后发现的新成交会自动记录。'}</p></Empty>}</section>
          </div><aside className="right-column">
            <section className="notification-card"><div className="notification-icon"><Bell size={21} /></div><span className="eyebrow">STAY IN THE LOOP</span><h2>无需一直盯盘</h2><p>开仓、加仓、减仓与平仓，<br />让新的变化抵达你的手机。</p><div className="notify-state"><span className={'dot ' + (!snapshot.notifications.configured ? 'warning' : '')} />{snapshot.notifications.configured ? (snapshot.notifications.provider === 'dingtalk' ? '钉钉' : '飞书') + '通知已配置' : '手机提醒尚未连接'}</div><button onClick={() => navigate('settings')}>{snapshot.notifications.configured ? '管理手机提醒' : '连接手机提醒'}<External size={15} /></button></section>
            <section className="panel health-card"><div className="panel-heading"><h2>采集状态</h2><Radio size={16} /></div><div className="health-item"><span>数据连接</span><strong className={snapshot.health.error ? 'negative' : ''}>{stateLabel}</strong></div><div className="health-item"><span>最近成功</span><strong>{time(snapshot.health.lastSuccess)}</strong></div><div className="health-item"><span>今日已实现</span><strong className={tone(snapshot.stats.todayRealizedPnl)}>{money(snapshot.stats.todayRealizedPnl)} U</strong></div><div className="health-item"><span>已发送通知</span><strong>{snapshot.notifications.sent} 条</strong></div><div className="health-item"><span>等待 / 失败</span><strong>{snapshot.notifications.pending} / {snapshot.notifications.failed}</strong></div>{snapshot.market.error && <p className="inline-warning">{snapshot.market.error}</p>}<div className="health-foot"><ShieldCheck size={14} />无需币安 API Key</div></section>
            <div className="quiet-note"><Waves size={19} /><p>观察变化，保留判断。<br /><span>数据来自公开信息，仅供参考。</span></p></div>
          </aside></div>
        </>}
        {page === 'history' && <section className="panel"><div className="history-filters"><label>合约品种<input placeholder="搜索 BTC、ETH…" value={search} onChange={e => { setSearch(e.target.value); setHistoryPage(1) }} /></label><label>成交日期 · 北京时间<input type="date" value={date} onChange={e => { setDate(e.target.value); setHistoryPage(1) }} /></label><button className="text-button" onClick={() => { setSearch(''); setDate(''); setHistoryPage(1) }}>重置筛选</button><span>{historyLoading ? '查询中…' : '共 ' + (history?.total ?? 0) + ' 笔'}</span></div>{historyError ? <Empty title="暂时无法加载记录"><p>{historyError}</p></Empty> : !history || historyLoading ? <Empty title="正在读取交易记录"><p>正在按你的条件筛选。</p></Empty> : history.items.length ? <TradeTable trades={history.items} /> : <Empty title="没有匹配的成交"><p>试试其他日期或合约品种。</p></Empty>}<div className="pagination"><span>每页 30 笔 · 数量与价格为累计成交口径</span><div><button aria-label="上一页" disabled={historyPage === 1 || historyLoading} onClick={() => setHistoryPage(p => p - 1)}><ChevronLeft size={16} /></button><span>{historyPage} / {Math.max(1, Math.ceil((history?.total || 0) / 30))}</span><button aria-label="下一页" disabled={historyLoading || historyPage * 30 >= (history?.total || 0)} onClick={() => setHistoryPage(p => p + 1)}><ChevronRight size={16} /></button></div></div></section>}
        {page === 'settings' && <div className="settings-grid"><section className="panel settings-card"><div className="panel-heading"><h2><Bell size={18} />手机提醒</h2><span className={'subtle-badge ' + (snapshot.notifications.configured ? 'enabled' : '')}>{snapshot.notifications.configured ? '已配置' : '待连接'}</span></div><div className="settings-body"><p>在服务端的 <code>.env</code> 配置钉钉或飞书群机器人，并开启「加签」。保存后重启服务。</p><pre>{'NOTIFY_PROVIDER=dingtalk\nNOTIFY_WEBHOOK=你的机器人地址\nNOTIFY_SECRET=你的加签密钥'}</pre><p className="muted">飞书使用 <code>NOTIFY_PROVIDER=feishu</code>。手机需要允许对应 App 发送通知。密钥不会通过看板返回。</p><div className="button-row"><button className="primary" disabled={!snapshot.notifications.configured || !!busy} onClick={() => action('test', '/notifications/test')}><Bell size={15} />发送测试通知</button><button disabled={!snapshot.notifications.failed || !!busy} onClick={() => action('retry', '/notifications/retry')}>重试失败消息</button></div>{snapshot.notifications.lastError && <p className="inline-warning">{snapshot.notifications.lastError}</p>}<div className="help-line"><Clock3 size={15} />当前通知记录：成功 {snapshot.notifications.sent} · 待发送 {snapshot.notifications.pending} · 失败 {snapshot.notifications.failed}</div></div></section>
          <section className="panel settings-card"><div className="panel-heading"><h2><Radio size={18} />监控任务</h2></div><div className="settings-body"><div className="setting-row"><div><strong>{snapshot.trader.name}</strong><p>每 {snapshot.pollIntervalMs / 1000} 秒检查公开成交，异常时退避重试。</p></div><button disabled={!!busy || snapshot.polling} onClick={() => action('pause', '/pause', { paused: !snapshot.health.paused })}>{snapshot.health.paused ? <Play size={15} /> : <Pause size={15} />}{snapshot.health.paused ? '恢复' : '暂停'}</button></div><p className="muted">暂停只停止后续成交采集。恢复后会补查停机期间的记录；延迟发现的成交会在通知中标明。</p><div className="help-line"><ShieldCheck size={15} />服务器独立运行，关闭看板不会停止采集。</div></div></section>
          <section className="panel settings-card baseline-card"><div className="panel-heading"><h2><Crosshair size={18} />期初仓位校准</h2><span className="subtle-badge">{snapshot.baseline ? '已有基准' : '待校准'}</span></div><form className="settings-body" onSubmit={e => { e.preventDefault(); void action('baseline', '/baseline', { confirmed, baseline: { at: new Date(baselineAt).getTime(), positions: seeds } }) }}><p>选择一个你能确认完整持仓的时点，填写该时点的全部仓位。系统将按此时点之后的成交重建仓位；留空代表当时全部空仓。</p><label className="baseline-date">基准时间 · 使用本机时区<input type="datetime-local" step="1" required value={baselineAt} onChange={e => setBaselineAt(e.target.value)} /></label><p className="muted">可校准范围（北京时间）：{time(snapshot.health.coverageStart, true)} — {time(snapshot.health.lastSuccess, true)}</p>
            {seeds.map((seed, i) => <div className="seed-row" key={i}><label>合约<input aria-label={'合约 ' + (i + 1)} required placeholder="BTCUSDT" value={seed.symbol} onChange={e => setSeeds(prev => prev.map((s, n) => n === i ? { ...s, symbol: e.target.value.toUpperCase() } : s))} /></label><label>方向<select value={seed.positionSide} onChange={e => setSeeds(prev => prev.map((s, n) => n === i ? { ...s, positionSide: e.target.value as 'LONG' | 'SHORT' } : s))}><option value="LONG">做多</option><option value="SHORT">做空</option></select></label><label>数量<input required inputMode="decimal" value={seed.qty} onChange={e => setSeeds(prev => prev.map((s, n) => n === i ? { ...s, qty: e.target.value } : s))} /></label><label>开仓均价<input required inputMode="decimal" value={seed.avg} onChange={e => setSeeds(prev => prev.map((s, n) => n === i ? { ...s, avg: e.target.value } : s))} /></label><button className="icon-button" type="button" aria-label="删除期初仓位" onClick={() => setSeeds(prev => prev.filter((_, n) => n !== i))}><Trash2 size={16} /></button></div>)}
            <button type="button" className="text-button add-seed" onClick={() => setSeeds(s => [...s, { symbol: '', positionSide: 'LONG', qty: '', avg: '' }])}><Plus size={15} />添加期初仓位</button>
            <label className="checkbox"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />我确认这是该时点的全部持仓；没有填写的合约当时均为空仓。</label>
            <div className="button-row"><button className="primary" disabled={!confirmed || !!busy || !snapshot.health.initialized || snapshot.polling}><Check size={16} />保存并重算</button>{snapshot.baseline && <button type="button" disabled={!!busy} onClick={() => { if (window.confirm('清除校准后将停止推算仓位，成交历史保留。继续？')) void action('baseline', '/baseline', { confirmed: true, baseline: null }) }}>清除校准</button>}</div>
          </form></section>
        </div>}
        <footer><span>望潮 WANGCHAO <span className="footer-separator">/</span> 把变化看清楚</span><span>公开成交监控 · 数据可能延迟 · v0.1.0</span></footer>
      </div>
    </main>
    {toast && <div role="status" className={'toast ' + (toast.error ? 'error' : '')}>{toast.error ? <CircleHelp size={17} /> : <Check size={17} />}<span>{toast.text}</span><button aria-label="关闭提示" onClick={() => setToast(null)}><X size={15} /></button></div>}
  </div>
}
function Metric({ title, value, unit, note, icon, className = '' }: { title: string; value: string; unit: string; note: string; icon: ReactNode; className?: string }) {
  return <article className="metric"><div className="metric-label">{title}{icon}</div><div className={'metric-value numeric ' + className}>{value}<span>{unit}</span></div><p>{note}</p></article>
}
