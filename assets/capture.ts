// Drives headless Edge over CDP to capture the band's real drawings, frame by frame.
// Seeking the Web Animations clock makes every frame exact, whatever the capture speed.
// Usage: bun capture.ts <outDir> <still|gif|all>
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { BG, mascotSvg, statusSvg, usageSvg } from '../hooks/art.ts'
import { EMPTY, MINUTE, cacheParts, parseOptions, rateParts } from '../hooks/logic.ts'
import { FONT } from '../hooks/font.ts'

const [outDir, what = 'all'] = process.argv.slice(2)
if (!outDir) throw new Error('outDir required')

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PORT = 9333
const NOW = Date.parse('2026-11-05T12:00:00Z')
// Claude Code's idle compaction on, as on an account in its rollout, so the band shows its timer.
const options = { ...parseOptions({}), builtin: { minTokens: 200_000, fireAt: 0.9 } }
const HOUR = 60 * MINUTE

// Example figures only: a 240k context on Opus 5.5, priced by the mod's own table.
const MODEL = 'claude-opus-5-5'
const core = { ...EMPTY, tokens: 240_000, window: 1_000_000, model: MODEL, replyModel: MODEL }
const rates = (sevenDay: number, fiveHour: number) => [
  { kind: 'seven_day', percentUsed: sevenDay, resetsAt: new Date(NOW + 121 * HOUR).toISOString() },
  { kind: 'five_hour', percentUsed: fiveHour, resetsAt: new Date(NOW + 3.2 * HOUR).toISOString() },
]

type State = { idleMin: number; compacted?: boolean; used?: [number, number] }

function drawings(state: State) {
  const value = {
    ...core,
    lastAt: NOW - state.idleMin * MINUTE,
    byModel: { 'opus-5-5': NOW - state.idleMin * MINUTE },
    compacted: state.compacted ?? false,
    tokens: state.compacted ? 12_000 : core.tokens,
  }
  const cache = cacheParts(value, NOW, options, MODEL)!
  const [a, b] = state.used ?? [11, 33]

  return {
    mode: cache.mode,
    usage: usageSvg(rateParts(rates(a, b), NOW), 10).source,
    mascot: mascotSvg(cache.mode).source,
    status: statusSvg(cache).source,
  }
}

const PAGE = `<!doctype html><meta charset="utf-8"><style>
@font-face{font-family:CK;font-weight:400 700;src:url(data:font/woff2;base64,${FONT}) format('woff2')}
*{box-sizing:border-box}html,body{margin:0;background:#14130f}
body{font-family:CK,sans-serif;color:#e8e2d2}
#stage{position:relative;overflow:hidden}
.band{display:inline-flex;flex-wrap:wrap;align-items:center;gap:6px 14px;background:${BG};padding:8px 16px;border-radius:14px}
.group{display:inline-flex;align-items:center;gap:8px}
svg{display:block}
</style><div id="stage"></div>`

// ---------- CDP ----------
const profile = mkdtempSync(join(tmpdir(), 'ck-edge-'))
const edge = Bun.spawn(
  [EDGE, '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--hide-scrollbars', '--no-first-run', 'about:blank'],
  { stdout: 'ignore', stderr: 'ignore' },
)

async function target(): Promise<string> {
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[]
      const page = list.find(t => t.type === 'page')
      if (page) return page.webSocketDebuggerUrl
    } catch {}
    await Bun.sleep(250)
  }
  throw new Error('no browser target')
}

const ws = new WebSocket(await target())
await new Promise(r => (ws.onopen = r))
let nextId = 1
const waiting = new Map<number, (v: any) => void>()
ws.onmessage = m => {
  const data = JSON.parse(String(m.data))
  if (data.id && waiting.has(data.id)) {
    waiting.get(data.id)!(data)
    waiting.delete(data.id)
  }
}
const send = (method: string, params: object = {}): Promise<any> =>
  new Promise((resolve, reject) => {
    const id = nextId++
    waiting.set(id, r => (r.error ? reject(new Error(`${method}: ${r.error.message}`)) : resolve(r.result)))
    ws.send(JSON.stringify({ id, method, params }))
  })
const run = async (expression: string) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? ''))
  return r.result.value
}

async function setSize(width: number, height: number, scale: number) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false })
}
await send('Page.enable')
await send('Page.navigate', { url: `data:text/html;base64,${Buffer.from(PAGE).toString('base64')}` })
await Bun.sleep(600)
await run('document.fonts.load("700 20px CK").then(()=>document.fonts.ready).then(()=>1)')

let shown = ''
async function show(html: string, seconds: number, extra = '') {
  if (html !== shown) {
    await run(`document.getElementById('stage').innerHTML=${JSON.stringify(html)};document.fonts.ready.then(()=>1)`)
    shown = html
  }
  await run(`document.getAnimations().forEach(a=>{a.pause();a.currentTime=${Math.round(seconds * 1000)}});${extra};1`)
}
async function shot(path: string, clip?: object) {
  const r = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip, captureBeyondViewport: false } : {}) })
  writeFileSync(path, Buffer.from(r.data, 'base64'))
}

const bandHtml = (state: State) => {
  const d = drawings(state)
  return `<div style="padding:12px;display:inline-block"><div class="band">${d.usage}<span class="group">${d.mascot}${d.status}</span></div></div>`
}

// ---------- Stills ----------
async function stills() {
  const dir = join(outDir!, 'media')
  mkdirSync(dir, { recursive: true })
  await setSize(1000, 200, 2)
  const list: [string, State][] = [
    ['band-warm', { idleMin: 3 }],
    ['band-cold', { idleMin: 765, used: [55, 11] }],
    ['band-compacted', { idleMin: 56, compacted: true }],
    ['band-low-usage', { idleMin: 20, used: [72, 92] }],
  ]
  for (const [name, state] of list) {
    await show(bandHtml(state), 1.4)
    const box = await run(`(()=>{const r=document.querySelector('.band').getBoundingClientRect();return {x:r.x-10,y:r.y-10,width:r.width+20,height:r.height+20}})()`)
    await shot(join(dir, `${name}.png`), { ...box, scale: 1 })
    console.log(name, Math.round(box.width), Math.round(box.height))
  }
}

// ---------- README GIF ----------
const gifState = (t: number): State => {
  if (t < 3.2) return { idleMin: Math.round(3 + (t / 3.2) * 52) }
  if (t < 6) return { idleMin: 56, compacted: true }
  return { idleMin: 765, used: [55, 11] }
}
async function gif() {
  const dir = join(outDir!, 'frames-gif')
  mkdirSync(dir, { recursive: true })
  await setSize(980, 80, 1)
  const fps = 15
  const total = Math.round(9 * fps)
  for (let i = 0; i < total; i += 1) {
    const t = i / fps
    await show(`<div style="background:#14130f;width:980px;height:80px">${bandHtml(gifState(t))}</div>`, t)
    await shot(join(dir, `f${String(i).padStart(4, '0')}.png`))
  }
  console.log('gif frames', total)
}

try {
  if (what === 'still' || what === 'all') await stills()
  if (what === 'gif' || what === 'all') await gif()
} finally {
  ws.close()
  edge.kill()
}
process.exit(0)
