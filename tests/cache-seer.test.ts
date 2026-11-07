import { expect, mock, test } from 'claude-code/testing'

import { MODE_HUE, mascotSvg, statusSvg, usageSvg } from '../hooks/art'
import { EMPTY, aheadOfBuiltin, wantsAwake, HOUR, MINUTE, cacheParts, coldCase, coldChoices, compactModels, planStateOf, compactAtMs, decide, estimates, builtinIdle, isHeadlessRefusal, lowerModels, needsWarning, nextCost, resolveModel, parseDuration, parseOptions, priceOf, rateParts, toneOf } from '../hooks/logic'

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
    plan: 'idle compact in 45m',
  })
  expect(cacheParts(warm, at(2 * HOUR), options, opus)).toMatchObject({ mode: 'cold', time: '2h 0m', cost: 'Opus $1.44', plan: 'idle compact on' })
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

test('the warning is for any model with a cold cache, Haiku too', () => {
  const cold = at(2 * HOUR)
  const big = { ...warm, tokens: 400_000 }

  expect(needsWarning(big, 'claude-opus-5-5', cold, options)).toBe(true)
  expect(needsWarning(big, 'claude-sonnet-5-5', cold, options)).toBe(true)
  expect(needsWarning(big, 'claude-haiku-5-5', cold, options)).toBe(true)
  expect(needsWarning(big, 'claude-opus-5-5', at(MINUTE), options)).toBe(false)
  expect(needsWarning({ ...big, tokens: 1000 }, 'claude-opus-5-5', cold, options)).toBe(false)
})

test('each of the four cold cases offers its own choices', () => {
  const opus = 'claude-opus-5-5'
  const haiku = 'claude-haiku-5-5'

  expect(coldCase(opus, 'claude-fable-5-1')).toBe('large-large')
  expect(coldCase(opus, haiku)).toBe('large-haiku')
  expect(coldCase(haiku, opus)).toBe('haiku-large')
  expect(coldCase(haiku, haiku)).toBe('haiku-haiku')
  expect(coldCase('', opus)).toBe('large-large')

  expect(coldChoices('large-large', opus)).toEqual(['send', 'switch', 'compact', 'cancel'])
  expect(coldChoices('large-haiku', haiku)).toEqual(['send', 'compact', 'cancel'])
  expect(coldChoices('haiku-large', opus)).toEqual(['send', 'compact', 'cancel'])
  expect(coldChoices('haiku-haiku', haiku)).toEqual(['send', 'cancel'])

})

test('a lower model is any family below; compaction picks any model only from large to large', () => {
  expect(lowerModels('claude-fable-5-1')).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'])
  expect(lowerModels('claude-sonnet-5-5')).toEqual(['claude-haiku-5-5'])
  expect(lowerModels('claude-haiku-5-5')).toEqual([])
  expect(compactModels('large-large', 'claude-opus-5-5')).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1'])
  expect(compactModels('large-haiku', 'claude-haiku-5-5')).toEqual(['claude-haiku-5-5'])
  expect(compactModels('haiku-large', 'claude-opus-5-5')).toEqual(['claude-haiku-5-5'])
})

test('a machine asleep past the cache life does not compact on waking', () => {
  // Asleep 32m into the idle, awake 5h 51m after the last reply: the cache is gone, so no compaction.
  expect(idle(at(32 * MINUTE))).toBe('none')
  expect(idle(at(5 * HOUR + 51 * MINUTE))).toBe('none')
  // Awake again inside the window, it still compacts while the cache serves it.
  expect(idle(at(57 * MINUTE))).toBe('compact')
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
    { name: '5H', left: 10, tone: 'critical', isLow: true },
    { name: '7D', left: 45, tone: 'watch', isLow: false },
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

const standIn = (on: never, compact: () => string | void, rateLimits: unknown[] = [], model: string | (() => string) = 'claude-opus-5-5', box: () => string = () => '', log: (text: string) => void = () => {}) => {
  on('command.register', () => ({ value: { command: 'x' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's1' }))
  on('session.model', () => ({ value: typeof model === 'function' ? model() : model }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: 180_000, window: 1_000_000 }, rateLimits },
  }))
  on('agent.list', () => ({ value: [] }))
  on('prompt.read', () => ({ value: { text: box(), cursor: 0 } }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  on('ui.log', (_, e) => {
    log((e as { text: string }).text)
    return { value: undefined }
  })
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
  plugin: 'cache-seer',
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
  expect((await terminal.find({ type: 'Text', text: /compact/ }))?.text).toContain('◷ idle compact in 55m')
  expect((await terminal.find({ type: 'Text', text: /keep awake/ }))?.text).toBe(' · ○ keep awake off')
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

/** A session whose cache on `model` went cold two hours ago, with stand-ins that record what the guard does. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function coldSession($: any, on: any, model = 'claude-opus-5-5', answers: string[] = []) {
  const clock = mock.clock(on, { now: 1000 })
  const seen = { filled: '', runs: [] as string[], sent: [] as string[], compactions: 0, asked: [] as string[], options: [] as string[][], logs: [] as string[], model, clock }

  mock.store(on)
  standIn(
    on,
    () => {
      seen.compactions += 1
    },
    [],
    () => seen.model,
    () => seen.filled,
    text => seen.logs.push(text),
  )
  on('tool.call', (_: unknown, e: { questions: { question: string; options?: unknown[] }[] }) => {
    const first = e.questions[0]
    const question = first?.question ?? ''

    seen.asked.push(question)
    seen.options.push((first?.options ?? []).map(option => (typeof option === 'string' ? option : (option as { label: string }).label)))
    return { result: { questions: [], answers: { [question]: answers.shift() ?? 'Cancel' } } }
  })
  on('prompt.fill', (_: unknown, e: { text: string }) => {
    seen.filled = e.text
    return { isFilled: true, text: e.text, cursor: 0 }
  })
  on('command.run', (_: unknown, e: { command: string; args: string }) => {
    seen.runs.push(`${e.command} ${e.args}`.trim())
    if (e.command === 'model') seen.model = e.args
    return { text: '' }
  })
  on('prompt.submit', (_: unknown, e: { text: string }) => {
    seen.sent.push(e.text)
    return { text: e.text }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete({ ...COMPLETE, usage: { ...COMPLETE.usage, model } })
  await clock.advance(2 * HOUR)

  return seen
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const send = ($: any, text: string, kind = 'composer') => $.prompt.submit({ text, origin: { kind }, wait: false }) as Promise<{ drop?: string; text?: string }>
test('a cold send asks once in the question box, and Cancel puts the text back', { options: { autoCompact: 'off' } }, async ($, on) => {
  const seen = await coldSession($, on, 'claude-opus-5-5', ['Cancel'])
  const result = await send($, 'back again')

  expect(seen.asked).toHaveLength(1)
  expect(seen.asked[0]).toMatch(/^Opus went cold .* Sending rebuilds this conversation, about \$1\.44\.$/)
  expect(seen.options).toEqual([['Send on Opus', 'Use a cheaper model', 'Summarize first', 'Cancel']])
  expect(result.drop).toBe('Not sent. Your message is back in the box.')
  expect(seen.filled).toBe('back again')
  expect(seen.sent).toEqual([])
})

test('a switch to a lower model asks which model and effort, then sends on it', { options: { autoCompact: 'off' } }, async ($, on) => {
  const seen = await coldSession($, on, 'claude-opus-5-5', ['Use a cheaper model', 'Haiku ($0.18)', 'max'])
  const result = await send($, 'go on')

  expect(result.drop).toBe('Switching to Haiku, then sending your message.')
  expect(seen.options.slice(1)).toEqual([['Sonnet ($0.72)', 'Haiku ($0.18)'], ['low', 'medium', 'high', 'xhigh']])
  for (let i = 0; i < 5 && seen.sent.length < 1; i += 1) await seen.clock.advance(1)

  expect(seen.runs).toEqual(['model claude-haiku-5-5', 'effort max'])
  expect(seen.sent).toEqual(['go on'])
})

test('summarizing first asks which model and effort, then sends on the model typed for', { options: { autoCompact: 'off' } }, async ($, on) => {
  const seen = await coldSession($, on, 'claude-opus-5-5', ['Summarize first', 'Haiku ($0.18)', 'low'])
  const result = await send($, 'go on')

  expect(result.drop).toBe('Summarizing with Haiku, then sending your message on Opus.')
  for (let i = 0; i < 5 && seen.sent.length < 1; i += 1) await seen.clock.advance(1)

  expect(seen.compactions).toBe(1)
  expect(seen.runs).toEqual(['model claude-haiku-5-5', 'effort low', 'model claude-opus-5-5'])
  expect(seen.model).toBe('claude-opus-5-5')
  expect(seen.sent).toEqual(['go on'])
})

test('from a large model to Haiku, summarize first runs on Haiku with no more picks', { options: { autoCompact: 'off' } }, async ($, on) => {
  const seen = await coldSession($, on, 'claude-opus-5-5', ['Summarize on Haiku first'])

  seen.model = 'claude-haiku-5-5'
  await send($, 'go on')
  for (let i = 0; i < 5 && seen.sent.length < 1; i += 1) await seen.clock.advance(1)

  expect(seen.options[0]).toEqual(['Send on Haiku', 'Summarize on Haiku first', 'Cancel'])
  expect(seen.compactions).toBe(1)
  // Already on Haiku: no switch either way.
  expect(seen.runs).toEqual([])
  expect(seen.sent).toEqual(['go on'])
})

test('from Haiku to a larger model, summarize first runs on Haiku and sends on the larger one', { options: { autoCompact: 'off' } }, async ($, on) => {
  const seen = await coldSession($, on, 'claude-haiku-5-5', ['Summarize on Haiku first'])

  seen.model = 'claude-opus-5-5'
  await send($, 'go on')
  for (let i = 0; i < 5 && seen.sent.length < 1; i += 1) await seen.clock.advance(1)

  expect(seen.compactions).toBe(1)
  expect(seen.runs).toEqual(['model claude-haiku-5-5', 'model claude-opus-5-5'])
  expect(seen.sent).toEqual(['go on'])
})

test('from Haiku to Haiku the question offers only sending and cancel', { options: { autoCompact: 'off' } }, async ($, on) => {
  const seen = await coldSession($, on, 'claude-haiku-5-5', ['Send on Haiku'])

  await send($, 'go on')
  for (let i = 0; i < 5 && seen.sent.length < 1; i += 1) await seen.clock.advance(1)

  expect(seen.options).toEqual([['Send on Haiku', 'Cancel']])
  expect(seen.sent).toEqual(['go on'])
})

test('a Remote Control send asks in the same question box, in steps', { options: { autoCompact: 'off' } }, async ($, on) => {
  const seen = await coldSession($, on, 'claude-opus-5-5', ['Use a cheaper model', 'Haiku ($0.18)', 'max'])
  const result = await send($, 'from my phone', 'bridge')

  expect(result.drop).toContain('Switching to Haiku')

  for (let i = 0; i < 5 && seen.sent.length < 1; i += 1) await seen.clock.advance(1)

  expect(seen.asked).toHaveLength(3)
  expect({ runs: seen.runs, logs: seen.logs }).toEqual({ runs: ['model claude-haiku-5-5', 'effort max'], logs: [] })
  expect(seen.sent.at(-1)).toBe('from my phone')
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
  const off = parseOptions({ autoCompact: 'off' })
  const builtin = { ...off, builtin: { minTokens: 200_000, fireAt: 0.9 } }
  const big = { ...warm, tokens: 400_000 }
  const plan = (core: typeof warm, opts: typeof options, ms = 10 * MINUTE) => cacheParts(core, at(ms), opts, opus)?.plan

  // On unless turned off.
  expect(parseOptions({}).autoCompact).toBe(true)
  expect(off.autoCompact).toBe(false)
  expect(plan(big, off)).toBe('idle compact off')
  expect(plan(big, builtin)).toBe('idle compact in 44m')
  expect(plan(warm, builtin)).toBe('idle compact on')
  expect(plan(big, builtin, 2 * HOUR)).toBe('idle compact on')

  expect(plan(warm, options)).toBe('idle compact in 45m')
  expect(plan({ ...warm, armed: false }, options)).toBe('idle compact on')
  expect(plan({ ...warm, tokens: 1000 }, options)).toBe('idle compact on')
  expect(plan({ ...warm, noCompact: true }, off)).toBe('idle compact off')
  expect(plan(warm, parseOptions({ autoCompact: 'on', compactAfter: '30m' }))).toBe('idle compact in 20m')
  expect(plan({ ...warm, keepUntil: at(HOUR) }, options)).toBe('keepwarm 50m')
  expect(parseOptions({ compactAfter: '2h' }).compactAt).toBe(59 * MINUTE)
})

test('with Claude Code idle compaction on too, the auto timing goes two minutes ahead of it', () => {
  const builtin = { minTokens: 200_000, fireAt: 0.9 }

  // Claude Code acts at 54m, so cache-seer compacts at 52m and Claude Code finds a small context.
  expect(aheadOfBuiltin({ ...parseOptions({}), builtin })).toBe(52 * MINUTE)
  expect(aheadOfBuiltin(parseOptions({}))).toBe(55 * MINUTE)
  // A set compactAfter, a 5m cache or the fallback off keep their own timing.
  expect(aheadOfBuiltin({ ...parseOptions({ compactAfter: '55m' }), builtin })).toBe(55 * MINUTE)
  expect(aheadOfBuiltin({ ...parseOptions({ cacheTtl: '5m' }), builtin })).toBe(4 * MINUTE)
  expect(aheadOfBuiltin({ ...parseOptions({ autoCompact: 'off' }), builtin })).toBe(55 * MINUTE)
  // Read again at each start, so it does not creep earlier.
  const once = { ...parseOptions({}), builtin }
  once.compactAt = aheadOfBuiltin(once)
  expect(aheadOfBuiltin(once)).toBe(52 * MINUTE)
})

test('each compaction line has its own icon state', () => {
  expect(['idle compact in 44m', 'idle compact in 5m', 'keepwarm 50m', 'idle compact on', 'idle compact on', 'idle compact off'].map(planStateOf)).toEqual([
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

test('keep awake holds only while an idle compaction or keepwarm waits on a warm cache', () => {
  const on = { ...options, keepAwake: true }
  const builtin = { ...on, autoCompact: false, builtin: { minTokens: 100_000, fireAt: 0.9 } }

  expect(wantsAwake(warm, at(30 * MINUTE), on)).toBe(true)
  expect(wantsAwake(warm, at(30 * MINUTE), { ...on, keepAwake: false })).toBe(false)
  // Compacted, tried, or cold: nothing left for waking to save.
  expect(wantsAwake({ ...warm, compacted: true }, at(30 * MINUTE), on)).toBe(false)
  expect(wantsAwake({ ...warm, compactTried: true }, at(30 * MINUTE), on)).toBe(false)
  expect(wantsAwake(warm, at(HOUR), on)).toBe(false)
  // No compaction on at all: no hold, unless keepwarm is armed.
  expect(wantsAwake(warm, at(30 * MINUTE), { ...on, autoCompact: false })).toBe(false)
  expect(wantsAwake({ ...warm, keepUntil: at(2 * HOUR) }, at(30 * MINUTE), { ...on, autoCompact: false })).toBe(true)
  // Claude Code's own idle compaction counts too.
  expect(wantsAwake(warm, at(30 * MINUTE), builtin)).toBe(true)
  expect(wantsAwake({ ...warm, tokens: 90_000 }, at(30 * MINUTE), builtin)).toBe(false)
})

/** Stand-ins for the band-switch tests: Windows, a helper that ends at once, and Claude Code's files. */
function switchSession($: any, on: any, files: Record<string, string> = {}) {
  const clock = mock.clock(on, { now: 1000 })
  const seen = { spawned: [] as string[], logs: [] as string[], files, clock }

  mock.store(on)
  standIn(on as never, () => {}, [], 'claude-opus-5-5', () => '', text => seen.logs.push(text))
  on('env.get', (_: unknown, e: { name: string }) => ({ value: ({ OS: 'Windows_NT', HOME: '/home/u' } as Record<string, string>)[e.name] }))
  // The engine resolves a path against the working directory: compare without the drive.
  const bare = (path: string) => path.replaceAll('\\', '/').replace(/^[A-Za-z]:/, '')
  on('fs.read', (_: unknown, e: { path: string }) => {
    if (!(bare(e.path) in seen.files)) throw new Error(`ENOENT ${e.path}`)
    return { value: seen.files[bare(e.path)] }
  })
  on('fs.write', (_: unknown, e: { path: string; text: string }) => {
    seen.files[bare(e.path)] = e.text
    return { value: undefined }
  })
  // A helper that ends at once stands for one that is not installed.
  on('process.spawn', async function* (_: unknown, e: { argv: string[] }) {
    seen.spawned.push(e.argv[0] ?? '')
    yield* []
    return { value: { code: 1, signal: null } }
  })

  return seen
}

async function start($: any, clock: { advance: (ms: number) => Promise<void> }) {
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete(COMPLETE)
  await clock.advance(MINUTE)
}

// The engine's `/cache-seer` lines, as the person reads them.
const run = async ($: any, args: string) => (await $.command.run({ command: 'cache-seer', args })) as { text: string }

test('keep awake is set by command and shown on the status line, for every session', { options: { autoCompact: 'on' } }, async ($, on) => {
  const seen = switchSession($, on)

  await start($, seen.clock)

  const terminal = await $.ui.mount({ ...(BAND as object), surface: 'terminal' } as never)
  const status = async () => (await terminal.find({ type: 'Text', text: /keep awake/ }))?.text

  expect(await status()).toBe(' · ○ keep awake off')
  // No switches on the band any more: status only.
  expect(await terminal.findAll({ type: 'Button' })).toEqual([])

  expect((await run($, 'awake on')).text).toContain('Keep awake is on')
  expect(await status()).toBe(' · ● keep awake on')
  // A warm cache with a compaction waiting: the hold starts with pwsh, then falls back to Windows PowerShell.
  for (let i = 0; i < 5 && seen.spawned.length < 2; i += 1) await seen.clock.advance(1)
  expect(seen.spawned).toEqual(['pwsh', 'powershell'])
  expect(seen.logs.some(line => line.includes('keep awake found no helper'))).toBe(true)
  await terminal.unmount()

  // A new session start reads it back from the store.
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const desktop = await $.ui.mount({ ...(BAND as object), surface: 'desktop' } as never)
  const svgs = await desktop.findAll({ type: 'Svg' })

  expect(svgs.some(svg => String(svg.props.source).includes('keep awake on'))).toBe(true)
  // The idle compaction clock is back on the status line.
  expect(svgs.some(svg => String(svg.props.source).includes('idle compact in'))).toBe(true)
  await desktop.unmount()

  expect((await run($, 'awake off')).text).toBe('Keep awake is off.')
  expect((await run($, 'sideways')).text).toBe('Usage: /cache-seer [compact|awake|motion on|off]')
})

test('motion off by command freezes every drawing', { options: { autoCompact: 'on' } }, async ($, on) => {
  const seen = switchSession($, on)

  await start($, seen.clock)

  const ui = await $.ui.mount({ ...(BAND as object), surface: 'desktop' } as never)
  const frozen = async () => (await ui.findAll({ type: 'Svg' })).map(svg => String(svg.props.source).includes('svg *{animation:none!important}'))

  expect(await frozen()).toEqual([false, false])
  expect((await run($, 'motion off')).text).toBe("The band's animation is off.")
  expect(await frozen()).toEqual([true, true])
  expect((await run($, 'motion on')).text).toBe("The band's animation is on.")
  expect(await frozen()).toEqual([false, false])
  await ui.unmount()
})

/** An install renamed from cache-keeper: its settings, its store file, and a folder listing for it. */
function renamedSession($: any, on: any, pluginConfigs: Record<string, unknown>) {
  const oldStore = '/home/u/.claude/plugins/store/cache-keeper_cache-keeper-5e1f38afcc59.json'
  const seen = switchSession($, on, {
    '/home/u/.claude/settings.json': JSON.stringify({ enabledPlugins: { 'cache-keeper@cache-keeper': true }, pluginConfigs }),
    [oldStore]: JSON.stringify({ prefs: { animate: false } }),
  })

  on('fs.list', () => ({
    value: [{ name: 'cache-keeper_cache-keeper-5e1f38afcc59.json', kind: 'file', size: 1, mtimeMs: 0, isLink: false }],
  }))

  return seen
}

test('a cache-keeper install carries its options and store over once, and is told to go', async ($, on) => {
  const seen = renamedSession($, on, { 'cache-keeper@cache-keeper': { options: { guard: 'warn' } } })

  await start($, seen.clock)

  const status = (await run($, '')).text

  expect(status).toContain('guard: warn')
  expect(status).toContain('motion: off')
  expect(seen.logs.some(line => line.includes('/plugin uninstall cache-keeper'))).toBe(true)

  // Copied once: a later change is not undone by the old store.
  await run($, 'motion on')
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect((await run($, '')).text).toContain('motion: on')
})

test('cache-seer options of its own win over the old ones', async ($, on) => {
  const seen = renamedSession($, on, {
    'cache-keeper@cache-keeper': { options: { guard: 'warn' } },
    'cache-seer@cache-seer': { options: { guard: 'ask' } },
  })

  await start($, seen.clock)
  expect((await run($, '')).text).toContain('guard: ask')
})
