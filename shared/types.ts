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
  scope?: 'account' | 'selected'
  positions: { symbol: string; positionSide: Direction; qty: string; avg: string; leverage?: string; marginMode?: 'CROSS' | 'ISOLATED' }[]
}
export interface Position {
  symbol: string; positionSide: Direction; qty: string; avg: string
  mark: string | null; markAt: number | null; notional: string | null; unrealizedPnl: string | null
}
export interface PositionDetails extends Position {
  leverage: string | null; marginMode: 'CROSS' | 'ISOLATED' | null
  liquidationPrice: string | null; roi: string | null
  metadataSource: 'manual' | 'binance' | null
}
export interface AccountObservation {
  observedAt: number; visibility: 'public' | 'hidden' | 'unknown'
  marginBalance: string | null; asset: string | null
  positions: PositionDetails[] | null
}
export interface PositionSnapshot {
  id: string; observedAt: number; tradeThrough: number | null
  reason: 'change' | 'periodic' | 'calibration'
  source: 'binance' | 'reconstructed' | 'unavailable'
  scope: 'account' | 'selected'; reliable: boolean; warning: string | null
  positions: PositionDetails[]
  closed: { symbol: string; positionSide: Direction; qty: '0' }[]
  account: AccountObservation | null
  baseline: Baseline | null
  tradeRevision: string
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
  positions: PositionDetails[]
  positionSource: PositionSnapshot['source']; positionScope: 'account' | 'selected'
  account: AccountObservation | null
  positionFeed: { error: string | null; nextPoll: number | null }
  positionRecording: { lastAt: number | null; error: string | null }
  recentTrades: TradeView[]
  stats: { totalTrades: number; todayTrades: number; todayRealizedPnl: string; unrealizedPnl: string | null; trackedSymbols: number }
  market: { updatedAt: number | null; error: string | null }
  notifications: { provider: string; configured: boolean; pending: number; failed: number; sent: number; lastError: string | null; lastSentAt: number | null }
}
