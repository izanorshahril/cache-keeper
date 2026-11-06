import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Core, RateRow } from '../types'
import { BG, MODE_HUE, MUTED, PLAN_GLYPH, PLAN_HUE, TONE, mascotSvg, statusSvg, usageSvg } from './art'
import type { Options } from './logic'
import {
  DEFAULT_KEEP_MS,
  EMPTY,
  HOUR,
  MINUTE,
  cacheParts,
  cacheText,
  decide,
  coldState,
  estimates,
  familyKey,
  builtinIdle,
  isHeadlessRefusal,
  isWarmOn,
  needsWarning,
  switchTargets,
  nextCost,
  shortName,
  parseDuration,
  parseOptions,
  pingWasWarm,
  priceOf,
  rateParts,
  resolveModel,
  span,
  tok,
  usd,
} from './logic'

const core = atom({ plugin: 'cache-keeper', key: 'core' } as const, EMPTY)
const rate = atom({ plugin: 'cache-keeper', key: 'rate' } as const, [] as RateRow[])

const TICK_MS = 30_000
const COMPACT_RETRY_MS = 2 * MINUTE
const MAX_PING_RETRIES = 3
const STALE_AFTER_MS = 7 * 24 * HOUR
const ATTENDED = new Set<string>(['composer', 'bridge', 'sdk'])

const RATE_KEY = 'rate'
const sessionKey = (id: string) => `session:${id}`

// The session whose saved record is in `core`. A resume can raise its hooks before session start,
// and a write then must build on the saved record, not on an empty one.
let loadedFor = ''

async function ensureLoaded($: EngineInterface): Promise<void> {
  const id = await $.session.id()

  if (loadedFor === id) return

  loadedFor = id

  const stored = (await $.store.get(sessionKey(id))) as Partial<Core> | undefined

  await update($, core, () => ({ ...EMPTY, ...stored, byModel: { ...stored?.byModel } }))
}

async function patch($: EngineInterface, change: (value: Core) => Core): Promise<void> {
  await ensureLoaded($)
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
let nextCompactAt = 0
let pingRetries = 0
let cancelTick: (() => void) | null = null
// Compaction is a direct call in an interactive session, and a /compact turn where the engine refuses the call.
let viaCommand = false
// A turn has finished in this process. In memory, so a host that re-runs session start cannot clear it.
let armedHere = false

/**
 * Usage is the account's, not the session's, so every session shows the newest
 * reading any of them saved: a session has none of its own until its first reply.
 */
async function loadSavedRate($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const saved = ((await $.store.get(RATE_KEY)) ?? []) as RateRow[]
  const rows = saved.filter(row => row.resetsAt !== undefined && Date.parse(row.resetsAt) > now)

  if (JSON.stringify(rows) !== JSON.stringify(await read($, rate))) await update($, rate, () => rows)
}

async function measure($: EngineInterface): Promise<void> {
  const usage = await $.session.usage()
  const model = await $.session.model()
  const tokens = usage.context.tokens

  if (usage.rateLimits.length > 0) {
    const rows = usage.rateLimits.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, ...(resetsAt ? { resetsAt } : {}) }))

    await update($, rate, () => rows)
    await $.store.set(RATE_KEY, rows)
  } else {
    await loadSavedRate($)
  }

  await patch($, c => ({
    ...c,
    model: priceOf(model, 0) ? model : c.model,
    window: usage.context.window,
    tokens: tokens && tokens > 0 ? tokens : c.tokens,
  }))
}

async function readJson($: EngineInterface, file: string): Promise<unknown> {
  try {
    return JSON.parse(await $.fs.read(file))
  } catch {
    return null
  }
}

// Only what decides Claude Code's own idle compaction is read from its config and settings; nothing is kept.
async function readBuiltin($: EngineInterface) {
  const configDir = await $.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined)
  const home = (await $.env.get('HOME').catch(() => undefined)) ?? (await $.env.get('USERPROFILE').catch(() => undefined))
  // With CLAUDE_CONFIG_DIR set, .claude.json lives in it; otherwise in the home folder, beside .claude.
  const configFile = configDir ? `${configDir}/.claude.json` : home ? `${home}/.claude.json` : undefined
  const settingsFile = configDir ? `${configDir}/settings.json` : home ? `${home}/.claude/settings.json` : undefined
  const config = configFile ? await readJson($, configFile) : null
  const settings = settingsFile ? await readJson($, settingsFile) : null

  return builtinIdle(config, settings, await $.env.get('CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS').catch(() => undefined))
}

async function runCompact($: EngineInterface, idleMs: number, now: number): Promise<void> {
  isCompacting = true

  try {
    const before = (await read($, core)).tokens

    if (!viaCommand) {
      try {
        const result = await $.session.compact()

        if (result.skip !== undefined) {
          nextCompactAt = now + COMPACT_RETRY_MS
          $.ui.log(`cache-keeper: auto compact skipped after ${span(idleMs)} idle: ${result.skip}. Trying again in 2m.`)
          return
        }

        const after = result.tokensAfter ?? 0

        await patch($, c => ({ ...c, compacted: true, compactTried: true, tokens: after > 0 ? after : c.tokens }))
        $.ui.log(`cache-keeper: compacted ${tok(before)} to ${tok(after)} after ${span(idleMs)} idle, before the cache went cold.`)
        return
      } catch (error) {
        if (!isHeadlessRefusal(error)) throw error
        // The engine compacts a headless or SDK session only inside a turn, so /compact runs as if typed from now on.
        viaCommand = true
      }
    }

    await $.command.run({ command: 'compact', args: '' })
    // The engine may not report the size after a /compact turn, so the last figure stays until the next reply.
    await patch($, c => ({ ...c, compacted: true, compactTried: true }))
    $.ui.log(`cache-keeper: compacted with /compact after ${span(idleMs)} idle, before the cache went cold.`)
  } catch (error) {
    nextCompactAt = now + COMPACT_RETRY_MS
    $.ui.log(`cache-keeper: auto compact failed after ${span(idleMs)} idle: ${String(error)}. Trying again in 2m.`)
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
    await loadSavedRate($)

    const now = await $.clock.now()
    const value = await read($, core)
    const action = decide({ now, core: { ...value, armed: armedHere }, options, isTurnRunning, nextPingAt, nextCompactAt })

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

    await runCompact($, now - value.lastAt, now)
  } finally {
    isBusy = false
  }
}

// Puts the text back in the box where the surface has one; otherwise the notice carries it.
async function keepText($: EngineInterface, text: string, why: string) {
  const isRestored = await $.prompt.fill({ text }).then(
    filled => filled.isFilled,
    () => false,
  )

  return {
    drop: isRestored ? `cache-keeper: ${why}, your text is back in the box.` : `cache-keeper: ${why}. Your text: ${text.slice(0, 3500)}`,
  }
}

export const register: Register = (on, rawOptions) => {
  const options = parseOptions(rawOptions as Readonly<Record<string, unknown>>)

  on('session.start', async ($, e, next) => {
    viaCommand = !e.isInteractive
    options.builtin = await readBuiltin($)
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

    // Read again: the store holds anything a hook raised before this one wrote.
    loadedFor = ''
    await ensureLoaded($)
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

      await patch($, c => {
        if (seconds === undefined) return { ...c, tokens: c.tokens === 0 && tokens ? tokens : c.tokens }

        const lastResponse = now - seconds * 1000
        // The last response was made by the model that last replied, which `e.model`, the model the
        // session resumes on, need not be.
        const replied = c.replyModel || e.model || ''
        const key = replied ? familyKey(replied) : ''

        return {
          ...c,
          lastAt: Math.max(c.lastAt, lastResponse),
          tokens: c.tokens === 0 && tokens ? tokens : c.tokens,
          model: c.model || e.model || '',
          byModel: key ? { ...c.byModel, [key]: Math.max(c.byModel?.[key] ?? 0, lastResponse) } : c.byModel,
        }
      })
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

      await patch($, c => ({ ...c, lastAt: now, replyModel: e.model, byModel: { ...c.byModel, [familyKey(e.model)]: now } }))
    }

    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      isTurnRunning = false
      armedHere = true

      const now = await $.clock.now()
      const model = e.usage?.model

      await patch($, c => ({
        ...c,
        // Only a turn no step stamped, and one that really made a request.
        lastAt: e.usage && now - c.lastAt > e.durationMs ? now : c.lastAt,
        armed: true,
        model: model || c.model,
        replyModel: model || c.replyModel,
        byModel: model
          ? { ...c.byModel, [familyKey(model)]: Math.max(c.byModel?.[familyKey(model)] ?? 0, e.usage && now - c.lastAt > e.durationMs ? now : c.lastAt) }
          : c.byModel,
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

    const selected = resolveModel(await $.session.model(), value)

    if (!needsWarning(value, selected, now, options)) return next(e)

    const label = shortName(selected)
    const price = nextCost(value, selected, now, options)
    const cost = price ? usd(price.usd) : null
    const coldFor = coldState(value, selected, now, options)

    if (options.guard === 'warn') {
      $.ui.log(`cache-keeper: the ${label} cache ${coldFor}; this message re-writes ${tok(value.tokens)} tokens${cost ? `, about ${cost}` : ''}.`)
      return next(e)
    }

    // A message with attachments stays on its model: they do not survive a re-send.
    const switches = e.attachments?.length
      ? []
      : switchTargets(selected).map(model => {
          const quote = nextCost(value, model, now, options)

          return { model, text: `Switch to ${shortName(model)}${quote ? ` (${usd(quote.usd)})` : ''}` }
        })
    const send = `Send on ${label}${cost ? ` (${cost})` : ''}`
    let answer: string

    try {
      answer = await $.ui.ask(
        `The ${label} prompt cache ${coldFor}. This message re-writes ${tok(value.tokens)} tokens. Send it on ${label}, or switch model first?`,
        { header: 'Cold cache', options: [send, ...switches.map(option => option.text), "Don't send"] },
      )
    } catch {
      // A dialog that could not be shown must never eat a prompt.
      $.ui.log(`cache-keeper: the ${label} cache ${coldFor}; this message re-writes ${tok(value.tokens)} tokens.`)
      return next(e)
    }

    if (answer === send) return next(e)

    const picked = switches.find(option => option.text === answer)

    if (picked) {
      const target = shortName(picked.model)

      try {
        await $.command.run({ command: 'model', args: picked.model })
      } catch (error) {
        $.ui.log(`cache-keeper: could not switch to ${target}: ${String(error)}`)
        return keepText($, e.text, `the switch to ${target} failed, so nothing was sent`)
      }

      // Re-sent on the new model. Not awaited: the call resolves only when its turn starts, which waits for this prompt to end.
      void $.prompt.submit({ text: e.text }).catch(error => $.ui.log(`cache-keeper: re-send failed: ${String(error)}`))

      return { drop: `cache-keeper: sent on ${target} instead.` }
    }

    return keepText($, e.text, 'not sent')
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
    const selected = resolveModel(await $.session.model(), value)
    const cache = cacheText(value, now, options, selected) ?? 'Cache: no request yet.'
    const table = estimates(value, now, options)
      .map(est => `${est.label} ${usd(est.usd)} (${est.warm ? 'read' : 'write'})`)
      .join(', ')
    const autoCompact = options.autoCompact && !value.noCompact
      ? `cache-keeper, after ${span(options.compactAt)} idle`
      : options.builtin
        ? `Claude Code's idle compaction, at ${span(options.builtin.fireAt * HOUR)} idle on ${tok(options.builtin.minTokens)}+ tokens`
        : 'off'

    return {
      text: [
        cache,
        `Next message by model: ${table}.`,
        ...(rows.length ? [`usage left: ${rows.join(', ')}`] : []),
        `idle compaction: ${autoCompact}; floor ${tok(options.minTokens)}; guard: ${options.guard}; cache TTL: ${span(options.ttlMs)}`,
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
    const selected = resolveModel(await $.session.model(), value)
    const cache = cacheParts({ ...value, armed: armedHere }, now, options, selected)

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
          {cache ? (
            <Box flexDirection="row" flexWrap="wrap">
              <Text color={MODE_HUE[cache.mode]}>{cache.lead}</Text>
              {cache.plan && cache.planState ? (
                <Text color={PLAN_HUE[cache.planState]}>
                  {' '}
                  {PLAN_GLYPH[cache.planState]} {cache.plan}
                </Text>
              ) : null}
            </Box>
          ) : null}
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
