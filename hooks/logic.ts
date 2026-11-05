import type { Core, RateRow } from '../types'

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const MAX_KEEP_MS = 168 * HOUR
export const DEFAULT_KEEP_MS = 6 * HOUR

export const EMPTY: Core = {
  lastAt: 0,
  tokens: 0,
  window: 0,
  model: '',
  compacted: false,
  compactTried: false,
  noCompact: false,
  keepUntil: 0,
  updatedAt: 0,
}

export type Options = {
  autoCompact: boolean
  guard: 'ask' | 'warn' | 'off'
  ttlMs: number
  minTokens: number
}

export function parseOptions(raw: Readonly<Record<string, unknown>>): Options {
  const minTokens = Number(raw.minTokens)

  return {
    autoCompact: raw.autoCompact !== 'off',
    guard: raw.guard === 'warn' || raw.guard === 'off' ? raw.guard : 'ask',
    ttlMs: raw.cacheTtl === '5m' ? 5 * MINUTE : HOUR,
    minTokens: Number.isFinite(minTokens) && minTokens > 0 ? minTokens : 50_000,
  }
}

/** Compact 5 minutes before a 1h cache goes cold, 1 minute before a 5m one. */
export const compactAtMs = (ttlMs: number) => ttlMs - Math.max(MINUTE, Math.min(5 * MINUTE, ttlMs / 5))

/** Ping well ahead of the compact point, so a keepwarm window ending hands over cleanly. */
export const pingEveryMs = (ttlMs: number) => Math.round((ttlMs * 5) / 6) - MINUTE

export type Idle = {
  now: number
  core: Core
  options: Options
  isTurnRunning: boolean
  nextPingAt: number
}

export type Action = 'none' | 'compact' | 'ping'

/** The one decision the idle timer makes; `compacted` is what stops a recompact. */
export function decide({ now, core, options, isTurnRunning, nextPingAt }: Idle): Action {
  if (core.lastAt === 0 || isTurnRunning || core.compacted) return 'none'

  const idle = now - core.lastAt

  if (idle >= options.ttlMs) return 'none'

  if (core.keepUntil > now) {
    return idle >= pingEveryMs(options.ttlMs) && now >= nextPingAt ? 'ping' : 'none'
  }

  const canCompact =
    options.autoCompact && !core.noCompact && !core.compactTried && core.tokens >= options.minTokens

  return canCompact && idle >= compactAtMs(options.ttlMs) ? 'compact' : 'none'
}

export const isCold = (core: Core, now: number, ttlMs: number) =>
  core.lastAt > 0 && !core.compacted && now - core.lastAt >= ttlMs

/** True when a ping read the cache rather than paying to write it again. */
export const pingWasWarm = (read: number, written: number) => read > 0 && written < read * 0.1

/** `2h`, `90m`, `1h30m`; null when it does not parse or is not positive. */
export function parseDuration(text: string): number | null {
  const match = /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(text.trim())

  if (!match || (!match[1] && !match[2])) return null

  const ms = Number(match[1] ?? 0) * HOUR + Number(match[2] ?? 0) * MINUTE

  return ms > 0 ? Math.min(ms, MAX_KEEP_MS) : null
}

export type Price = { read: number; write: number }

// Dollars per million tokens: cache read, and the 1h cache write (2x input).
// Checked 2026-11-05 against this Claude Code build's claude-api skill (cached
// 2026-10-06). First match wins, so a specific id comes before its family.
const PRICES: readonly [RegExp, number, number][] = [
  [/(fable|mythos)-5-1/, 0.25, 20],
  [/(fable|mythos)-5/, 1, 20],
  [/opus-5-5/, 0.2, 8],
  [/opus-5/, 0.5, 10],
  [/opus-4/, 0.5, 10],
  [/sonnet-5/, 0.2, 4],
  [/sonnet-4/, 0.3, 6],
  [/haiku-5-5/, 0.01, 0.2],
  [/haiku-4/, 0.1, 2],
]

const HAIKU_LONG: Price = { read: 0.05, write: 1 }

/** The rates for this model at this context size; null for a model not listed. */
export function priceOf(model: string, tokens: number): Price | null {
  const id = model.toLowerCase().replace(/[\s.]+/g, '-')

  if (id.includes('haiku-5-5') && tokens > 100_000) return HAIKU_LONG

  const row = PRICES.find(([pattern]) => pattern.test(id))

  return row ? { read: row[1], write: row[2] } : null
}

export const usd = (value: number) => (value >= 100 ? `$${Math.round(value)}` : `$${value.toFixed(2)}`)

export const tok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`)

export function span(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / MINUTE))

  if (minutes < 60) return `${minutes}m`

  const hours = Math.floor(minutes / 60)

  if (hours < 24) return `${hours}h ${minutes % 60}m`

  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

const RATE_NAMES: Readonly<Record<string, string>> = { seven_day: '7D', five_hour: '5H', spend_limit: 'SPEND' }
const RATE_ORDER = ['seven_day', 'five_hour', 'spend_limit']
const LOW_AT = 15

export type Tone = 'ok' | 'watch' | 'high' | 'critical'

/** How a usage window reads by what is left: blue, amber, orange, then red. */
export const toneOf = (left: number): Tone => (left > 50 ? 'ok' : left > 25 ? 'watch' : left >= LOW_AT ? 'high' : 'critical')

export type RatePart = { name: string; left: number; isLow: boolean; tone: Tone; reset: string }

export function rateParts(rows: readonly RateRow[], now: number): RatePart[] {
  const rank = (kind: string) => {
    const at = RATE_ORDER.indexOf(kind)

    return at === -1 ? RATE_ORDER.length : at
  }

  return [...rows]
    .sort((a, b) => rank(a.kind) - rank(b.kind))
    .map(row => {
      const left = Math.max(0, Math.round((100 - row.percentUsed) * 10) / 10)
      const ms = row.resetsAt ? Date.parse(row.resetsAt) - now : Number.NaN

      return {
        name: RATE_NAMES[row.kind] ?? row.kind,
        left,
        isLow: left < LOW_AT,
        tone: toneOf(left),
        reset: Number.isNaN(ms) ? '' : ms <= 0 ? 'resetting' : span(ms),
      }
    })
}

export type CacheParts = {
  mode: 'warm' | 'cold' | 'compacted'
  /** Time left, time idle, or the compacted size: the figure beside the chip. */
  time: string
  cost: string | null
  plan: string | null
  /** The whole state in words, for a reader that cannot see the drawing. */
  summary: string
}

export function cacheParts(core: Core, now: number, options: Options): CacheParts | null {
  if (core.lastAt === 0) return null

  const size = tok(core.tokens)

  if (core.compacted) {
    return { mode: 'compacted', time: size, cost: null, plan: null, summary: `Cache compacted to ${size}, waiting for your next message.` }
  }

  const idle = Math.max(0, now - core.lastAt)
  const price = priceOf(core.model, core.tokens)
  const warmCost = price ? usd((core.tokens * price.read) / 1e6) : null
  const coldCost = price ? usd((core.tokens * price.write) / 1e6) : null

  if (idle >= options.ttlMs) {
    const time = span(idle)
    const next = coldCost ? `, next message about ${coldCost}` : ''

    return { mode: 'cold', time, cost: coldCost, plan: null, summary: `Cache cold, ${time} idle, ${size} to re-write${next}.` }
  }

  const left = `${span(options.ttlMs - idle)} left`
  const canCompact = options.autoCompact && !core.noCompact && !core.compactTried && core.tokens >= options.minTokens
  const plan =
    core.keepUntil > now
      ? `keepwarm ${span(core.keepUntil - now)}`
      : canCompact
        ? `compacts in ${span(Math.max(0, compactAtMs(options.ttlMs) - idle))}`
        : null
  const next = warmCost ? `, next message about ${warmCost}, ${coldCost} once cold` : ''

  return { mode: 'warm', time: left, cost: warmCost, plan, summary: `Cache warm, ${left}, ${size}${next}.${plan ? ` ${plan}.` : ''}` }
}

/** The first line of `/cache-keeper`, and the terminal band's cache row. */
export function cacheText(core: Core, now: number, options: Options): string | null {
  const parts = cacheParts(core, now, options)

  return parts && parts.summary
}
