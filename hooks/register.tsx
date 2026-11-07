import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Core, RateRow } from '../types'
import { BG, MODE_HUE, MUTED, PLAN_GLYPH, PLAN_HUE, TONE, mascotSvg, statusSvg, usageSvg } from './art'
import type { ColdCase, ColdChoice, Effort, Options, PlanState } from './logic'
import {
  DEFAULT_KEEP_MS,
  EMPTY,
  aheadOfBuiltin,
  HOUR,
  MINUTE,
  cacheParts,
  cacheText,
  coldCase,
  coldChoices,
  compactModels,
  decide,
  coldState,
  estimates,
  familyKey,
  builtinIdle,
  isHeadlessRefusal,
  isEffort,
  isWarmOn,
  lowerModels,
  needsWarning,
  nextCost,
  picksCompactModel,
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
  wantsAwake,
} from './logic'

const core = atom({ plugin: 'cache-seer', key: 'core' } as const, EMPTY)
const rate = atom({ plugin: 'cache-seer', key: 'rate' } as const, [] as RateRow[])

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
// The effort the last main-thread request went out at, so a compaction on another effort can put it back.
let lastEffort: string | undefined

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

/** Claude Code's settings folder, and its .claude.json, which CLAUDE_CONFIG_DIR moves into that folder. */
async function claudePaths($: EngineInterface): Promise<{ dir?: string; configFile?: string }> {
  const configDir = await $.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined)
  const home = (await $.env.get('HOME').catch(() => undefined)) ?? (await $.env.get('USERPROFILE').catch(() => undefined))

  if (configDir) return { dir: configDir, configFile: `${configDir}/.claude.json` }

  return home ? { dir: `${home}/.claude`, configFile: `${home}/.claude.json` } : {}
}

/** The mod's name before the rename; its saved state and options carry over once. */
const OLD_NAME = 'cache-keeper'
const MIGRATED_KEY = 'migrated'

function pluginEntry(table: unknown, name: string): unknown {
  if (!table || typeof table !== 'object') return undefined

  const key = Object.keys(table).find(id => id.startsWith(`${name}@`))

  return key ? (table as Record<string, unknown>)[key] : undefined
}

/**
 * Carries a cache-keeper install over to cache-seer: its store once (session cache times, saved usage,
 * keep awake and motion), and its options while cache-seer has none of its own. Warns while it is still on.
 */
async function adoptOld($: EngineInterface, options: Options): Promise<void> {
  const { dir } = await claudePaths($)

  if (!dir) return

  const settings = (await readJson($, `${dir}/settings.json`)) as Record<string, unknown> | null
  const oldConfig = pluginEntry(settings?.pluginConfigs, OLD_NAME) as { options?: Record<string, unknown> } | undefined

  if (oldConfig?.options && pluginEntry(settings?.pluginConfigs, 'cache-seer') === undefined) {
    const { builtin, ...adopted } = parseOptions(oldConfig.options)

    Object.assign(options, adopted)
    baseKeepAwake = options.keepAwake
  }

  if (pluginEntry(settings?.enabledPlugins, OLD_NAME) === true) {
    $.ui.log(`cache-seer: ${OLD_NAME}, its old name, is still on, so the band and guard run twice. Run /plugin uninstall ${OLD_NAME}.`)
  }

  if (await $.store.get(MIGRATED_KEY).catch(() => true)) return

  // Marked first, so a failed copy is never retried at every start.
  await $.store.set(MIGRATED_KEY, true)

  const stores = await $.fs.list(`${dir}/plugins/store`).catch(() => [])
  const old = stores.find(entry => entry.kind === 'file' && entry.name.startsWith(`${OLD_NAME}_${OLD_NAME}-`) && entry.name.endsWith('.json'))
  const saved = old ? await readJson($, `${dir}/plugins/store/${old.name}`) : null

  if (!saved || typeof saved !== 'object') return

  for (const [key, value] of Object.entries(saved)) {
    if ((await $.store.get(key)) === undefined) await $.store.set(key, value)
  }
}

// Only what decides Claude Code's own idle compaction is read from its config and settings; nothing is kept.
async function readBuiltin($: EngineInterface) {
  const { dir, configFile } = await claudePaths($)
  const config = configFile ? await readJson($, configFile) : null
  const settings = dir ? await readJson($, `${dir}/settings.json`) : null

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
          $.ui.log(`cache-seer: auto compact skipped after ${span(idleMs)} idle: ${result.skip}. Trying again in 2m.`)
          return
        }

        const after = result.tokensAfter ?? 0

        await patch($, c => ({ ...c, compacted: true, compactTried: true, tokens: after > 0 ? after : c.tokens }))
        $.ui.log(`cache-seer: compacted ${tok(before)} to ${tok(after)} after ${span(idleMs)} idle, before the cache went cold.`)
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
    $.ui.log(`cache-seer: compacted with /compact after ${span(idleMs)} idle, before the cache went cold.`)
  } catch (error) {
    nextCompactAt = now + COMPACT_RETRY_MS
    $.ui.log(`cache-seer: auto compact failed after ${span(idleMs)} idle: ${String(error)}. Trying again in 2m.`)
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
      $.ui.log(`cache-seer: keepwarm stopped: the ping read ${tok(readTokens)} and wrote ${tok(written)}, so the cache was already gone.`)
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
  $.ui.log(`cache-seer: keepwarm stopped: ${reply.reason}.`)
}

/** Keep awake and motion as `/cache-seer` set them, kept across sessions; unset follows the plugin option. */
type Prefs = { keepAwake?: boolean; animate?: boolean }

const PREFS_KEY = 'prefs'
// The plugin option as set, before a command overrides it.
let baseKeepAwake = false
// The drawings animate unless `/cache-seer motion off` said otherwise.
let animate = true

/** Reads what any session saved, so every session follows the last command. */
async function loadPrefs($: EngineInterface, options: Options): Promise<void> {
  const saved = ((await $.store.get(PREFS_KEY).catch(() => undefined)) ?? {}) as Prefs

  options.keepAwake = saved.keepAwake ?? baseKeepAwake
  animate = saved.animate ?? true
}

async function setPref($: EngineInterface, options: Options, change: Prefs): Promise<void> {
  const saved = ((await $.store.get(PREFS_KEY).catch(() => undefined)) ?? {}) as Prefs

  await $.store.set(PREFS_KEY, { ...saved, ...change })
  await loadPrefs($, options)
  await reconcileAwake($, options)
  $.ui.invalidate('ui.render')
}

// The helper process that holds the machine awake, while one runs.
let awake: { stop: () => void } | null = null

// Holds a system-required request for as long as it runs; killing it lets the machine sleep again.
const WINDOWS_HOLD =
  "$k = Add-Type -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);' -Name P -Namespace CacheKeeper -PassThru; " +
  '[void]$k::SetThreadExecutionState([uint32]2147483649); while ($true) { Start-Sleep -Seconds 60 }'

async function holdCommands($: EngineInterface): Promise<string[][]> {
  const os = await $.env.get('OS').catch(() => undefined)

  if (os === 'Windows_NT') {
    return [
      ['pwsh', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_HOLD],
      ['powershell', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_HOLD],
    ]
  }

  return [['caffeinate', '-i'], ['systemd-inhibit', '--what=idle:sleep', '--who=cache-seer', '--why=idle compaction', 'sleep', 'infinity']]
}

/** Starts the first helper that runs on this system; one that cannot start or ends by itself gives way to the next. */
function holdAwake($: EngineInterface): { stop: () => void } {
  let stopped = false
  let child: { return?: (value?: never) => unknown } | null = null

  void (async () => {
    for (const argv of await holdCommands($)) {
      if (stopped) return

      try {
        const stream = $.process.spawn({ argv })

        child = stream as unknown as typeof child
        for await (const _ of stream) if (stopped) break
      } catch {
        // Not on this system: try the next.
      }

      if (stopped) return
    }

    awake = null
    $.ui.log('cache-seer: keep awake found no helper to run on this system (pwsh, powershell, caffeinate or systemd-inhibit).')
  })()

  return {
    stop: () => {
      stopped = true
      void Promise.resolve(child?.return?.()).catch(() => undefined)
    },
  }
}

/** Holds or lets go to match `wantsAwake`. */
async function reconcileAwake($: EngineInterface, options: Options): Promise<void> {
  const now = await $.clock.now()
  const want = wantsAwake({ ...(await read($, core)), armed: armedHere }, now, options)

  if (want && !awake) {
    awake = holdAwake($)
  } else if (!want && awake) {
    awake.stop()
    awake = null
  }
}

async function tick($: EngineInterface, options: Options): Promise<void> {
  $.ui.invalidate('ui.render')

  if (isBusy) return

  isBusy = true

  try {
    await loadSavedRate($)
    await loadPrefs($, options)
    await reconcileAwake($, options)

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
/** Puts the text back in the box; the card says why, and where the text went. */
async function restore($: EngineInterface, text: string, why: string) {
  const isRestored = await $.prompt.fill({ text }).then(
    filled => filled.isFilled,
    () => false,
  )

  return { drop: isRestored ? `${why} Your message is back in the box.` : `${why} Your message: ${text.slice(0, 3500)}` }
}

/** What the question came to: send as is, or first switch or summarize on a model, then send. */
type Plan =
  | { road: 'send' }
  | { road: 'switch'; model: string; effort: Effort }
  | { road: 'compact'; model: string; effort?: Effort; back: string }

/** What the question is about: the model the message goes on, and its cache's state. */
type Held = { kind: ColdCase; selected: string; coldFor: string }

/** The option labels: short, with the cost kept to the question and the model list. */
function choiceLabel(choice: ColdChoice, held: Held): string {
  if (choice === 'send') return `Send on ${shortName(held.selected)}`
  if (choice === 'switch') return 'Use a cheaper model'
  if (choice === 'cancel') return 'Cancel'

  const [only] = compactModels(held.kind, held.selected)

  return picksCompactModel(held.kind) || !only ? 'Summarize first' : `Summarize on ${shortName(only)} first`
}

/** Sets the effort with `/effort`; a failure is logged and the send goes on at the effort in force. */
async function setEffort($: EngineInterface, effort: string): Promise<void> {
  try {
    await $.command.run({ command: 'effort', args: effort })
  } catch (error) {
    $.ui.log(`cache-seer: could not set effort ${effort}: ${String(error)}`)
  }
}

/** One compaction now: the direct call, or a /compact turn where the engine refuses it. */
async function compactNow($: EngineInterface): Promise<{ skip?: string; tokensAfter?: number }> {
  if (!viaCommand) {
    try {
      return await $.session.compact()
    } catch (error) {
      if (!isHeadlessRefusal(error)) throw error
      viaCommand = true
    }
  }

  await $.command.run({ command: 'compact', args: '' })
  return {}
}

/**
 * Carries out a plan, then sends the message as typed. The text is read back from the box, where
 * the guard put it, so an edit made meanwhile is what goes; nothing is sent on a failure.
 */
async function perform($: EngineInterface, plan: Plan, held: string): Promise<void> {
  const fail = async (why: string) => {
    const restored = await $.prompt.fill({ text: held }).then(
      filled => filled.isFilled,
      () => false,
    )
    $.ui.log(`cache-seer: ${why}, so nothing was sent.${restored ? ' Your text is in the box.' : ` Your text: ${held.slice(0, 3500)}`}`)
  }

  if (plan.road === 'switch') {
    try {
      await $.command.run({ command: 'model', args: plan.model })
    } catch (error) {
      return fail(`the switch to ${shortName(plan.model)} failed: ${String(error)}`)
    }

    await setEffort($, plan.effort)
  }

  if (plan.road === 'compact') {
    const moves = familyKey(plan.model) !== familyKey(plan.back)
    const effortBefore = lastEffort
    const before = (await read($, core)).tokens

    isCompacting = true

    try {
      if (moves) await $.command.run({ command: 'model', args: plan.model })
      if (plan.effort) await setEffort($, plan.effort)

      const result = await compactNow($)

      if (result.skip !== undefined) return fail(`the compaction was skipped: ${result.skip}`)

      const after = result.tokensAfter ?? 0

      await patch($, c => ({ ...c, compacted: true, compactTried: true, tokens: after > 0 ? after : c.tokens }))
      $.ui.log(`cache-seer: compacted ${tok(before)}${after > 0 ? ` to ${tok(after)}` : ''} on ${shortName(plan.model)} before sending.`)
    } catch (error) {
      return fail(`the compaction on ${shortName(plan.model)} failed: ${String(error)}`)
    } finally {
      isCompacting = false
      // The message goes out on the model and effort it was typed for.
      if (moves) await $.command.run({ command: 'model', args: plan.back }).catch(error => $.ui.log(`cache-seer: could not switch back to ${shortName(plan.back)}: ${String(error)}`))
      if (plan.effort && effortBefore && effortBefore !== plan.effort) await setEffort($, effortBefore)
    }
  }

  const typed = await $.prompt.read().then(
    box => box.text,
    () => '',
  )
  const text = typed.trim() !== '' ? typed : held

  if (typed !== '') await $.prompt.fill({ text: '' }).catch(() => undefined)

  // Not awaited: the call resolves only when its turn starts.
  void $.prompt.submit({ text }).catch(error => $.ui.log(`cache-seer: re-send failed: ${String(error)}`))
}

/**
 * The one question a cold send asks, in the engine's own question box, which reaches every surface
 * (Remote Control and SDK hosts too). A road that needs a model asks which; a switch or a summary
 * that needs one asks its effort too. Null for a cancel; throws when the box cannot be shown.
 */
async function askCold($: EngineInterface, held: Held, value: Core, now: number, options: Options): Promise<Plan | null> {
  const choices = coldChoices(held.kind, held.selected)
  const labels = choices.map(choice => choiceLabel(choice, held))
  const cost = nextCost(value, held.selected, now, options)
  const answer = await $.ui.ask(`${shortName(held.selected)} ${held.coldFor}. Sending rebuilds this conversation${cost ? `, about ${usd(cost.usd)}` : ''}.`, {
    header: 'Cold cache',
    options: labels,
  })
  const choice = choices[labels.indexOf(answer)]

  if (!choice || choice === 'cancel') return null
  if (choice === 'send') return { road: 'send' }

  if (choice === 'compact' && !picksCompactModel(held.kind)) {
    const [model] = compactModels(held.kind, held.selected)

    return { road: 'compact', model: model ?? held.selected, back: held.selected }
  }

  const models = choice === 'switch' ? lowerModels(held.selected) : compactModels(held.kind, held.selected)
  const modelLabels = models.map(model => {
    const modelCost = nextCost(value, model, now, options)

    return `${shortName(model)}${modelCost ? ` (${usd(modelCost.usd)})` : ''}`
  })
  const pickedModel = models[modelLabels.indexOf(await $.ui.ask(choice === 'switch' ? 'Send on which model?' : 'Summarize on which model?', { header: 'Model', options: modelLabels }))]

  if (!pickedModel) return null

  // The box takes four options; max is typed under Other.
  const effort = (await $.ui.ask('At which effort? Type max under Other for max.', { header: 'Effort', options: ['low', 'medium', 'high', 'xhigh'] })).trim().toLowerCase()

  if (!isEffort(effort)) return null

  return choice === 'switch'
    ? { road: 'switch', model: pickedModel, effort }
    : { road: 'compact', model: pickedModel, effort, back: held.selected }
}

export const register: Register = (on, rawOptions) => {
  const options = parseOptions(rawOptions as Readonly<Record<string, unknown>>)

  baseKeepAwake = options.keepAwake

  on('session.start', async ($, e, next) => {
    viaCommand = !e.isInteractive
    await adoptOld($, options)
    options.builtin = await readBuiltin($)
    options.compactAt = aheadOfBuiltin(options)
    await loadPrefs($, options)
    await $.command.register({
      name: 'cache-seer',
      description: 'Shows the prompt cache state; "compact", "awake" or "motion" with on or off sets idle compaction for this session, keep awake, or the band animation.',
      argumentHint: '[compact|awake|motion on|off]',
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
    awake?.stop()
    awake = null

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

      if (typeof e.effort === 'string') lastEffort = e.effort
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
      // Claude Code lets go of its own hold shortly after a turn; this one takes over at once.
      await reconcileAwake($, options)
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
    const notice = `cache-seer: the ${label} cache ${coldFor}; this message re-writes ${tok(value.tokens)} tokens${cost ? `, about ${cost}` : ''}.`

    if (options.guard === 'warn') {
      $.ui.log(notice)
      return next(e)
    }

    const held: Held = { kind: coldCase(value.replyModel || value.model || selected, selected), selected, coldFor }
    let plan: Plan | null

    try {
      // A message with attachments is sent or kept: they do not survive a re-send.
      plan = e.attachments?.length
        ? (await $.ui.ask(`${label} ${coldFor}. Sending rebuilds this conversation${cost ? `, about ${cost}` : ''}.`, {
            header: 'Cold cache',
            options: [`Send on ${label}`, 'Cancel'],
          })) === 'Cancel'
          ? null
          : { road: 'send' }
        : await askCold($, held, value, now, options)
    } catch {
      // A question that could not be shown must never eat a prompt.
      $.ui.log(notice)
      return next(e)
    }

    if (!plan) return restore($, e.text, 'Not sent.')
    if (plan.road === 'send') return next(e)

    // Run from a timer, once this prompt has ended: the engine refuses a command run from this hook,
    // as it would wait on the turn the hook holds.
    const queued = plan

    $.clock.after(0, () => {
      void perform($, queued, e.text).catch(error => $.ui.log(`cache-seer: ${String(error)}`))
    })

    return {
      drop:
        plan.road === 'switch'
          ? `Switching to ${shortName(plan.model)}, then sending your message.`
          : `Summarizing with ${shortName(plan.model)}, then sending your message${plan.back && familyKey(plan.back) !== familyKey(plan.model) ? ` on ${shortName(plan.back)}` : ''}.`,
    }
  })

  on('command.run', { command: 'cache-seer' }, async ($, e) => {
    const arg = e.args.trim()

    if (arg === 'compact on' || arg === 'compact off') {
      await patch($, c => ({ ...c, noCompact: arg === 'compact off' }))
      return { text: `cache-seer's idle compaction is ${arg === 'compact off' ? 'off' : 'on'} for this session.` }
    }

    // Kept for every session, as the band shows them.
    if (arg === 'awake on' || arg === 'awake off') {
      await setPref($, options, { keepAwake: arg === 'awake on' })
      return { text: arg === 'awake on' ? 'Keep awake is on: idle sleep is held off while an idle compaction waits on a warm cache.' : 'Keep awake is off.' }
    }

    if (arg === 'motion on' || arg === 'motion off') {
      await setPref($, options, { animate: arg === 'motion on' })
      return { text: `The band's animation is ${arg === 'motion on' ? 'on' : 'off'}.` }
    }

    if (arg !== '') return { text: 'Usage: /cache-seer [compact|awake|motion on|off]' }

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
      ? `cache-seer, after ${span(options.compactAt)} idle`
      : options.builtin
        ? `Claude Code's idle compaction, at ${span(options.builtin.fireAt * HOUR)} idle on ${tok(options.builtin.minTokens)}+ tokens`
        : 'off'

    return {
      text: [
        cache,
        `Next message by model: ${table}.`,
        ...(rows.length ? [`usage left: ${rows.join(', ')}`] : []),
        `idle compaction: ${autoCompact}; floor ${tok(options.minTokens)}; guard: ${options.guard}; keep awake: ${options.keepAwake ? (awake ? 'holding' : 'on') : 'off'}; motion: ${animate ? 'on' : 'off'}; cache TTL: ${span(options.ttlMs)}`,
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
    const awakeText = `keep awake ${options.keepAwake ? 'on' : 'off'}`

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
              <Text color={PLAN_HUE[options.keepAwake ? 'on' : 'off']}> · {PLAN_GLYPH[options.keepAwake ? 'on' : 'off']} {awakeText}</Text>
            </Box>
          ) : null}
        </Box>
      )
    }

    // Each drawing's source changes only when its words do, so nothing restarts on a redraw.
    const still = !animate
    const usage = parts.length > 0 ? usageSvg(parts, columns >= 70 ? 10 : 5, still) : null
    const figure = cache ? mascotSvg(cache.mode, still) : null
    const status = cache ? statusSvg(cache, still, { text: awakeText, isOn: options.keepAwake }) : null
    const usageAlt = parts.map(part => `${part.name} ${part.left}% left`).join(', ')

    const band = (
      <Box key="band" flexDirection="row" flexWrap="wrap" alignItems="center" backgroundColor={BG} borderStyle="round" borderColor={BG} paddingX={1}>
        {usage ? (
          <Box key="usage" flexShrink={0} marginRight={2}>
            <Svg source={usage.source} alt={usageAlt} width={usage.width} height={usage.height} />
          </Box>
        ) : null}
        {figure && status && cache ? (
          <Box key="cache" flexDirection="row" flexWrap="wrap" alignItems="center">
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

    return band
  })
}
