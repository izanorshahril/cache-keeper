/** What the mod knows about one session; kept in `$.state` and `$.store`. */
export type Core = {
  /** When the last main-thread request started (the cache TTL runs from there); 0 before any. */
  lastAt: number
  /** The context, in tokens, as the last response reported it. */
  tokens: number
  window: number
  model: string
  /** Compacted, by anyone, with no real turn since: nothing more to compact. */
  compacted: boolean
  /** Auto compact already tried this idle period, whatever came of it. */
  compactTried: boolean
  /** `/cache-keeper compact off` for this session. */
  noCompact: boolean
  /** Keepwarm pings run until this time; 0 when off. */
  keepUntil: number
  updatedAt: number
}

export type RateRow = { kind: string; percentUsed: number; resetsAt?: string }

declare module 'claude-code' {
  interface PluginState {
    'cache-keeper': { core: Core; rate: RateRow[] }
  }
}
