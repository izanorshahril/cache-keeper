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
  /** `/cache-keeper compact off` for this session. */
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

/** The cold-send dialog the band shows while a held message waits for a pick; null when none waits. */
export type ColdAsk = {
  /** The message held back, also put back in the prompt box. */
  text: string
  /** The last reply's model, then the model about to send: `large-large`, `large-haiku`, `haiku-large`, `haiku-haiku`. */
  kind: 'large-large' | 'large-haiku' | 'haiku-large' | 'haiku-haiku'
  /** The model the message would be sent on. */
  selected: string
  /** How the cache went cold, as the band words it. */
  coldFor: string
  tokens: number
  step: 'choose' | 'model' | 'effort' | 'working'
  /** The road picked at `choose`, once one needing a model or effort is. */
  road?: 'switch' | 'compact'
  /** The model picked at `model`. */
  model?: string
}

declare module 'claude-code' {
  interface PluginState {
    'cache-keeper': { core: Core; rate: RateRow[]; ask: ColdAsk | null }
  }
}
