/** What the mod knows about one session; kept in `$.state` and `$.store`. */
export type Core = {
  /** When the last main-thread request started (the cache TTL runs from there); 0 before any. */
  lastAt: number
  /** The context, in tokens, as the last response reported it. */
  tokens: number
  window: number
  /** The model last selected, as a name the price table lists. */
  model: string
  /** The model that made the last main-thread request: what a resumed session's idle time belongs to. */
  replyModel: string
  /** Compacted, by anyone, with no real turn since: nothing more to compact. */
  compacted: boolean
  /** Auto compact already tried this idle period, whatever came of it. */
  compactTried: boolean
  /** `/cache-seer compact off` for this session. */
  noCompact: boolean
  /** Keepwarm pings run until this time; 0 when off. */
  keepUntil: number
  /** When each model last read or wrote this session's cache, keyed by price row (opus-5-5). */
  byModel: Record<string, number>
  /** A turn has finished: a mirror for reading the store; auto compact goes by the process's own flag. */
  armed: boolean
  updatedAt: number
}

export type RateRow = { kind: string; percentUsed: number; resetsAt?: string }

declare module 'claude-code' {
  interface PluginState {
    'cache-seer': { core: Core; rate: RateRow[] }
  }
}
