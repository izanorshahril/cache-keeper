// The band's drawings. Pure: each function returns an SVG string for Svg.
// Motion is CSS only, so a reduced-motion setting stops all of it.

import { ADVANCE, FONT } from './font'
import type { CacheParts, RatePart, Tone } from './logic'

export const BG = '#24221c'
export const TEXT = '#e8e2d2'
export const MUTED = '#8d8775'
export const EMPTY = '#4a463b'

export const TONE: Readonly<Record<Tone, string>> = {
  ok: '#6ea8ff',
  watch: '#f5b342',
  high: '#ff8a4c',
  critical: '#ff5f5f',
}

export const MODE_HUE: Readonly<Record<CacheParts['mode'], string>> = {
  warm: '#4eba65',
  cold: '#8fd0e6',
  compacted: '#b9a7e8',
}

const WORD: Readonly<Record<CacheParts['mode'], string>> = { warm: 'WARM', cold: 'COLD', compacted: 'COMPACT' }
const INK = '#17150f'

export type Drawing = { source: string; width: number; height: number }

const widthOf = (text: string, size: number, spacing = 0) =>
  [...text].reduce((sum, ch) => sum + (ADVANCE[ch] ?? 0.6) * size + spacing, 0)

const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const STILL = '@media (prefers-reduced-motion:reduce){*{animation:none!important}}'

const doc = (width: number, height: number, css: string, body: string, hasFont: boolean) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><style>` +
  (hasFont
    ? `@font-face{font-family:CK;font-weight:400 700;src:url(data:font/woff2;base64,${FONT}) format('woff2')}` +
      `text{font-family:CK,'Segoe UI',system-ui,sans-serif}`
    : '') +
  css +
  STILL +
  `</style>${body}</svg>`

type Run = { text: string; size?: number; weight?: number; fill: string; opacity?: number; gap?: number; spacing?: number }

/** Lays text runs out left to right from x; returns the markup and where it ended. */
function runs(list: readonly Run[], start: number, y: number): { svg: string; end: number } {
  let x = start
  let svg = ''

  for (const run of list) {
    const size = run.size ?? 13
    x += run.gap ?? 0
    const opacity = run.opacity === undefined ? '' : ` opacity="${run.opacity}"`
    const spacing = run.spacing ? ` letter-spacing="${run.spacing}"` : ''
    svg += `<text x="${x.toFixed(1)}" y="${y}" font-size="${size}" font-weight="${run.weight ?? 500}" fill="${run.fill}"${opacity}${spacing}>${esc(run.text)}</text>`
    x += widthOf(run.text, size, run.spacing ?? 0)
  }

  return { svg, end: x }
}

// ---------- Usage ----------

const CELL_STEP = 8.5
const USAGE_HEIGHT = 26
const MID = 13
const BASE = 17.5

function usageDots(part: RatePart, cells: number, x: number, index: number): string {
  const lit = (part.left / 100) * cells
  const color = TONE[part.tone]
  let svg = ''

  for (let i = 0; i < cells; i += 1) {
    const cx = x + 3 + i * CELL_STEP
    const fill = Math.min(1, Math.max(0, lit - i))

    svg += `<circle cx="${cx}" cy="${MID}" r="3" fill="${EMPTY}"/>`

    if (fill > 0) {
      const delay = (i * 0.09 + index * 0.4).toFixed(2)

      svg +=
        `<circle class="dot" cx="${cx}" cy="${MID}" r="3" fill="url(#g${index})" filter="url(#glow)"` +
        ` opacity="${Math.max(0.35, fill).toFixed(2)}" style="animation-delay:${delay}s"/>`
    }
  }

  return `<linearGradient id="g${index}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset=".45" stop-color="${color}"/></linearGradient>${svg}`
}

/** USAGE, then each window's dots, percent left and reset time, coloured by how much is left. */
export function usageSvg(parts: readonly RatePart[], cells: number): Drawing {
  let x = 0
  let body = runs([{ text: 'USAGE', size: 12.5, weight: 700, fill: TEXT, spacing: 0.6 }], x, BASE).svg

  x += widthOf('USAGE', 12.5, 0.6) + 14

  parts.forEach((part, index) => {
    const color = TONE[part.tone]
    const label = runs([{ text: part.name, size: 12.5, weight: 700, fill: MUTED }], x, BASE)

    body += label.svg
    x = label.end + 6
    body += usageDots(part, cells, x, index)
    x += cells * CELL_STEP + 5

    const className = part.tone === 'critical' ? ' class="alert"' : ''
    const words = runs(
      [
        { text: `${part.left}%`, size: 14, weight: 700, fill: color },
        { text: 'left', size: 12.5, weight: 500, fill: color, opacity: 0.8, gap: 3.5 },
        ...(part.isLow ? [{ text: 'LOW', size: 11.5, weight: 700, fill: color, gap: 5, spacing: 0.5 }] : []),
        ...(part.reset ? [{ text: `· ${part.reset}`, size: 12.5, weight: 500, fill: color, opacity: 0.62, gap: 5 }] : []),
      ],
      x,
      BASE,
    )

    body += `<g${className}>${words.svg}</g>`
    x = words.end + 18
  })

  const width = Math.ceil(x - 12)
  const css =
    '.dot{animation:breathe 3.2s ease-in-out infinite}@keyframes breathe{0%,70%,100%{filter:none}35%{filter:brightness(1.35)}}' +
    '.alert{animation:alert 1.3s ease-in-out infinite}@keyframes alert{50%{opacity:.5}}'
  const defs = '<defs><filter id="glow" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="1.1" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>'

  return { source: doc(width, USAGE_HEIGHT, css, defs + body, true), width, height: USAGE_HEIGHT }
}

// ---------- Cache status ----------

/** The chip, with a light sweeping across it, then the time, cost and plan. */
export function statusSvg(cache: CacheParts): Drawing {
  const hue = MODE_HUE[cache.mode]
  const word = WORD[cache.mode]
  const chipWidth = Math.ceil(widthOf(word, 12, 1) + 18)
  const chipHeight = 20
  const top = 3
  const y = 17.5
  const text = runs(
    [
      { text: cache.time, size: 13.5, weight: 700, fill: hue },
      ...(cache.cost ? [{ text: `· ${cache.cost}`, size: 13.5, weight: 700, fill: TEXT, gap: 5 }] : []),
      ...(cache.plan ? [{ text: `· ${cache.plan}`, size: 12.5, weight: 500, fill: MUTED, gap: 5 }] : []),
    ],
    chipWidth + 8,
    y,
  )
  const width = Math.ceil(text.end + 2)
  const height = 26
  const css =
    '.chip{animation:halo 2.8s ease-in-out infinite}@keyframes halo{50%{filter:drop-shadow(0 0 3.5px ' + hue + ')}}' +
    '.sweep{animation:sweep 4.5s ease-in-out infinite}@keyframes sweep{0%,55%{transform:translateX(-30px)}100%{transform:translateX(' + (chipWidth + 30) + 'px)}}'
  const body =
    `<defs><clipPath id="c"><rect y="${top}" width="${chipWidth}" height="${chipHeight}" rx="6.5"/></clipPath></defs>` +
    `<g class="chip"><rect y="${top}" width="${chipWidth}" height="${chipHeight}" rx="6.5" fill="${hue}"/></g>` +
    `<g clip-path="url(#c)"><path class="sweep" d="M0 ${top + chipHeight}L10 ${top}h9L9 ${top + chipHeight}z" fill="#fff" opacity=".4"/></g>` +
    `<text x="${chipWidth / 2}" y="${top + 14.2}" font-size="12" font-weight="700" letter-spacing="1" text-anchor="middle" fill="${INK}">${word}</text>` +
    text.svg

  return { source: doc(width, height, css, body, true), width, height }
}

// ---------- The mascot ----------

type Palette = Readonly<Record<string, string>>

const WARM: Palette = { H: '#f0a285', B: '#d97757', S: '#b95d3f', D: '#8c452e', E: '#22140e', W: '#ffffff', C: '#ee9c84' }
const ICE: Palette = { H: '#f0fafd', B: '#b7deeb', S: '#8cbfd2', D: '#5f93a8', E: '#2c4653', W: '#ffffff', C: '#d6edf5' }

// One letter a pixel on a 20 by 12 grid: highlight, base, shade, deep shade.
const BODY = [
  '....HHHHHHHHHHHH....',
  '...HHBBBBBBBBBBBS...',
  '...HHBBBBBBBBBBBS...',
  '...HBBBBBBBBBBBBS...',
  '...HBBBBBBBBBBBSS...',
  '...HBBBBBBBBBBBSS...',
  '...HBCCBBBBBBCCBS...',
  '...HBBBBBDDBBBBSS...',
  '...BBBBBBBBBBBSSS...',
  '....SSSSSSSSSSSS....',
]
const EYES = [
  '....................',
  '....................',
  '.....EEE....EEE.....',
  '.....EWE....EWE.....',
  '.....EEE....EEE.....',
  '.....EEE....EEE.....',
]
const SHUT = [
  '....................',
  '....................',
  '....................',
  '....................',
  '.....EEE....EEE.....',
]
const ARM_LEFT = ['....', '....', '....', '....', 'HHH.', 'BBB.', 'SSS.']
const ARM_RIGHT = ['....', '....', '....', '....', '.BBS', '.BBS', '.SSD']
const LEG = ['HS', 'BS', 'SD']

/** One path per colour: separate rects at fractional sizes leave seams. */
function pixels(rows: readonly string[], palette: Palette, ox: number, oy: number): string {
  const paths = new Map<string, string>()

  rows.forEach((row, y) => {
    ;[...row].forEach((ch, x) => {
      if (palette[ch]) paths.set(ch, `${paths.get(ch) ?? ''}M${ox + x} ${oy + y}h1v1h-1z`)
    })
  })

  return [...paths].map(([ch, d]) => `<path d="${d}" fill="${palette[ch]}"/>`).join('')
}

function figure(palette: Palette, isAsleep: boolean): string {
  const legs = [4, 7, 11, 14]
    .map((x, i) => `<g class="leg l${i}">${pixels(LEG, palette, x + 2, 11)}</g>`)
    .join('')
  const eyes = isAsleep
    ? pixels(SHUT, palette, 2, 2)
    : `<g class="eyes">${pixels(EYES, palette, 2, 2)}</g>` +
      `<g class="lids">${pixels(['EEE....EEE'], palette, 7, 6)}</g>`

  return (
    legs +
    `<g class="arm al">${pixels(ARM_LEFT, palette, 2, 1)}</g>` +
    `<g class="arm ar">${pixels(ARM_RIGHT, palette, 18, 1)}</g>` +
    pixels(BODY, palette, 2, 2) +
    eyes
  )
}

const FIGURE_CSS =
  '.fig,.arm,.leg,.eyes,.lids{transform-box:fill-box;transform-origin:center}' +
  '.lids{opacity:0;animation:blink 4.2s steps(1) infinite}@keyframes blink{0%,91%,100%{opacity:0}92%,96%{opacity:1}}' +
  '.eyes{animation:look 7s steps(1) infinite}@keyframes look{0%,62%,100%{transform:none}63%,74%{transform:translateX(.6px)}}'

const WARM_CSS =
  '.fig{animation:bob 2.2s ease-in-out infinite}@keyframes bob{50%{transform:translateY(-1.2px)}}' +
  '.shadow{transform-box:fill-box;transform-origin:center;animation:shadow 2.2s ease-in-out infinite}@keyframes shadow{50%{transform:scaleX(.82)}}' +
  '.ember{opacity:0;animation:ember 2.6s ease-out infinite}@keyframes ember{0%{opacity:0;transform:none}25%{opacity:.95}100%{opacity:0;transform:translateY(-7px)}}' +
  '.e2{animation-delay:.9s}.e3{animation-delay:1.7s}' +
  'svg:hover .fig{animation:hop .55s ease-in-out infinite}@keyframes hop{50%{transform:translateY(-3px)}}' +
  'svg:hover .al{animation:wave .28s ease-in-out infinite}@keyframes wave{50%{transform:translateY(-3px)}}' +
  'svg:hover .ar{animation:wave .28s ease-in-out .14s infinite}'

const COLD_CSS =
  '.fig{animation:shiver 3.4s linear infinite}@keyframes shiver{0%,84%,100%{transform:none}86%,90%,94%{transform:translateX(-.35px)}88%,92%,96%{transform:translateX(.35px)}}' +
  '.lids{animation:none}' +
  '.flake{opacity:0;animation:fall 3.4s linear infinite}@keyframes fall{0%{opacity:0;transform:none}15%{opacity:1}85%{opacity:.9}100%{opacity:0;transform:translate(1px,15px)}}' +
  '.f2{animation-delay:1.1s}.f3{animation-delay:2.3s}' +
  '.twinkle{transform-box:fill-box;transform-origin:center;animation:twinkle 2.9s ease-in-out infinite}@keyframes twinkle{0%,55%,100%{opacity:0;transform:scale(.4)}72%{opacity:1;transform:scale(1)}}' +
  'svg:hover .fig{animation:shake .16s linear infinite}@keyframes shake{25%{transform:translateX(-.5px)}75%{transform:translateX(.5px)}}' +
  'svg:hover .twinkle{animation-duration:.9s}'

const SLEEP_CSS =
  '.fig{animation:breath 3.6s ease-in-out infinite}@keyframes breath{50%{transform:scaleY(.965)}}' +
  '.z{opacity:0;font-weight:700;animation:zed 3.6s ease-out infinite}@keyframes zed{0%{opacity:0;transform:none}25%{opacity:.95}100%{opacity:0;transform:translate(4px,-7px)}}' +
  '.z2{animation-delay:1.2s}.z3{animation-delay:2.4s}'

const SIZE = { width: 46, height: 36 }

/** The mascot: bobbing with embers when warm, iced over when cold, napping once compacted. */
export function mascotSvg(mode: CacheParts['mode']): Drawing {
  const shadow = '<ellipse class="shadow" cx="12" cy="16.6" rx="8.5" ry=".8" fill="#000" opacity=".4"/>'
  const open = '<g transform="translate(1 2.5)" shape-rendering="crispEdges">'
  let css = FIGURE_CSS
  let body = ''

  if (mode === 'warm') {
    css += WARM_CSS
    body =
      `${shadow}${open}<g class="fig">${figure(WARM, false)}</g></g>` +
      '<circle class="ember" cx="4" cy="8" r=".55" fill="#ffc27a"/>' +
      '<circle class="ember e2" cx="20.5" cy="6" r=".45" fill="#ff9d5c"/>' +
      '<circle class="ember e3" cx="13" cy="3.5" r=".4" fill="#ffd9a0"/>'
  } else if (mode === 'cold') {
    css += COLD_CSS
    body =
      `${shadow}${open}<g class="fig">${figure(ICE, false)}</g></g>` +
      '<rect x=".9" y="1" width="23" height="15.2" rx="2.4" fill="#8fd0e6" fill-opacity=".26" stroke="#d4eff8" stroke-width=".5"/>' +
      '<path d="M3 5.4l3-3M3 8l1.5-1.5M20 14.4l2.2-2.2" stroke="#fff" stroke-opacity=".8" stroke-width=".45" stroke-linecap="round"/>' +
      '<path d="M5 16.2h1.8l-.9 1.9zM11.5 16.2h1.6l-.8 1.4zM18 16.2h1.8l-.9 2z" fill="#d4eff8"/>' +
      '<path class="twinkle" d="M23.6 .1l.4 1.3 1.3.4-1.3.4-.4 1.3-.4-1.3-1.3-.4 1.3-.4z" fill="#fff"/>' +
      '<circle class="flake" cx="2.6" cy="1.2" r=".35" fill="#fff"/>' +
      '<circle class="flake f2" cx="12" cy=".8" r=".3" fill="#fff"/>' +
      '<circle class="flake f3" cx="21" cy="1" r=".35" fill="#fff"/>'
  } else {
    css += SLEEP_CSS
    body =
      `${shadow}${open}<g class="fig">${figure(WARM, true)}</g></g>` +
      '<g font-family="system-ui,sans-serif" fill="#b9a7e8">' +
      '<text class="z" x="20" y="6" font-size="3">z</text>' +
      '<text class="z z2" x="21" y="5" font-size="3.6">z</text>' +
      '<text class="z z3" x="22" y="4" font-size="4.2">Z</text></g>'
  }

  const source = doc(SIZE.width, SIZE.height, css, `<g transform="scale(1.72 1.72) translate(.2 .2)">${body}</g>`, false)

  return { source, width: SIZE.width, height: SIZE.height }
}
