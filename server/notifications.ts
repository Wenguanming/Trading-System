import { createHmac } from 'node:crypto'
import type { Database } from './database.js'
export interface NotifyConfig { provider: 'none' | 'dingtalk' | 'feishu'; webhook: string; secret: string }
export async function sendNotification(config: NotifyConfig, content: string, request: typeof fetch = fetch) {
  if (config.provider === 'none') throw new Error('通知通道未配置')
  const url = new URL(config.webhook)
  let payload: Record<string, unknown>
  if (config.provider === 'dingtalk') {
    const timestamp = Date.now().toString()
    url.searchParams.set('timestamp', timestamp)
    url.searchParams.set('sign', createHmac('sha256', config.secret).update(timestamp + '\n' + config.secret).digest('base64'))
    payload = { msgtype: 'text', text: { content } }
  } else {
    const timestamp = Math.floor(Date.now() / 1000).toString()
    const sign = createHmac('sha256', timestamp + '\n' + config.secret).update('').digest('base64')
    payload = { timestamp, sign, msg_type: 'text', content: { text: content } }
  }
  let response: Response
  try {
    response = await request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(10000) })
  } catch { throw new Error('通知请求超时或网络不可达，将自动重试') }
  if (!response.ok) throw new Error(`通知服务 HTTP ${response.status}`)
  const json = await response.json() as { errcode?: number; code?: number; StatusCode?: number }
  const code = config.provider === 'dingtalk' ? json.errcode : (json.code ?? json.StatusCode)
  if (code !== 0) throw new Error(`通知服务拒绝消息（错误码 ${code ?? '未知'}），请检查加签与机器人设置`)
}
export class Notifier {
  private busy = false
  constructor(readonly db: Database, readonly config: NotifyConfig, readonly request: typeof fetch = fetch) {}
  get enabled() { return this.config.provider !== 'none' }
  async recover() {
    await this.db.query("UPDATE notifications SET status='pending' WHERE status='sending'")
  }
  async drain(now = Date.now()) {
    if (!this.enabled || this.busy) return
    this.busy = true
    try {
      // 停机超过一天的积压保留记录但不轰炸手机。
      await this.db.query("UPDATE notifications SET status='skipped',error='积压超过 24 小时，已停止自动发送' WHERE status IN ('pending','failed') AND created_at<$1", [now - 86400000])
      const rows = await this.db.query<{ id: string; body: string; attempts: number }>("SELECT id,body,attempts FROM notifications WHERE status='pending' AND due_at<=$1 ORDER BY created_at LIMIT 5", [now])
      for (const row of rows.rows) {
        await this.db.query("UPDATE notifications SET status='sending',attempts=attempts+1 WHERE id=$1", [row.id])
        try {
          await sendNotification(this.config, row.body, this.request)
          await this.db.query("UPDATE notifications SET status='sent',sent_at=$2,error=NULL WHERE id=$1", [row.id, Date.now()])
        } catch (error) {
          const attempts = row.attempts + 1
          await this.db.query('UPDATE notifications SET status=$2,due_at=$3,error=$4 WHERE id=$1',
            [row.id, attempts >= 8 ? 'failed' : 'pending', Date.now() + Math.min(300000, 5000 * 2 ** attempts), error instanceof Error ? error.message : '通知发送失败'])
        }
      }
    } finally { this.busy = false }
  }
  async test() {
    if (!this.enabled) throw new Error('通知未配置，请先填写 .env 并重启')
    await sendNotification(this.config, '望潮 · 手机提醒测试\n通知通道已连接。发现新的公开成交后，将向此会话推送摘要。', this.request)
  }
}
