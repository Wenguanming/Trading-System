export type Side = 'BUY' | 'SELL'
export type Direction = 'LONG' | 'SHORT'
export type Effect = 'open' | 'add' | 'reduce' | 'close' | 'unknown'
export interface Trade {
  id: string; portfolioId: string; symbol: string; side: Side; positionSide: Direction
  qty: string; price: string; realizedPnl: string; time: number; updatedAt: number
  detectedAt: number; revision: number; raw: Record<string, unknown>
}
export interface Baseline {
  at: number
  positions: { symbol: string; positionSide: Direction; qty: string; avg: string }[]
}
export interface Position {
  symbol: string; positionSide: Direction; qty: string; avg: string
  mark: string | null; markAt: number | null; notional: string | null; unrealizedPnl: string | null
}
export interface TradeView extends Omit<Trade, 'raw'> { effect: Effect; after: string | null }
export interface Health {
  initialized: boolean; paused: boolean; lastAttempt: number | null; lastSuccess: number | null
  coverageStart: number | null; failures: number; error: string | null; nextPoll: number | null
}
export interface Snapshot {
  trader: { id: string; name: string; url: string }
  mode: 'binance' | 'demo'; serverTime: number; connected: boolean
  health: Health; polling: boolean; pollIntervalMs: number
  baseline: Baseline | null; positionReliable: boolean; positionWarning: string | null
  positions: Position[]; recentTrades: TradeView[]
  stats: { totalTrades: number; todayTrades: number; todayRealizedPnl: string; unrealizedPnl: string | null; trackedSymbols: number }
  market: { updatedAt: number | null; error: string | null }
  notifications: { provider: string; configured: boolean; pending: number; failed: number; sent: number; lastError: string | null; lastSentAt: number | null }
}
