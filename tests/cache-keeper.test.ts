import { expect, mock, test } from 'claude-code/testing'

import { MODE_HUE, mascotSvg, statusSvg, usageSvg } from '../hooks/art'
import { EMPTY, HOUR, MINUTE, cacheParts, planStateOf, compactAtMs, decide, estimates, builtinIdle, isHeadlessRefusal, needsWarning, nextCost, resolveModel, switchTargets, parseDuration, parseOptions, priceOf, rateParts, toneOf } from '../hooks/logic'

const options = parseOptions({ autoCompact: 'on' })
const warm = { ...EMPTY, lastAt: 1000, tokens: 180_000, model: 'claude-opus-5-5', byModel: { 'opus-5-5': 1000 }, armed: true }
const at = (ms: number) => warm.lastAt + ms
const idle = (now: number, core = warm, over = {}) =>
  decide({ now, core, options, isTurnRunning: false, nextPingAt: 0, ...over })

test('compacts in the window before cold, and not outside it', () => {
  expect(compactAtMs(HOUR)).toBe(55 * MINUTE)
  expect(compactAtMs(5 * MINUTE)).toBe(4 * MINUTE)
  expect(idle(at(54 * MINUTE))).toBe('none')
  expect(idle(at(55 * MINUTE))).toBe('compact')
  expect(idle(at(HOUR))).toBe('none')
})

test('does not recompact', () => {
  expect(idle(at(56 * MINUTE), { ...warm, compacted: true })).toBe('none')
  expect(idle(at(56 * MINUTE), { ...warm, compactTried: true })).toBe('none')
})

test('holds off for a running turn, a small context and the session switch', () => {
  expect(idle(at(56 * MINUTE), warm, { isTurnRunning: true })).toBe('none')
  expect(idle(at(56 * MINUTE), { ...warm, tokens: 49_000 })).toBe('none')
  expect(idle(at(56 * MINUTE), { ...warm, noCompact: true })).toBe('none')
  expect(idle(at(56 * MINUTE), { ...warm, lastAt: 0 })).toBe('none')
})

test('keepwarm pings instead of compacting, then hands over', () => {
  const armed = { ...warm, keepUntil: at(2 * HOUR) }

  expect(idle(at(48 * MINUTE), armed)).toBe('none')
  expect(idle(at(50 * MINUTE), armed)).toBe('ping')
  expect(idle(at(56 * MINUTE), armed)).toBe('ping')
  expect(idle(at(56 * MINUTE), armed, { nextPingAt: at(57 * MINUTE) })).toBe('none')
  expect(idle(at(56 * MINUTE), { ...warm, keepUntil: at(MINUTE) })).toBe('compact')
})

test('parses durations', () => {
  expect(parseDuration('90m')).toBe(90 * MINUTE)
  expect(parseDuration('1h30m')).toBe(90 * MINUTE)
  expect(parseDuration('999h')).toBe(168 * HOUR)
  expect(parseDuration('')).toBe(null)
  expect(parseDuration('0m')).toBe(null)
  expect(parseDuration('soon')).toBe(null)
})

test('prices the specific model before its family', () => {
  expect(priceOf('claude-opus-5-5', 1000)).toMatchObject({ read: 0.2, write: 8 })
  expect(priceOf('claude-opus-5', 1000)).toMatchObject({ read: 0.5, write: 10 })
  expect(priceOf('claude-fable-5-1', 1000)).toMatchObject({ read: 0.25, write: 20 })
  expect(priceOf('claude-haiku-5-5', 200_000)).toMatchObject({ read: 0.05, write: 1 })
  expect(priceOf('gpt-x', 1000)).toBe(null)
})

test('the cache parts say warm, cold and compacted, priced on the selected model', () => {
  const opus = 'claude-opus-5-5'

  expect(cacheParts(warm, at(10 * MINUTE), options, opus)).toMatchObject({
    mode: 'warm',
    time: '50m left',
    cost: 'Opus $0.04',
    plan: 'auto compact in 45m',
  })
  expect(cacheParts(warm, at(2 * HOUR), options, opus)).toMatchObject({ mode: 'cold', time: '2h 0m', cost: 'Opus $1.44', plan: 'auto compact on' })
  expect(cacheParts({ ...warm, compacted: true, tokens: 12_000 }, at(0), options, opus)).toMatchObject({
    mode: 'compacted',
    time: '12k',
  })
})

test('a cold cache is priced on the model that sends the next message', () => {
  // 180k is over Haiku 5.5's 100K tier, so its write is $1 per MTok.
  expect(cacheParts(warm, at(2 * HOUR), options, 'claude-haiku-5-5')).toMatchObject({ mode: 'cold', cost: 'Haiku $0.18' })
})

test('a switch to a model with no warm cache is priced as its own write', () => {
  expect(nextCost(warm, 'claude-haiku-5-5', at(MINUTE), options)).toMatchObject({ label: 'Haiku', warm: false })
  expect(Math.round((nextCost(warm, 'claude-haiku-5-5', at(MINUTE), options)?.usd) * 1e6)).toBe(180000)
  expect(nextCost(warm, 'claude-opus-5-5', at(MINUTE), options)).toMatchObject({ label: 'Opus', warm: true })
})

test('a 5-minute compact setting compacts five minutes after the last request', () => {
  const five = parseOptions({ autoCompact: 'on', compactAfter: '5m' })

  expect(idle(at(4 * MINUTE), warm, { options: five })).toBe('none')
  expect(idle(at(5 * MINUTE), warm, { options: five })).toBe('compact')
})

test('auto compact waits for a turn in this process', () => {
  expect(idle(at(56 * MINUTE), { ...warm, armed: false })).toBe('none')
})

test('a headless refusal is recognised, and other errors are not', () => {
  expect(isHeadlessRefusal(new Error('HooksError: $.session.compact: not available in a headless (-p / SDK) session yet'))).toBe(true)
  expect(isHeadlessRefusal(new Error('HooksError: compaction timed out'))).toBe(false)
})

test("Claude Code's idle compaction is read from its rollout flag, and turned off by settings", () => {
  const flag = (extra = {}) => ({ cachedGrowthBookFeatures: { tengu_sunny_locket: { mode: 'compact_on_return', ...extra } } })

  expect(builtinIdle(flag(), {})).toEqual({ minTokens: 200_000, fireAt: 0.9 })
  expect(builtinIdle(flag({ minTokens: 50_000, fireAtFraction: 0.99 }), {})).toEqual({ minTokens: 100_000, fireAt: 0.95 })
  expect(builtinIdle(flag(), {}, '150000')?.minTokens).toBe(150_000)
  expect(builtinIdle(flag(), { idleCompaction: false })).toBe(null)
  expect(builtinIdle({ ...flag(), autoCompactEnabled: false }, {})).toBe(null)
  expect(builtinIdle({ cachedGrowthBookFeatures: { tengu_sunny_locket: { mode: 'log' } } }, {})).toBe(null)
  expect(builtinIdle(null, null)).toBe(null)
})

test('a model with no reply recorded here is shown as not recorded', () => {
  const fresh = { ...warm, byModel: {} }

  expect(cacheParts(fresh, at(MINUTE), options, 'claude-haiku-5-5')).toMatchObject({ mode: 'cold', time: 'not recorded' })
})

test('the warning is for Opus and Sonnet with a cold cache, never Haiku', () => {
  const cold = at(2 * HOUR)
  const big = { ...warm, tokens: 400_000 }

  expect(needsWarning(big, 'claude-opus-5-5', cold, options)).toBe(true)
  expect(needsWarning(big, 'claude-sonnet-5-5', cold, options)).toBe(true)
  expect(needsWarning(big, 'claude-haiku-5-5', cold, options)).toBe(false)
  expect(needsWarning(big, 'claude-opus-5-5', at(MINUTE), options)).toBe(false)
  expect(needsWarning({ ...big, tokens: 1000 }, 'claude-opus-5-5', cold, options)).toBe(false)
})

test('the switch options are the other models', () => {
  expect(switchTargets('claude-opus-5-5')).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5'])
  expect(switchTargets('claude-sonnet-5-5')).toEqual(['claude-haiku-5-5'])
})

test('a model name the price table does not list means the model of the last reply', () => {
  const haiku = { ...warm, model: 'claude-haiku-5-5', byModel: { 'haiku-5-5': 1000 } }

  expect(resolveModel('default', haiku)).toBe('claude-haiku-5-5')
  expect(resolveModel('haiku', haiku)).toBe('haiku')
  expect(cacheParts(haiku, at(MINUTE), options, resolveModel('default', haiku))).toMatchObject({ mode: 'warm' })
})

test('the 5-minute TTL writes at 1.25 times input', () => {
  const five = parseOptions({ cacheTtl: '5m' })

  // Opus 5.5 input is $4 per MTok, so a 5m write is $5: 180k tokens cost $0.90.
  expect(Math.round((nextCost(warm, 'claude-opus-5-5', at(10 * MINUTE), five)?.usd) * 1e6)).toBe(900000)
})

test('estimates price every model the mod lists', () => {
  expect(estimates(warm, at(MINUTE), options).map(est => est.label)).toEqual(['Fable', 'Opus', 'Sonnet', 'Haiku'])
})

test('usage reads blue, amber, orange, then red as it runs out', () => {
  expect([80, 51, 50, 26, 25, 15, 14.9].map(toneOf)).toEqual(['ok', 'ok', 'watch', 'watch', 'high', 'high', 'critical'])
  expect(rateParts([{ kind: 'five_hour', percentUsed: 90 }, { kind: 'seven_day', percentUsed: 55 }], 0)).toMatchObject([
    { name: '7D', left: 45, tone: 'watch', isLow: false },
    { name: '5H', left: 10, tone: 'critical', isLow: true },
  ])
})

test('the drawings carry their words and stay within the Svg limit', () => {
  const parts = rateParts([{ kind: 'seven_day', percentUsed: 55 }], 0)
  const usage = usageSvg(parts, 10)
  const cold = statusSvg({ mode: 'cold', time: '12h 45m', cost: '$4.78', plan: 'idle compact on', planState: 'on', lead: '', summary: '' })

  expect(usage.source).toContain('45%')
  expect(cold.source).toContain('COLD')
  expect(cold.source).toContain(MODE_HUE.cold)

  for (const mode of ['warm', 'cold', 'compacted'] as const) {
    expect(mascotSvg(mode).source.length).toBeLessThan(131_072)
  }

  expect(usage.source.length).toBeLessThan(131_072)
})

const SUMMARY = { role: 'user', text: 'summary', toolUses: [] } as never

const COMPLETE = {
  answer: '',
  durationMs: 10,
  isAborted: false,
  turnId: 't1',
  reason: 'completed',
  usage: {
    model: 'claude-opus-5-5',
    input_tokens: 1,
    output_tokens: 1,
    cache_read_input_tokens: 180_000,
    cache_creation_input_tokens: 0,
  },
}

const standIn = (on: never, compact: () => string | void, rateLimits: unknown[] = [], model = 'claude-opus-5-5') => {
  on('command.register', () => ({ value: { command: 'x' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's1' }))
  on('session.model', () => ({ value: model }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: 180_000, window: 1_000_000 }, rateLimits },
  }))
  on('agent.list', () => ({ value: [] }))
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  on('ui.log', () => ({ value: undefined }))
  on('session.messages', () => ({ value: [SUMMARY] }))
  on('session.compact', () => {
    const skip = compact()
    if (typeof skip === 'string') return { skip }
    return { messages: [SUMMARY], tokensAfter: 12_000 }
  })
}

test('an idle session compacts once and only once', { options: { autoCompact: 'on' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  mock.store(on)
  let compactions = 0

  standIn(on, () => {
    compactions += 1
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' } as never)
  await $.turn.complete(COMPLETE as never)

  await clock.advance(54 * MINUTE)
  expect(compactions).toBe(0)

  await clock.advance(2 * MINUTE)
  expect(compactions).toBe(1)

  await clock.advance(3 * MINUTE)
  expect(compactions).toBe(1)

  // A new turn adds context, so the next idle may compact again.
  await $.turn.start({ text: 'more', turnId: 't2' } as never)
  await $.turn.complete({ ...COMPLETE, turnId: 't2' } as never)
  await clock.advance(56 * MINUTE)
  expect(compactions).toBe(2)
})

const BAND = {
  plugin: 'cache-keeper',
  component: 'AbovePrompt',
  requestId: 'band',
  props: { hasSurvey: false, bodyColumns: 120, view: {} },
} as never

test('the band draws usage and cache state on every surface', { options: { autoCompact: 'on' } }, async ($, on) => {
  mock.clock(on, { now: 1000 })
  mock.store(on)
  standIn(on, () => {}, [{ kind: 'five_hour', percentUsed: 90 }])

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' } as never)
  await $.turn.complete(COMPLETE as never)

  const terminal = await $.ui.mount({ ...(BAND as object), surface: 'terminal' } as never)

  expect((await terminal.find({ type: 'Text', text: /LOW/ }))?.text).toContain('10% left')
  expect((await terminal.find({ type: 'Text', text: /Cache warm/ }))?.text).toContain('1h 0m left')
  expect((await terminal.find({ type: 'Text', text: /compact/ }))?.text).toContain('◷ auto compact in 55m')
  await terminal.unmount()

  // Any tree a surface refuses fails the mount, so this covers each surface's table.
  for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...(BAND as object), surface } as never)

    await ui.unmount()
  }
})

test('after a restart the band shows the last usage until a new reply reports it', async ($, on) => {
  const later = new Date(1000 + 2 * HOUR).toISOString()
  const past = new Date(500).toISOString()

  mock.clock(on, { now: 1000 })
  mock.store(on, {
    rate: [
      { kind: 'five_hour', percentUsed: 90, resetsAt: later },
      { kind: 'seven_day', percentUsed: 40, resetsAt: past },
    ],
  })
  standIn(on, () => {})

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...(BAND as object), surface: 'terminal' } as never)

  expect((await ui.find({ type: 'Text', text: /LOW/ }))?.text).toContain('10% left')
  expect((await ui.find({ type: 'Text', text: /60% left/ }))).toBeUndefined()
  await ui.unmount()
})

test('a running session picks up the reading another session saved', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  let saved: unknown

  on('store.get', (_, e) => ({ value: (e as { key: string }).key === 'rate' ? saved : undefined }) as never)
  on('store.set', () => ({ value: undefined }) as never)
  on('store.keys', () => ({ value: [] }) as never)
  standIn(on as never, () => {})

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  saved = [{ kind: 'five_hour', percentUsed: 90, resetsAt: new Date(1000 + 2 * HOUR).toISOString() }]
  await clock.advance(MINUTE)

  const ui = await $.ui.mount({ ...(BAND as object), surface: 'terminal' } as never)

  expect((await ui.find({ type: 'Text', text: /LOW/ }))?.text).toContain('10% left')
  await ui.unmount()
})

test('a cold send asks, and "Don\'t send" puts the text back', { options: { autoCompact: 'off' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  let filled = ''

  mock.store(on)
  standIn(on, () => {})
  on('tool.call', (_, e) => {
    const question = (e as unknown as { questions: { question: string }[] }).questions[0]?.question ?? ''

    return { result: { questions: [], answers: { [question]: "Don't send" } } } as never
  })
  on('prompt.fill', (_, e) => {
    filled = (e as { text: string }).text
    return { isFilled: true, text: filled, cursor: 0 } as never
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' } as never)
  await $.turn.complete(COMPLETE as never)
  await clock.advance(2 * HOUR)

  const result = await $.prompt.submit({ text: 'back again', origin: { kind: 'composer' }, wait: false } as never)

  expect((result as { drop?: string }).drop).toContain('not sent')
  expect(filled).toBe('back again')
})

test('a restart keeps the Haiku cache warm when the resume hook runs before session start', async ($, on) => {
  const now = 10 * HOUR
  const replied = now - 10 * MINUTE

  mock.clock(on, { now })
  mock.store(on, {
    'session:s1': { ...EMPTY, lastAt: replied, tokens: 180_000, model: 'claude-haiku-5-5', replyModel: 'claude-haiku-5-5', byModel: { 'haiku-5-5': replied, 'opus-5-5': now - 5 * HOUR }, updatedAt: replied },
  })
  standIn(on, () => {}, [], 'claude-haiku-5-5')
  on('classic.SessionStart', () => ({}) as never)

  // The session resumes on its default model, Opus; the last reply was Haiku's.
  await $.classic.SessionStart({ source: 'resume', model: 'claude-opus-5-5', seconds_since_last_response: 600 } as never)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...(BAND as object), surface: 'terminal' } as never)

  expect((await ui.find({ type: 'Text', text: /Cache/ }))?.text).toContain('Cache warm on Haiku, 50m left')
  await ui.unmount()
})

test('a model switched to before sending reads its own cache: cold for Opus here', () => {
  const both = { ...warm, byModel: { 'haiku-5-5': at(0), 'opus-5-5': at(-5 * HOUR) } }

  expect(cacheParts(both, at(10 * MINUTE), options, 'claude-haiku-5-5')).toMatchObject({ mode: 'warm' })
  expect(cacheParts(both, at(10 * MINUTE), options, 'claude-opus-5-5')).toMatchObject({ mode: 'cold' })
})

test('the band names idle compaction, with a timer only when one will fire', () => {
  const opus = 'claude-opus-5-5'
  const off = parseOptions({})
  const builtin = { ...off, builtin: { minTokens: 200_000, fireAt: 0.9 } }
  const big = { ...warm, tokens: 400_000 }
  const plan = (core: typeof warm, opts: typeof options, ms = 10 * MINUTE) => cacheParts(core, at(ms), opts, opus)?.plan

  expect(off.autoCompact).toBe(false)
  expect(plan(big, off)).toBe('idle compact off')
  expect(plan(big, builtin)).toBe('idle compact in 44m')
  expect(plan(warm, builtin)).toBe('idle compact on')
  expect(plan(big, builtin, 2 * HOUR)).toBe('idle compact on')

  expect(plan(warm, options)).toBe('auto compact in 45m')
  expect(plan({ ...warm, armed: false }, options)).toBe('auto compact on')
  expect(plan({ ...warm, tokens: 1000 }, options)).toBe('auto compact on')
  expect(plan({ ...warm, noCompact: true }, off)).toBe('idle compact off')
  expect(plan(warm, parseOptions({ autoCompact: 'on', compactAfter: '30m' }))).toBe('auto compact in 20m')
  expect(plan({ ...warm, keepUntil: at(HOUR) }, options)).toBe('keepwarm 50m')
  expect(parseOptions({ compactAfter: '2h' }).compactAt).toBe(59 * MINUTE)
})

test('each compaction line has its own icon state', () => {
  expect(['idle compact in 44m', 'auto compact in 5m', 'keepwarm 50m', 'idle compact on', 'auto compact on', 'idle compact off'].map(planStateOf)).toEqual([
    'timer',
    'timer',
    'timer',
    'on',
    'on',
    'off',
  ])
  expect(cacheParts(warm, at(10 * MINUTE), options, 'claude-opus-5-5')).toMatchObject({ planState: 'timer', lead: 'Cache warm on Opus, 50m left, 180k, about $0.04.' })

  for (const planState of ['timer', 'on', 'off'] as const) {
    const svg = statusSvg({ mode: 'warm', time: '50m left', cost: 'Opus $0.04', plan: 'x', planState, lead: '', summary: '' }).source

    expect(svg).toContain(`aria-label="${planState}"`)
  }
})

test('a compaction the engine skips is tried again, and says so', { options: { autoCompact: 'on' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  let attempts = 0

  mock.store(on)
  standIn(on, () => {
    attempts += 1
    return attempts === 1 ? 'a turn is running' : undefined
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' } as never)
  await $.turn.complete(COMPLETE as never)

  await clock.advance(56 * MINUTE)
  expect(attempts).toBe(1)

  await clock.advance(3 * MINUTE)
  expect(attempts).toBe(2)
})
