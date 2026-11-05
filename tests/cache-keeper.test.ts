import { expect, mock, test } from 'claude-code/testing'

import { MODE_HUE, mascotSvg, statusSvg, usageSvg } from '../hooks/art'
import { EMPTY, HOUR, MINUTE, cacheParts, compactAtMs, decide, parseDuration, parseOptions, priceOf, rateParts, toneOf } from '../hooks/logic'

const options = parseOptions({})
const warm = { ...EMPTY, lastAt: 1000, tokens: 180_000, model: 'claude-opus-5-5' }
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
  expect(priceOf('claude-opus-5-5', 1000)).toEqual({ read: 0.2, write: 8 })
  expect(priceOf('claude-opus-5', 1000)).toEqual({ read: 0.5, write: 10 })
  expect(priceOf('claude-fable-5-1', 1000)).toEqual({ read: 0.25, write: 20 })
  expect(priceOf('claude-haiku-5-5', 200_000)).toEqual({ read: 0.05, write: 1 })
  expect(priceOf('gpt-x', 1000)).toBe(null)
})

test('the cache parts say warm, cold and compacted', () => {
  expect(cacheParts(warm, at(10 * MINUTE), options)).toMatchObject({
    mode: 'warm',
    time: '50m left',
    cost: '$0.04',
    plan: 'compacts in 45m',
  })
  expect(cacheParts(warm, at(2 * HOUR), options)).toMatchObject({ mode: 'cold', time: '2h 0m', cost: '$1.44', plan: null })
  expect(cacheParts({ ...warm, compacted: true, tokens: 12_000 }, at(0), options)).toMatchObject({
    mode: 'compacted',
    time: '12k',
    cost: null,
  })
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
  const cold = statusSvg({ mode: 'cold', time: '12h 45m', cost: '$4.78', plan: null, summary: '' })

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

const standIn = (on: never, compact: () => void, rateLimits: unknown[] = []) => {
  on('command.register', () => ({ value: { command: 'x' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's1' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
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
    compact()
    return { messages: [SUMMARY], tokensAfter: 12_000 }
  })
}

test('an idle session compacts once and only once', async ($, on) => {
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

test('the band draws usage and cache state on every surface', async ($, on) => {
  mock.clock(on, { now: 1000 })
  mock.store(on)
  standIn(on, () => {}, [{ kind: 'five_hour', percentUsed: 90 }])

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' } as never)
  await $.turn.complete(COMPLETE as never)

  const terminal = await $.ui.mount({ ...(BAND as object), surface: 'terminal' } as never)

  expect((await terminal.find({ type: 'Text', text: /LOW/ }))?.text).toContain('10% left')
  expect((await terminal.find({ type: 'Text', text: /Cache warm/ }))?.text).toContain('compacts in 55m')
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
