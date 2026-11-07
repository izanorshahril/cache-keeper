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
  replyModel: '',
  compacted: false,
  compactTried: false,
  noCompact: false,
  keepUntil: 0,
  updatedAt: 0,
  byModel: {},
  armed: false,
}

export type Options = {
  autoCompact: boolean
  /** Hold the machine awake while an idle compaction or keepwarm still waits on a warm cache. */
  keepAwake: boolean
  guard: 'ask' | 'warn' | 'off'
  ttlMs: number
  minTokens: number
  /** Idle time before the one auto compact: shortly before the cache goes cold, or the compactAfter duration. */
  compactAt: number
  /** compactAfter is auto, so the timing may move ahead of Claude Code's own idle compaction. */
  autoTiming: boolean
  /** Claude Code's own idle compaction, as read at session start; null where it is off. */
  builtin: Builtin | null
}

/** Claude Code's idle compaction: it acts at a fraction of a 1h cache's life, on a context of at least minTokens. */
export type Builtin = { minTokens: number; fireAt: number }

export function parseOptions(raw: Readonly<Record<string, unknown>>): Options {
  const minTokens = Number(raw.minTokens)

  const ttlMs = raw.cacheTtl === '5m' ? 5 * MINUTE : HOUR
  const after = typeof raw.compactAfter === 'string' && raw.compactAfter !== 'auto' ? parseDuration(raw.compactAfter) : null

  return {
    // On unless turned off: a compaction while the cache is warm is what makes coming back cheap.
    autoCompact: raw.autoCompact !== 'off',
    keepAwake: raw.keepAwake === 'on',
    guard: raw.guard === 'warn' || raw.guard === 'off' ? raw.guard : 'ask',
    ttlMs,
    // A compaction must start while the cache still serves it, so a longer setting is held a minute short of cold.
    compactAt: after === null ? compactAtMs(ttlMs) : Math.min(after, ttlMs - MINUTE),
    autoTiming: after === null,
    builtin: null,
    minTokens: Number.isFinite(minTokens) && minTokens > 0 ? minTokens : 50_000,
  }
}

/** Compact 5 minutes before a 1h cache goes cold, 1 minute before a 5m one. */
export const compactAtMs = (ttlMs: number) => ttlMs - Math.max(MINUTE, Math.min(5 * MINUTE, ttlMs / 5))

/**
 * With Claude Code's own idle compaction on as well, an auto timing goes two minutes ahead of it, so
 * the fallback compacts first and Claude Code's later run finds a small context instead of writing a
 * second summary. A compactAfter that was set is kept as set.
 */
export function aheadOfBuiltin(options: Options): number {
  const base = options.autoTiming ? compactAtMs(options.ttlMs) : options.compactAt
  const { builtin } = options

  if (!options.autoCompact || !options.autoTiming || !builtin || options.ttlMs !== HOUR) return base

  return Math.min(base, builtin.fireAt * HOUR - 2 * MINUTE)
}

/** Ping well ahead of the compact point, so a keepwarm window ending hands over cleanly. */
export const pingEveryMs = (ttlMs: number) => Math.round((ttlMs * 5) / 6) - MINUTE

export type Idle = {
  now: number
  core: Core
  options: Options
  isTurnRunning: boolean
  nextPingAt: number
  /** A skipped or failed compaction waits until this time before it is tried again. */
  nextCompactAt?: number
}

export type Action = 'none' | 'compact' | 'ping'

/** The one decision the idle timer makes; `compacted` is what stops a recompact. */
export function decide({ now, core, options, isTurnRunning, nextPingAt, nextCompactAt = 0 }: Idle): Action {
  if (core.lastAt === 0 || isTurnRunning || core.compacted) return 'none'

  const idle = now - core.lastAt

  if (idle >= options.ttlMs) return 'none'

  if (core.keepUntil > now) {
    return idle >= pingEveryMs(options.ttlMs) && now >= nextPingAt ? 'ping' : 'none'
  }

  const canCompact =
    options.autoCompact && core.armed && !core.noCompact && !core.compactTried && core.tokens >= options.minTokens

  return canCompact && now >= nextCompactAt && idle >= options.compactAt ? 'compact' : 'none'
}

/**
 * Whether to hold the machine awake now: keep awake is on, and an idle compaction (the fallback's
 * or Claude Code's) or keepwarm still waits on a warm cache. A compaction done, or a cache gone
 * cold, lets the machine sleep again: nothing is left that waking could save.
 */
export function wantsAwake(core: Core, now: number, options: Options): boolean {
  if (!options.keepAwake || core.lastAt === 0 || core.compacted || now - core.lastAt >= options.ttlMs) return false
  if (core.keepUntil > now) return true

  const fallback = options.autoCompact && core.armed && !core.noCompact && !core.compactTried && core.tokens >= options.minTokens
  const builtin = options.builtin !== null && options.ttlMs === HOUR && core.tokens >= options.builtin.minTokens

  return fallback || builtin
}

/** True when a ping read the cache rather than paying to write it again. */
export const pingWasWarm = (read: number, written: number) => read > 0 && written < read * 0.1

/** `2h`, `90m`, `1h30m`; null when it does not parse or is not positive. */
export function parseDuration(text: string): number | null {
  const match = /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(text.trim())

  if (!match || (!match[1] && !match[2])) return null

  const ms = Number(match[1] ?? 0) * HOUR + Number(match[2] ?? 0) * MINUTE

  return ms > 0 ? Math.min(ms, MAX_KEEP_MS) : null
}

export type Price = { name: string; read: number; write: number }

// Dollars per million tokens: cache read, and the 1h cache write (2x input). The
// name is the cache key, since each model keeps its own cache. Checked against the
// claude-api skill's model table (cached 2026-10-06). First match wins, so a
// specific id comes before its family.
const PRICES: readonly [string, RegExp, number, number][] = [
  ['fable-5-1', /(fable|mythos)-5-1/, 0.25, 20],
  ['fable-5', /(fable|mythos)-5/, 1, 20],
  ['opus-5-5', /opus-5-5/, 0.2, 8],
  ['opus-5', /opus-5/, 0.5, 10],
  ['opus-4', /opus-4/, 0.5, 10],
  ['sonnet-5-5', /sonnet-5-5/, 0.2, 4],
  ['sonnet-5', /sonnet-5/, 0.2, 4],
  ['sonnet-4', /sonnet-4/, 0.3, 6],
  ['haiku-5-5', /haiku-5-5/, 0.01, 0.2],
  ['haiku-4', /haiku-4/, 0.1, 2],
]

// Haiku 5.5 prices a prompt over 100K tokens at five times its base rate.
const HAIKU_LONG = { read: 0.05, write: 1 }

const ALIASES: Readonly<Record<string, string>> = {
  fable: 'claude-fable-5-1',
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
}

/** The id a model name means: a bare alias takes its current model, and a `[1m]` suffix is dropped. */
function canonical(model: string): string {
  const bare = model.toLowerCase().replace(/\[.*\]$/, '').trim()

  return (ALIASES[bare] ?? bare).replace(/[\s.]+/g, '-')
}

/** The rates for this model at this context size; null for a model not listed. */
export function priceOf(model: string, tokens: number): Price | null {
  const id = canonical(model)

  if (id.includes('haiku-5-5') && tokens > 100_000) return { name: 'haiku-5-5', ...HAIKU_LONG }

  const row = PRICES.find(([, pattern]) => pattern.test(id))

  return row ? { name: row[0], read: row[2], write: row[3] } : null
}

/** A headless or SDK session refuses `$.session.compact`, and says so in this wording. */
export const isHeadlessRefusal = (error: unknown): boolean => /headless|SDK session/i.test(String(error))

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/**
 * Claude Code's own idle compaction, read the way Claude Code 2.1.317 reads it: a staged rollout
 * (the tengu_sunny_locket flag cached in ~/.claude.json) that no setting turns on, and that
 * `"idleCompaction": false` or auto-compact off turns off. It fires at 90% of a 1h cache's life,
 * on a context of 200k tokens or more unless the rollout or CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS
 * says otherwise (never under 100k).
 */
export function builtinIdle(config: unknown, settings: unknown, envMinTokens?: string): Builtin | null {
  const flag = (config as { cachedGrowthBookFeatures?: { tengu_sunny_locket?: { mode?: unknown; minTokens?: unknown; fireAtFraction?: unknown } } } | null)
    ?.cachedGrowthBookFeatures?.tengu_sunny_locket
  const autoCompact = (config as { autoCompactEnabled?: unknown } | null)?.autoCompactEnabled
  const s = settings as { idleCompaction?: unknown; autoCompactEnabled?: unknown } | null

  if (flag?.mode !== 'compact' && flag?.mode !== 'compact_on_return') return null
  if (s?.idleCompaction === false || s?.autoCompactEnabled === false || autoCompact === false) return null

  const fromEnv = envMinTokens === undefined ? Number.NaN : Number(envMinTokens)
  const min = Number.isFinite(fromEnv) ? fromEnv : flag.minTokens
  const fraction = flag.fireAtFraction

  return {
    minTokens: finite(min) ? Math.max(100_000, min) : 200_000,
    fireAt: finite(fraction) ? Math.min(0.95, Math.max(0.5, fraction)) : 0.9,
  }
}

/** The cache key of a model: its price row, or its id when none is listed. */
export const familyKey = (model: string): string => priceOf(model, 0)?.name ?? canonical(model)

/** The model a reading means: a name the price table does not list ("default", "opusplan") is the last model selected. */
export function resolveModel(selected: string, core: Core): string {
  return priceOf(selected, 0) ? selected : core.model || selected
}

/** The label the band shows for a model, such as Opus. */
export function shortName(model: string): string {
  const key = familyKey(model)
  const family = ['fable', 'opus', 'sonnet', 'haiku'].find(name => key.includes(name))

  return family ? family.charAt(0).toUpperCase() + family.slice(1) : canonical(model)
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
const RATE_ORDER = ['five_hour', 'seven_day', 'spend_limit']
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

/** The write rate for the TTL in force: 2x input for 1h, 1.25x for 5m. */
const writeRate = (price: Price, ttlMs: number) => (ttlMs <= 5 * MINUTE ? price.write * 0.625 : price.write)

/** When this model last read or wrote the cache, as the session saw it; 0 when unused. */
const lastOn = (core: Core, model: string): number => core.byModel?.[familyKey(model)] ?? 0

/**
 * Whether this model's cache still serves the next message. Caches are kept per
 * model, and a compaction rewrites the prefix for all of them.
 */
export const isWarmOn = (core: Core, model: string, now: number, options: Options): boolean => {
  const last = lastOn(core, model)

  return !core.compacted && last > 0 && now - last < options.ttlMs
}

/** A message needs the cold-cache warning on any model, Haiku too, with its model's cache cold and a large context. */
export function needsWarning(core: Core, model: string, now: number, options: Options): boolean {
  return !isWarmOn(core, model, now, options) && core.tokens >= options.minTokens
}

/** Model families from the cheapest up; a model not listed ranks with the large ones. */
const TIERS = ['Haiku', 'Sonnet', 'Opus', 'Fable']
const rankOf = (model: string) => {
  const at = TIERS.indexOf(shortName(model))

  return at === -1 ? TIERS.length : at
}
const isHaiku = (model: string) => shortName(model) === 'Haiku'

/** Which of the four cold-send questions applies: the last reply's model, then the model about to send. */
export type ColdCase = 'large-large' | 'large-haiku' | 'haiku-large' | 'haiku-haiku'

export function coldCase(lastModel: string, selected: string): ColdCase {
  const from = lastModel && isHaiku(lastModel) ? 'haiku' : 'large'

  return `${from}-${isHaiku(selected) ? 'haiku' : 'large'}` as ColdCase
}

/**
 * What the cold-send question offers. `send` re-writes the whole cache at full price; `switch`
 * and `compact` cost less; `cancel` keeps the text.
 */
export type ColdChoice = 'send' | 'switch' | 'compact' | 'cancel'

export function coldChoices(kind: ColdCase, selected: string): ColdChoice[] {
  if (kind === 'haiku-haiku') return ['send', 'cancel']
  if (kind === 'large-large' && lowerModels(selected).length > 0) return ['send', 'switch', 'compact', 'cancel']

  return ['send', 'compact', 'cancel']
}

/** The models below this one, the next one down first: what "continue on a lower model" offers. */
export function lowerModels(selected: string): string[] {
  return ESTIMATE_MODELS.filter(model => rankOf(model) < rankOf(selected))
}

/**
 * The models a compaction may run on before the send. A large model that stays large picks any
 * model; every other case compacts on Haiku, the one it named.
 */
export function compactModels(kind: ColdCase, selected: string): string[] {
  if (kind === 'large-large') return [...ESTIMATE_MODELS].reverse()
  if (kind === 'large-haiku') return [isHaiku(selected) ? selected : 'claude-haiku-5-5']

  return ['claude-haiku-5-5']
}

/** Whether the compaction's model and effort are picked, or fixed by the case. */
export const picksCompactModel = (kind: ColdCase) => kind === 'large-large'

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type Effort = (typeof EFFORTS)[number]
export const isEffort = (value: string): value is Effort => (EFFORTS as readonly string[]).includes(value)

export type NextCost = { label: string; usd: number; warm: boolean }

/** What the next message costs on this model: a read if its cache is warm, else a write of the whole context. */
export function nextCost(core: Core, model: string, now: number, options: Options): NextCost | null {
  const price = priceOf(model, core.tokens)

  if (!price) return null

  const warm = isWarmOn(core, model, now, options)
  const rate = warm ? price.read : writeRate(price, options.ttlMs)

  return { label: shortName(model), usd: (core.tokens * rate) / 1e6, warm }
}

/** The current model of each family: what a switch is priced against. */
export const ESTIMATE_MODELS = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']

/** The next message's cost on every listed model, so a switch can be priced before it is made. */
export function estimates(core: Core, now: number, options: Options): NextCost[] {
  return ESTIMATE_MODELS.flatMap(model => {
    const cost = nextCost(core, model, now, options)

    return cost ? [cost] : []
  })
}

/** How this model's cache stands, in words, for the guard's question. */
export function coldState(core: Core, model: string, now: number, options: Options): string {
  const last = lastOn(core, model)

  if (last === 0) return 'has nothing cached yet'
  if (core.compacted) return 'was compacted'

  return `went cold ${span(now - last - options.ttlMs)} ago`
}

/**
 * Idle compaction, always named so the feature is never a surprise: cache-seer's own where
 * it is on, else Claude Code's own, else off. A timer shows only when one will fire this idle.
 */
export function compactStatus(core: Core, now: number, options: Options, isWarm: boolean): string {
  const sinceAny = Math.max(0, now - core.lastAt)

  if (core.keepUntil > now && isWarm) return `keepwarm ${span(core.keepUntil - now)}`

  if (options.autoCompact && !core.noCompact) {
    const willFire = isWarm && core.armed && !core.compactTried && core.tokens >= options.minTokens

    return willFire ? `idle compact in ${span(Math.max(0, options.compactAt - sinceAny))}` : 'idle compact on'
  }

  const builtin = options.builtin

  if (builtin) {
    const willFire = isWarm && options.ttlMs === HOUR && core.tokens >= builtin.minTokens

    return willFire ? `idle compact in ${span(Math.max(0, builtin.fireAt * HOUR - sinceAny))}` : 'idle compact on'
  }

  return 'idle compact off'
}

/** What the compaction line means at a glance: a countdown runs, it is on but waits, or it is off. */
export type PlanState = 'timer' | 'on' | 'off'

/** The state a compaction line states in words, for the icon drawn beside it. */
export function planStateOf(plan: string): PlanState {
  if (plan.startsWith('keepwarm') || / in \d/.test(plan)) return 'timer'

  return plan.endsWith(' off') ? 'off' : 'on'
}

export type CacheParts = {
  mode: 'warm' | 'cold' | 'compacted'
  /** Time left or idle on the selected model, or the compacted size: the figure beside the chip. */
  time: string
  /** The model that prices the next message, and that price: `Opus $0.04`. */
  cost: string
  plan: string | null
  planState: PlanState | null
  /** The summary without the compaction line, for a surface that draws that line on its own. */
  lead: string
  /** The whole state in words, for a reader that cannot see the drawing. */
  summary: string
}

/** The cache as the selected model sees it: its own warm or cold state, and its price for the next message. */
export function cacheParts(core: Core, now: number, options: Options, model: string): CacheParts | null {
  if (core.lastAt === 0) return null

  const size = tok(core.tokens)
  const label = shortName(model)

  if (core.compacted) {
    const summary = `Cache compacted to ${size}, waiting for your next message.`

    return { mode: 'compacted', time: size, cost: label, plan: null, planState: null, lead: summary, summary }
  }

  const price = nextCost(core, model, now, options)
  const cost = price ? `${label} ${usd(price.usd)}` : label
  const quote = price ? `, about ${usd(price.usd)}` : ''
  const last = lastOn(core, model)

  if (!isWarmOn(core, model, now, options)) {
    const time = last ? span(now - last) : 'not recorded'
    const summary = last
      ? `Cache cold on ${label}, ${time} idle, ${size} to re-write${quote}.`
      : `No ${label} reply recorded in this session, so its cache is taken as cold: ${size} to write${quote}.`

    const plan = compactStatus(core, now, options, false)

    return { mode: 'cold', time, cost, plan, planState: planStateOf(plan), lead: summary, summary: `${summary} ${plan}.` }
  }

  const left = `${span(options.ttlMs - (now - last))} left`
  const plan = compactStatus(core, now, options, true)

  const lead = `Cache warm on ${label}, ${left}, ${size}${quote}.`

  return { mode: 'warm', time: left, cost, plan, planState: planStateOf(plan), lead, summary: `${lead} ${plan}.` }
}

/** The cache line for `/cache-seer` and the terminal band. */
export function cacheText(core: Core, now: number, options: Options, model: string): string | null {
  return cacheParts(core, now, options, model)?.summary ?? null
}
