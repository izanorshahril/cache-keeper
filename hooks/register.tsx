import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Core, RateRow } from '../types'
import { BG, MODE_HUE, MUTED, TONE, mascotSvg, statusSvg, usageSvg } from './art'
import type { Options } from './logic'
import {
  DEFAULT_KEEP_MS,
  EMPTY,
  HOUR,
  MINUTE,
  cacheParts,
  cacheText,
  decide,
  isCold,
  parseDuration,
  parseOptions,
  pingWasWarm,
  priceOf,
  rateParts,
  span,
  tok,
  usd,
} from './logic'

const core = atom({ plugin: 'cache-keeper', key: 'core' } as const, EMPTY)
const rate = atom({ plugin: 'cache-keeper', key: 'rate' } as const, [] as RateRow[])

const TICK_MS = 30_000
const MAX_PING_RETRIES = 3
const STALE_AFTER_MS = 7 * 24 * HOUR
const ATTENDED = new Set<string>(['composer', 'bridge', 'sdk'])

const sessionKey = (id: string) => `session:${id}`

async function patch($: EngineInterface, change: (value: Core) => Core): Promise<void> {
  await update($, core, value => change(value ?? EMPTY))

  const next = await read($, core)
  const now = await $.clock.now()

  await $.store.set(sessionKey(await $.session.id()), { ...next, updatedAt: now })
}

/** Drops sessions nobody can resume warm any more, so the store stays small. */
async function pruneStore($: EngineInterface, now: number): Promise<void> {
  for (const key of await $.store.keys()) {
    if (!key.startsWith('session:')) continue

    const value = (await $.store.get(key)) as Partial<Core> | undefined

    if (now - (value?.updatedAt ?? 0) > STALE_AFTER_MS) await $.store.delete(key)
  }
}

// Lost on a reload, and safe to lose: the worst case is one more tick's wait.
let isTurnRunning = false
let isBusy = false
let isCompacting = false
let nextPingAt = 0
let pingRetries = 0
let cancelTick: (() => void) | null = null

async function measure($: EngineInterface): Promise<void> {
  const usage = await $.session.usage()
  const model = await $.session.model()
  const tokens = usage.context.tokens

  await update($, rate, () =>
    usage.rateLimits.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, ...(resetsAt ? { resetsAt } : {}) })),
  )
  await patch($, c => ({
    ...c,
    model: model || c.model,
    window: usage.context.window,
    tokens: tokens && tokens > 0 ? tokens : c.tokens,
  }))
}

async function runCompact($: EngineInterface, idleMs: number): Promise<void> {
  isCompacting = true
  // Set first and left set: one attempt per idle period, even if it fails.
  await patch($, c => ({ ...c, compactTried: true }))

  try {
    const before = (await read($, core)).tokens
    const result = await $.session.compact()

    if (result.skip !== undefined) {
      $.ui.log(`cache-keeper: auto compact skipped: ${result.skip}`, { to: 'debug' })
      return
    }

    const after = result.tokensAfter ?? 0

    await patch($, c => ({ ...c, compacted: true, tokens: after > 0 ? after : c.tokens }))
    $.ui.log(`cache-keeper: compacted ${tok(before)} to ${tok(after)} after ${span(idleMs)} idle, before the cache went cold.`)
  } catch (error) {
    $.ui.log(`cache-keeper: auto compact failed: ${String(error)}`, { to: 'debug' })
  } finally {
    isCompacting = false
  }
}

async function runPing($: EngineInterface, now: number): Promise<void> {
  const reply = await $.model.fork({ prompt: 'Reply with the single word: warm' })

  if (reply.isAnswered) {
    const { cache_read_input_tokens: readTokens, cache_creation_input_tokens: written } = reply.usage

    pingRetries = 0

    if (pingWasWarm(readTokens, written)) {
      await patch($, c => ({ ...c, lastAt: now }))
    } else {
      await patch($, c => ({ ...c, keepUntil: 0 }))
      $.ui.log(`cache-keeper: keepwarm stopped: the ping read ${tok(readTokens)} and wrote ${tok(written)}, so the cache was already gone.`)
    }

    return
  }

  const isTransient =
    reply.reason === 'api-error' && (reply.status == null || reply.status === 429 || reply.status >= 500)

  if (isTransient && pingRetries < MAX_PING_RETRIES) {
    nextPingAt = now + MINUTE * 2 ** pingRetries
    pingRetries += 1
    return
  }

  await patch($, c => ({ ...c, keepUntil: 0 }))
  $.ui.log(`cache-keeper: keepwarm stopped: ${reply.reason}.`)
}

async function tick($: EngineInterface, options: Options): Promise<void> {
  $.ui.invalidate('ui.render')

  if (isBusy) return

  isBusy = true

  try {
    const now = await $.clock.now()
    const value = await read($, core)
    const action = decide({ now, core: value, options, isTurnRunning, nextPingAt })

    if (action === 'none') return

    // Asked only now: a background agent still working means this is no idle.
    const agents = await $.agent.list()

    if (agents.some(agent => agent.status === 'running' || agent.status === 'pending')) return

    if (action === 'ping') {
      await runPing($, now)
      return
    }

    // Someone is typing: leave the context as it is.
    if ((await $.prompt.read()).text.trim() !== '') return

    await runCompact($, now - value.lastAt)
  } finally {
    isBusy = false
  }
}

export const register: Register = (on, rawOptions) => {
  const options = parseOptions(rawOptions as Readonly<Record<string, unknown>>)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'cache-keeper',
      description: 'Shows the prompt cache state; "compact on" or "compact off" sets auto compact for this session.',
      argumentHint: '[compact on|off]',
    })
    await $.command.register({
      name: 'keepwarm',
      description: 'Keeps the cache warm with billed pings while idle, instead of auto compacting.',
      argumentHint: '[6h|90m|off]',
    })

    const now = await $.clock.now()
    const stored = (await $.store.get(sessionKey(await $.session.id()))) as Partial<Core> | undefined

    if (stored) await update($, core, () => ({ ...EMPTY, ...stored }))

    await pruneStore($, now)
    await measure($)

    cancelTick?.()
    const timer = $.clock.every(TICK_MS, () => {
      void tick($, options)
    })
    cancelTick = () => timer.cancel()

    return next(e)
  })

  on('session.end', ($, e, next) => {
    cancelTick?.()
    cancelTick = null

    return next(e)
  })

  on('classic.SessionStart', async ($, e, next) => {
    const now = await $.clock.now()

    if (e.source === 'clear') {
      await patch($, () => EMPTY)
    } else if (e.source === 'compact') {
      await patch($, c => ({ ...c, compacted: true }))
    } else if (e.source === 'resume' || e.source === 'fork') {
      const seconds = e.seconds_since_last_response
      const tokens = e.context_tokens

      await patch($, c => ({
        ...c,
        lastAt: c.lastAt === 0 && seconds !== undefined ? now - seconds * 1000 : c.lastAt,
        tokens: c.tokens === 0 && tokens ? tokens : c.tokens,
        model: c.model || e.model || '',
      }))
    }

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits') || e.changed.includes('context')) await measure($)

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId && !isCompacting) {
      isTurnRunning = true
      // A real turn adds context, so a later idle may compact again.
      await patch($, c => ({ ...c, compacted: false, compactTried: false }))
    }

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (!e.agentId && !isCompacting) {
      // The cache TTL runs from the start of the request.
      const now = await $.clock.now()

      await patch($, c => ({ ...c, lastAt: now }))
    }

    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      isTurnRunning = false

      const now = await $.clock.now()
      const model = e.usage?.model

      await patch($, c => ({
        ...c,
        // Only a turn no step stamped, and one that really made a request.
        lastAt: e.usage && now - c.lastAt > e.durationMs ? now : c.lastAt,
        model: model || c.model,
      }))
      await measure($)
    }

    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)

    if (!e.agentId && e.trigger !== 'precompute' && result.skip === undefined) {
      const after = result.tokensAfter ?? 0

      await patch($, c => ({ ...c, compacted: true, tokens: after > 0 ? after : c.tokens }))
    }

    return result
  })

  on('prompt.submit', async ($, e, next) => {
    if (options.guard === 'off' || e.command || e.isMeta || e.turnId || !ATTENDED.has(e.origin.kind)) return next(e)

    const now = await $.clock.now()
    const value = await read($, core)

    if (!isCold(value, now, options.ttlMs) || value.tokens < options.minTokens) return next(e)

    const price = priceOf(value.model, value.tokens)
    const cost = price ? usd((value.tokens * price.write) / 1e6) : null
    const estimate = cost ? `about ${cost} at list price` : 'an unpriced model'
    const coldFor = span(now - value.lastAt - options.ttlMs)

    if (options.guard === 'warn') {
      $.ui.log(`cache-keeper: cold send, re-writing ${tok(value.tokens)} tokens, ${estimate}.`)
      return next(e)
    }

    const send = cost ? `Send anyway (${cost})` : 'Send anyway'
    let answer: string

    try {
      answer = await $.ui.ask(
        `The prompt cache went cold ${coldFor} ago. This message re-writes ${tok(value.tokens)} tokens, ${estimate}. Send it?`,
        { header: 'Cold cache', options: [send, "Don't send"] },
      )
    } catch {
      // A dialog that could not be shown must never eat a prompt.
      $.ui.log(`cache-keeper: cold send, re-writing ${tok(value.tokens)} tokens, ${estimate}.`)
      return next(e)
    }

    if (answer === send) return next(e)

    // A surface with no prompt box cannot take the text back, so the notice carries it.
    const isRestored = await $.prompt.fill({ text: e.text }).then(
      filled => filled.isFilled,
      () => false,
    )

    return {
      drop: isRestored
        ? 'cache-keeper: not sent, your text is back in the box. Use /compact or send it when ready.'
        : `cache-keeper: not sent. Your text: ${e.text.slice(0, 3500)}`,
    }
  })

  on('command.run', { command: 'cache-keeper' }, async ($, e) => {
    const arg = e.args.trim()

    if (arg === 'compact on' || arg === 'compact off') {
      await patch($, c => ({ ...c, noCompact: arg === 'compact off' }))
      return { text: `Auto compact is ${arg === 'compact off' ? 'off' : 'on'} for this session.` }
    }

    if (arg !== '') return { text: 'Usage: /cache-keeper [compact on|off]' }

    const now = await $.clock.now()
    const value = await read($, core)
    const rows = rateParts(await read($, rate), now).map(
      part => `${part.name} ${part.left}%${part.isLow ? ' LOW' : ''}${part.reset ? ` (${part.reset})` : ''}`,
    )
    const cache = cacheText(value, now, options) ?? 'Cache: no request yet.'
    const autoCompact = options.autoCompact && !value.noCompact ? 'on' : 'off'

    return {
      text: [
        cache,
        ...(rows.length ? [`usage left: ${rows.join(', ')}`] : []),
        `auto compact: ${autoCompact}, floor ${tok(options.minTokens)}; guard: ${options.guard}; cache TTL: ${span(options.ttlMs)}`,
        'Dollar figures are API list-price estimates, not subscription charges.',
      ].join('\n'),
    }
  })

  on('command.run', { command: 'keepwarm' }, async ($, e) => {
    const arg = e.args.trim()

    if (arg === 'off') {
      await patch($, c => ({ ...c, keepUntil: 0 }))
      return { text: 'Keepwarm is off.' }
    }

    const ms = arg === '' ? DEFAULT_KEEP_MS : parseDuration(arg)

    if (ms === null) return { text: 'Usage: /keepwarm [6h|90m|off]' }

    const now = await $.clock.now()
    const value = await read($, core)

    if (value.compacted) return { text: 'This session is already compacted, so there is no large cache to keep warm.' }

    nextPingAt = 0
    pingRetries = 0
    await patch($, c => ({ ...c, keepUntil: now + ms }))

    return { text: `Keepwarm is on for ${span(ms)}. Each ping is billed as a cache read plus a short reply; auto compact waits until it ends.` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const now = await $.clock.now()
    const value = await read($, core)
    const rows = await read($, rate)
    const cache = cacheParts(value, now, options)

    if (!cache && rows.length === 0) return next(e)

    const parts = rateParts(rows, now)
    const columns = e.props.bodyColumns ?? e.viewport?.columns ?? 100
    const ui = $.ui.resolve(e)
    const { Box, Text } = ui
    // The terminal's table lists Svg too, so ask the surface.
    const Svg = e.surface !== 'terminal' && 'Svg' in ui ? ui.Svg : null

    if (!Svg) {
      return (
        <Box flexDirection="column">
          {parts.length > 0 ? (
            <Box flexDirection="row" flexWrap="wrap">
              {parts.map(part => (
                <Box key={part.name} marginRight={3}>
                  <Text color={MUTED} bold>
                    {part.name}{' '}
                  </Text>
                  <Text color={TONE[part.tone]} bold>
                    {part.left}% left{part.isLow ? ' LOW' : ''}
                  </Text>
                  {part.reset ? <Text color={TONE[part.tone]}> · {part.reset}</Text> : null}
                </Box>
              ))}
            </Box>
          ) : null}
          {cache ? <Text color={MODE_HUE[cache.mode]}>{cache.summary}</Text> : null}
        </Box>
      )
    }

    // Each drawing's source changes only when its words do, so nothing restarts on a redraw.
    const usage = parts.length > 0 ? usageSvg(parts, columns >= 70 ? 10 : 5) : null
    const figure = cache ? mascotSvg(cache.mode) : null
    const status = cache ? statusSvg(cache) : null
    const usageAlt = parts.map(part => `${part.name} ${part.left}% left`).join(', ')

    return (
      <Box flexDirection="row" flexWrap="wrap" alignItems="center" backgroundColor={BG} paddingX={1}>
        {usage ? (
          <Box key="usage" flexShrink={0} marginRight={2}>
            <Svg source={usage.source} alt={usageAlt} width={usage.width} height={usage.height} />
          </Box>
        ) : null}
        {figure && status && cache ? (
          <Box key="cache" flexDirection="row" alignItems="center" flexShrink={0}>
            <Box key="figure" flexShrink={0} marginRight={1}>
              <Svg source={figure.source} alt={cache.summary} width={figure.width} height={figure.height} isInteractive />
            </Box>
            <Box key="status" flexShrink={0}>
              <Svg source={status.source} alt={cache.summary} width={status.width} height={status.height} />
            </Box>
          </Box>
        ) : null}
      </Box>
    )
  })
}
