// TeleGift Glance — underpriced Telegram Gifts on Even Realities G2.
// Read: the freshest gift listing that sells far below the top sale of its model + backdrop.
// Write: one tap sends the deal to your Telegram via our bot (with an "Open gift" button to buy on the phone).
//   swipe down / up — next / previous deal · tap — full gift info · double tap — watch the lot · hold — send to Telegram · Menu — exit
//   (in the simulator Up/Down rarely reach the app, so the next deal is on the double tap; exit is in the system Menu)
import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerUpgrade,
  ImageContainerProperty,
  ImageRawDataUpdate,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'
import lottie from 'lottie-web/build/player/lottie_light_canvas'

type Deal = {
  id: string; title: string; num: number; model: string; backdrop: string; pattern?: string
  price: number; cur: 'STARS' | 'GRAM'; usd: number | null; x: number; floor: number | null; cheapest?: boolean
  typical: number | null; max: number | null; sales: number | null; market: string; url: string | null; seen_s: number
  resell?: { sell: number; net: number; cost_usd: number; get_usd: number; profit_usd: number } | null
  fair?: number | null; stars?: number | null; rs_pct?: number | null; rs_good?: boolean
  mr?: string | null; br?: string | null; pr?: string | null
  max_mk?: string                        // the marketplace of the top sale the "×" is measured to
  sold?: boolean
}

const API = (import.meta.env.VITE_API as string | undefined) || 'http://localhost:8090'
const POLL_MS = 8000
const TOKEN_KEY = 'telegift.token'
const MARKET: Record<string, string> = {
  telegram: 'Telegram', onchain: 'On-chain', mrkt: 'MRKT', portals: 'Portals', tonnel: 'Tonnel', getgems: 'GetGems',
}

const bridge = await waitForEvenAppBridge()

// ---------- screen layout ----------
// The lens is a 576×288 monochrome green display. To look like the TeleGift app, the whole screen above the hint line
// is drawn on a canvas — gift card with the model picture, market plaque, "↗ N×" badge, name, number, price —
// and sent to the glasses as 4 grayscale image tiles (black = off). The hint line below is a text container that
// also receives the touch events.
const W = 576, H = 256, TW = 288
const TILES = [
  // the big glance model (x 10..226) lies in the left column: an animation frame resends only t1 and t3
  { id: 1, name: 't1', x: 0, y: 0, w: TW, h: 144 },
  { id: 2, name: 't2', x: TW, y: 0, w: TW, h: 144 },
  { id: 3, name: 't3', x: 0, y: 144, w: TW, h: H - 144 },
  { id: 4, name: 't4', x: TW, y: 144, w: TW, h: H - 144 },
]
const tiles = TILES.map((t) => new ImageContainerProperty({
  xPosition: t.x, yPosition: t.y, width: t.w, height: t.h, containerID: t.id, containerName: t.name,
}))
const foot = new TextContainerProperty({
  xPosition: 0, yPosition: H, width: 576, height: 288 - H, borderWidth: 0, borderColor: 5, paddingLength: 0,   // no padding: see below
  containerID: 5, containerName: 'foot', content: '', isEventCapture: 1,
})
const page = { containerTotalNum: 5, textObject: [foot], imageObject: tiles }
await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(page))
// After an app reload the glasses keep the old page — rebuild it so every container exists.
await bridge.rebuildPageContainer(new RebuildPageContainer(page))

// Gesture hints in the bottom line (owner 27.11): the first minutes — quiet capitals, then the line is empty.
// The text container itself stays: only through it do the glasses send gestures to the app.
const HINT_MS = 3 * 60_000, HINT_COLOR = 0, startedAt = Date.now()
const hint = (t: string) => (Date.now() - startedAt < HINT_MS ? t.toUpperCase().replace(/ {3}/g, '  ·  ') : ' ')
const putLast = new Map<number, string>()
function put(id: number, name: string, content: string, textColor?: number) {
  const k = `${content}|${textColor}`
  if (putLast.get(id) === k) return                  // the timer repaints every second — don't resend the same text
  putLast.set(id, k)
  bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: id, containerName: name, content, textColor }))
}

// ---------- model picture: shading + contours, in grayscale ----------
const modelCache = new Map<string, HTMLCanvasElement | null>()
const MODEL_PX = 116                     // drawn pixel-for-pixel on the lens (card)
const GLANCE_PX = 216                    // the glance: the gift almost the full height of the lens (owner 27.11)

async function modelPicture(title: string, model: string, size: number): Promise<HTMLCanvasElement | null> {
  const key = `${title}|${model}|${size}`
  if (modelCache.has(key)) return modelCache.get(key)!
  let out: HTMLCanvasElement | null = null
  try {
    const r = await fetch(`${API}/model?c=${encodeURIComponent(title)}&m=${encodeURIComponent(model)}`)
    if (r.ok) out = lensify(await createImageBitmap(await r.blob()), size).c
  } catch { out = null }
  modelCache.set(key, out)
  if (modelCache.size > 40) modelCache.delete(modelCache.keys().next().value!)
  return out
}

// A colour picture of the model → the lens look. `range` fixes the brightness range (animation frames share the first one's,
// otherwise every frame would be stretched on its own and the model would flicker).
function lensify(bmp: CanvasImageSource & { width: number; height: number }, size: number, range?: [number, number]) {
      const c = document.createElement('canvas'); c.width = c.height = size
      const ctx = c.getContext('2d')!
      const k = Math.min(size / bmp.width, size / bmp.height)
      const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k)
      // shrink in halves (1024 → 512 → 256 → size): much sharper than one big jump
      let src: CanvasImageSource = bmp, sw = bmp.width, sh = bmp.height
      while (sw / 2 > w) {
        const t = document.createElement('canvas'); t.width = Math.round(sw / 2); t.height = Math.round(sh / 2)
        const tc = t.getContext('2d')!; tc.imageSmoothingQuality = 'high'; tc.drawImage(src, 0, 0, t.width, t.height)
        src = t; sw = t.width; sh = t.height
      }
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(src, Math.round((size - w) / 2), Math.round((size - h) / 2), w, h)
      const img = ctx.getImageData(0, 0, size, size)
      const d = img.data, N = size * size
      const lum = new Float32Array(N), alpha = new Float32Array(N), vals: number[] = []
      for (let p = 0; p < N; p++) {
        const i = p * 4
        alpha[p] = d[i + 3] / 255
        lum[p] = 0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2]
        if (alpha[p] > 0.5) vals.push(lum[p])
      }
      vals.sort((a, b) => a - b)
      const lo = range ? range[0] : vals.length ? vals[Math.floor(vals.length * 0.04)] : 0
      const hi = range ? range[1] : vals.length ? vals[Math.floor(vals.length * 0.97)] : 255
      const span = Math.max(20, hi - lo)
      const tone = new Float32Array(N)
      for (let p = 0; p < N; p++) tone[p] = Math.min(1, Math.max(0, (lum[p] - lo) / span)) * alpha[p]
      const sharp = new Float32Array(tone)                       // unsharp mask: details and small shapes pop
      for (let y = 1; y < size - 1; y++) for (let x = 1; x < size - 1; x++) {
        const p = y * size + x
        const blur = (tone[p - 1] + tone[p + 1] + tone[p - size] + tone[p + size]) / 4
        sharp[p] = Math.min(1, Math.max(0, tone[p] + 1.1 * (tone[p] - blur)))
      }
      tone.set(sharp)
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const p = y * size + x, i = p * 4
        let e = 0
        if (x > 0 && y > 0 && x < size - 1 && y < size - 1) {
          const t = tone
          const gx = t[p - size + 1] + 2 * t[p + 1] + t[p + size + 1] - t[p - size - 1] - 2 * t[p - 1] - t[p + size - 1]
          const gy = t[p + size - 1] + 2 * t[p + size] + t[p + size + 1] - t[p - size - 1] - 2 * t[p - size] - t[p - size + 1]
          e = Math.min(1, Math.hypot(gx, gy) * 0.9)
        }
        const t0 = tone[p] / Math.max(alpha[p], 0.01)
        const v = (10 + 190 * t0 * t0) * (1 - 0.85 * e)          // the lens lifts darks, so keep the range low
        d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = Math.round(alpha[p] * 255)
      }
      ctx.putImageData(img, 0, 0)
      return { c, range: [lo, hi] as [number, number] }
}

// ---------- model animation: a few frames of the gift's own animation, played once when a new deal shows ----------
// Only gifts that are on Fragment have it (on-chain collections); the others keep the still picture.
// Played at the animation's own speed: each frame goes out as soon as the lens took the previous one; if the lens is slower,
// frames are skipped by the clock (never slowed down or jerked), so the motion stays even.
const STILL_K = 0.7                              // the gift 30 % smaller in its square (owner 27.11)
async function stillPicture(title: string, model: string): Promise<HTMLCanvasElement | null> {
  const p = await modelPicture(title, model, Math.round(GLANCE_PX * STILL_K))
  if (!p) return null
  const c = document.createElement('canvas'); c.width = c.height = GLANCE_PX
  c.getContext('2d')!.drawImage(p, Math.round((GLANCE_PX - p.width) / 2), Math.round((GLANCE_PX - p.height) / 2))
  return c
}
const ANIM_FRAMES = 90                           // up to 30 frames a second of a 3 s animation
// The gift's symbols behind the model (owner 27.11): the 'Pattern' layer of the same Fragment animation, on the same canvas
// and cut with the same crop as the model — so size and places are 1 in 1 as on the official card; drawn faintly.
const PATTERN_GRAY = 30                          // the lens lifts darks: 40 shows as a quiet gray
const PATTERN_VIEW = 1                           // the whole card: model 30 % smaller than the tight crop, all symbols as on the official card (owner 27.11)
async function patternLayer(slug: string, w: number, h: number): Promise<HTMLCanvasElement | null> {
  try {
    const r = await fetch(`${API}/model-anim?slug=${encodeURIComponent(slug)}&layer=pattern&v=2`)
    if (!r.ok) return null
    const data = await r.json()
    const box = document.createElement('div')
    box.style.cssText = 'position:fixed;left:-9999px;top:0;width:256px;height:256px;overflow:hidden'   // same as the model's box
    document.body.appendChild(box)
    const a = lottie.loadAnimation({ container: box, renderer: 'canvas', loop: false, autoplay: false, animationData: data,
      rendererSettings: { clearCanvas: true } })
    await new Promise<void>((res) => { if (a.isLoaded) res(); else { a.addEventListener('DOMLoaded', () => res()); setTimeout(res, 1500) } })
    const cv = box.querySelector('canvas')
    let out: HTMLCanvasElement | null = null
    if (cv) {                                      // drawn at the model canvas' size, whatever the screen density
      a.goToAndStop(0, true)
      out = document.createElement('canvas'); out.width = w; out.height = h
      out.getContext('2d')!.drawImage(cv, 0, 0, w, h)
    }
    a.destroy(); box.remove()
    return out
  } catch { return null }
}
// the cropped pattern → a faint one-gray silhouette of the symbols, the size of a frame
function faintPattern(src: HTMLCanvasElement, sx: number, sy: number, side: number, size: number) {
  const c = document.createElement('canvas'); c.width = c.height = size
  const ctx = c.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(src, sx, sy, side, side, 0, 0, size, size)
  const img = ctx.getImageData(0, 0, size, size), d = img.data
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255
    d[i] = d[i + 1] = d[i + 2] = PATTERN_GRAY; d[i + 3] = a > 0.25 ? 255 : Math.round(a * 4 * 255)
  }
  ctx.putImageData(img, 0, 0)
  return c
}
type Frames = HTMLCanvasElement[] & { dur?: number }
const animCache = new Map<string, Promise<Frames | null>>()
const restFrame = new Map<string, HTMLCanvasElement>()   // after playing, the deal keeps the animation's first frame (no jump to the still picture)

function modelFrames(slug: string): Promise<Frames | null> {
  if (!animCache.has(slug)) {
    animCache.set(slug, (async () => {
      try {
        const patP = patternLayer(slug, 512, 512)                  // in parallel with the animation
        const r = await fetch(`${API}/model-anim?slug=${encodeURIComponent(slug)}`)
        if (!r.ok) return null
        const data = await r.json()
        const box = document.createElement('div')
        box.style.cssText = 'position:fixed;left:-9999px;top:0;width:256px;height:256px;overflow:hidden'
        document.body.appendChild(box)
        const a = lottie.loadAnimation({ container: box, renderer: 'canvas', loop: false, autoplay: false, animationData: data,
          rendererSettings: { clearCanvas: true } })
        await new Promise<void>((res) => { if (a.isLoaded) res(); else { a.addEventListener('DOMLoaded', () => res()); setTimeout(res, 1500) } })
        const cv = box.querySelector('canvas')
        if (!cv) { a.destroy(); box.remove(); return null }
        const n = Math.max(1, a.totalFrames - 1), count = Math.min(ANIM_FRAMES, n)
        const out: Frames = []
        out.dur = Math.min(4000, Math.max(800, (1000 * a.totalFrames) / (a.frameRate || 60)))
        let range: [number, number] | undefined
        // the animation has wide empty margins: find the box the model ever occupies (every 6th frame) and crop all frames
        // to that same box — the model is as big as on the still picture and does not jump between frames
        const cx = cv.getContext('2d')!
        const patRaw = await patP
        let x0 = cv.width, y0 = cv.height, x1 = 0, y1 = 0
        for (let i = 0; i < (patRaw ? 0 : count); i += 6) {     // with symbols the whole card is shown: no need to scan
          a.goToAndStop(Math.round((i * n) / count), true)
          const px = cx.getImageData(0, 0, cv.width, cv.height).data
          for (let y = 0; y < cv.height; y += 2) for (let x = 0; x < cv.width; x += 2)
            if (px[(y * cv.width + x) * 4 + 3] > 24) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
        }
        if (x1 <= x0) { x0 = 0; y0 = 0; x1 = cv.width - 1; y1 = cv.height - 1 }
        // owner 27.11: the gift 30 % smaller than the tight crop (the same as the still picture, see stillPicture)
        let side = Math.min(cv.width, Math.round((Math.max(x1 - x0, y1 - y0) + 8) / STILL_K))
        let sx = Math.max(0, Math.min(cv.width - side, Math.round((x0 + x1 - side) / 2)))
        let sy = Math.max(0, Math.min(cv.height - side, Math.round((y0 + y1 - side) / 2)))
        let patSrc: HTMLCanvasElement | null = null
        if (patRaw) { patSrc = document.createElement('canvas'); patSrc.width = cv.width; patSrc.height = cv.height; patSrc.getContext('2d')!.drawImage(patRaw, 0, 0, cv.width, cv.height) }
        if (patSrc) {                // with the symbols: the card's own framing around its centre, so the inner ring fits
          side = Math.min(cv.width, Math.max(side, Math.round(PATTERN_VIEW * cv.width)))
          sx = Math.round((cv.width - side) / 2); sy = Math.round((cv.height - side) / 2)
        }
        const crop = document.createElement('canvas'); crop.width = crop.height = side
        const cc = crop.getContext('2d')!
        const pat = patSrc ? faintPattern(patSrc, sx, sy, side, GLANCE_PX) : null
        for (let i = 0; i < count; i++) {
          a.goToAndStop(Math.round((i * n) / count), true)
          cc.clearRect(0, 0, side, side); cc.drawImage(cv, sx, sy, side, side, 0, 0, side, side)
          const f = lensify(crop, GLANCE_PX, range)
          range = range || f.range
          if (pat) {                                       // symbols first, the model over them
            const m = document.createElement('canvas'); m.width = m.height = GLANCE_PX
            const mc = m.getContext('2d')!; mc.drawImage(pat, 0, 0); mc.drawImage(f.c, 0, 0)
            out.push(m)
          } else out.push(f.c)
          if (i === 0 && !restFrame.has(slug)) {           // the first frame replaces the still picture right away
            restFrame.set(slug, out[0])
            if (deals[idx]?.id === slug && !animId) paint()
          }
          await new Promise((res) => setTimeout(res, 0))       // let the lens keep drawing meanwhile
        }
        a.destroy(); box.remove()
        return out
      } catch { return null }
    })())
    if (animCache.size > 20) animCache.delete(animCache.keys().next().value!)
  }
  return animCache.get(slug)!
}

// the frame to rest on: the first one, unless the model is not fully there yet (some animations start empty)
function fullest(frames: Frames) {
  const ink = (c: HTMLCanvasElement) => { const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data; let t = 0; for (let i = 3; i < d.length; i += 4) t += d[i]; return t }
  const mid = frames[Math.floor(frames.length / 2)]
  return ink(frames[0]) >= 0.8 * ink(mid) ? frames[0] : mid
}

const animView = () => view === 'glance' || (view === 'history' && fpage === 0)
let animId = '', animStep = -1                  // the deal being animated and the frame shown (-1: still picture)
const animated = new Set<string>()              // deals whose animation is loading or looping now
async function playModel(d: Deal) {
  if (animated.has(d.id) || animId) return
  animated.add(d.id)
  const frames = await modelFrames(d.id)
  if (!frames) return                                          // no animation: stays marked, the still picture is used
  if (deals[idx]?.id !== d.id || !animView() || asleep) { animated.delete(d.id); return }
  animId = d.id
  // loops without a stop while this deal is on the glance; leaves → stops (and starts again when you come back)
  const dur = frames.dur || 3000, start = performance.now()
  let shown = 0
  for (;;) {
    if (deals[idx]?.id !== d.id || !animView() || asleep || (confirmDeal && Date.now() < confirmUntil)) break
    if (animOnce && performance.now() - start >= dur) break      // the user chose "once" in the bot's /settings
    const el = (performance.now() - start) % dur
    const i = Math.min(frames.length - 1, Math.floor((el / dur) * frames.length))
    if (i === animStep) { await new Promise((res) => setTimeout(res, 8)); continue }
    animStep = i; paint(); shown++
    await new Promise((res) => setTimeout(res, 0))
    while (drawing) await new Promise((res) => setTimeout(res, 8))      // wait until this frame is on the lens
  }
  console.log('anim fps', ((1000 * shown) / (performance.now() - start)).toFixed(1), 'of', ((1000 * frames.length) / dur).toFixed(1))
  animated.delete(d.id)
  restFrame.set(d.id, fullest(frames))
  if (restFrame.size > 30) restFrame.delete(restFrame.keys().next().value!)
  animId = ''; animStep = -1
  if (deals[idx]?.id === d.id) paint()
}

// ---------- gift backdrop + pattern symbols (from the full gift picture) ----------
// Kept in the dark range so the model stays the brightest thing; contours make the pattern symbols readable.
const backCache = new Map<string, HTMLCanvasElement | null>()

async function giftBackdrop(slug: string, w: number, h: number): Promise<HTMLCanvasElement | null> {
  const key = `${slug}|${w}x${h}`
  if (backCache.has(key)) return backCache.get(key)!
  let out: HTMLCanvasElement | null = null
  try {
    const r = await fetch(`${API}/gift?slug=${encodeURIComponent(slug)}`)
    if (r.ok) {
      const bmp = await createImageBitmap(await r.blob())
      const c = document.createElement('canvas'); c.width = w; c.height = h
      const ctx = c.getContext('2d')!
      const k = Math.max(w / bmp.width, h / bmp.height)          // cover, centered
      const dw = Math.round(bmp.width * k), dh = Math.round(bmp.height * k)
      let src: CanvasImageSource = bmp, sw = bmp.width, sh = bmp.height
      while (sw / 2 > dw) {                                       // shrink in halves — sharper symbols
        const t = document.createElement('canvas'); t.width = Math.round(sw / 2); t.height = Math.round(sh / 2)
        const tc = t.getContext('2d')!; tc.imageSmoothingQuality = 'high'; tc.drawImage(src, 0, 0, t.width, t.height)
        src = t; sw = t.width; sh = t.height
      }
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(src, Math.round((w - dw) / 2), Math.round((h - dh) / 2), dw, dh)
      const img = ctx.getImageData(0, 0, w, h)
      const d = img.data, N = w * h
      const lum = new Float32Array(N)
      let mn = 255, mx = 0
      for (let p = 0; p < N; p++) {
        const i = p * 4
        lum[p] = 0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2]
        if (lum[p] < mn) mn = lum[p]; if (lum[p] > mx) mx = lum[p]
      }
      const span = Math.max(12, mx - mn)
      const cxm = w / 2, cym = h / 2, rmax = Math.hypot(cxm, cym)
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const p = y * w + x, i = p * 4
        const t = (lum[p] - mn) / span
        let e = 0
        if (x > 0 && y > 0 && x < w - 1 && y < h - 1) {
          const L = lum
          const gx = L[p - w + 1] + 2 * L[p + 1] + L[p + w + 1] - L[p - w - 1] - 2 * L[p - 1] - L[p + w - 1]
          const gy = L[p + w - 1] + 2 * L[p + w] + L[p + w + 1] - L[p - w - 1] - 2 * L[p - w] - L[p - w + 1]
          e = Math.min(1, Math.hypot(gx, gy) / span * 0.8)
        }
        const dist = Math.hypot(x - cxm, y - cym)
        const glow = 1 - 0.55 * (dist / rmax)                          // radial backdrop gradient, lighter in the middle
        e *= Math.min(1, Math.max(0, (dist - h * 0.42) / (h * 0.12)))  // no contours under our model (no ghost outline)
        const v = (2 + 14 * t * glow) + 26 * e                          // lens: ~0–35 % brightness, symbols' edges brighter
        d[i] = d[i + 1] = d[i + 2] = Math.min(44, v); d[i + 3] = 255
      }
      ctx.putImageData(img, 0, 0)
      out = c
    }
  } catch { out = null }
  backCache.set(key, out)
  if (backCache.size > 40) backCache.delete(backCache.keys().next().value!)
  return out
}

// ---------- drawing (TeleGift app style, grayscale) ----------
const FONT = '-apple-system, "SF Pro Text", "Helvetica Neue", system-ui, sans-serif'
// The lens brightens dark grays a lot (measured in the simulator: 12 → 38 %, 32 → 51 %, 64 → 70 %, 128 → 96 %),
// so "dim" colors here are very dark, fills are black and shapes are drawn with thin lines.
const C = { text: '#ffffff', dim: '#383838', faint: '#161616', line: '#1e1e1e', media: '#000000', card: '#000000' }

function rrect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath(); ctx.roundRect(x, y, w, h, r)
}
function pill(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, font: string, fill: string, color: string, right = false) {
  ctx.font = font
  const w = ctx.measureText(text).width + 14
  const px = right ? x - w : x
  rrect(ctx, px, y, w, 20, 10); ctx.fillStyle = fill; ctx.fill(); ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.stroke()
  ctx.fillStyle = color; ctx.textBaseline = 'middle'; ctx.fillText(text, px + 7, y + 10.5)
  return w
}
// ---------- nice gift numbers (same rules as TeleFeed: web/app.js niceNumber) ----------
function niceNumber(n: number): string | null {
  const s = String(n), len = s.length
  const run = () => { let up = true, down = true; for (let i = 1; i < len; i++) { const k = s.charCodeAt(i) - s.charCodeAt(i - 1); if (k !== 1) up = false; if (k !== -1) down = false } return up || down }
  if (n <= 100) return 'under 100'
  if (len >= 3 && /^(\d)\1+$/.test(s)) return 'same digits'
  if (len >= 3 && /^[1-9]0+$/.test(s)) return 'round'
  if (n >= 1985 && n <= 2028) return 'a year'
  if (len >= 4 && s === [...s].reverse().join('')) return 'mirror'
  if (len >= 4 && run()) return 'in order'
  if (len >= 4 && len % 2 === 0 && s.slice(0, len / 2) === s.slice(len / 2)) return 'repeat'
  if (/(\d)\1{3,}/.test(s)) return '4 in a row'
  if (len >= 5 && /^[1-9]0{3,}\d?$|^\d0{4,}$/.test(s)) return 'almost round'
  for (const p of ['5201314', '1314', '1688', '168', '518', '520'])      // Chinese lucky: 8 wealth, 6 smooth, 9 long life
    if (s === p || (len > p.length && (s.startsWith(p) ? !s.slice(p.length).includes('4') : s.endsWith(p) && !s.slice(0, -p.length).includes('4')))) return 'lucky'
  if (s.includes('4')) return null
  if (len >= 2 && /^[689]+$/.test(s)) return 'lucky'
  if (len >= 3 && /^[15][689]+$/.test(s)) return 'lucky'
  if ((s.match(/8/g) || []).length >= 3) return 'lucky'
  return null
}

// "Title #num" on one line; a nice number is drawn inverted in a pill with a star, its reason in small letters after it
function titleLine(ctx: CanvasRenderingContext2D, d: Deal, x: number, y: number, max: number, font: string, numFont: string) {
  const nice = niceNumber(d.num)
  ctx.textBaseline = 'alphabetic'
  ctx.font = numFont
  const num = nice ? `★ #${d.num}` : ` #${d.num}`
  const numW = ctx.measureText(num).width + (nice ? 14 : 0)
  ctx.font = font
  const name = fit(ctx, d.title, Math.max(40, max - numW - (nice ? 10 : 0)))
  ctx.fillText(name, x, y)
  let nx = x + ctx.measureText(name).width + (nice ? 8 : 0)
  ctx.font = numFont
  if (!nice) { ctx.fillText(num, nx, y); return }
  const m = ctx.measureText(num), h = Math.round((m.actualBoundingBoxAscent || 12) + 8)
  rrect(ctx, nx, y - h + 4, numW, h, h / 2); ctx.fillStyle = '#fff'; ctx.fill()
  ctx.fillStyle = '#000'; ctx.fillText(num, nx + 7, y)
  nx += numW + 6
  ctx.font = `600 11px ${FONT}`; ctx.fillStyle = C.dim
  if (nx + ctx.measureText(nice).width <= x + max) ctx.fillText(nice, nx, y - 1)
}

function fit(ctx: CanvasRenderingContext2D, text: string, max: number) {
  if (ctx.measureText(text).width <= max) return text
  while (text.length > 1 && ctx.measureText(text + '…').width > max) text = text.slice(0, -1)
  return text + '…'
}
const money = (v: number) => (v < 100 ? v.toFixed(2).replace(/\.00$/, '') : String(Math.round(v)))
const xs = (x: number) => x.toFixed(2).replace(/\.?0+$/, '')   // 2.00 → 2, 2.10 → 2.1, 2.22 → 2.22
const STAR_USD = 0.015                   // what a Star costs to buy (owner 27.11)
const usd = (v: number | null) => (v == null ? '' : `≈ $${v < 100 ? v.toFixed(2).replace(/\.00$/, '') : Math.round(v)}`)
// GRAM: at most 2 decimals
const priceText = (d: Deal) => (d.cur === 'STARS' ? `${num(d.price)} ★` : `${d.price < 100 ? +d.price.toFixed(2) : Math.round(d.price)} GRAM`)

function header(ctx: CanvasRenderingContext2D, right: string) {
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = C.text; ctx.font = `800 19px ${FONT}`
  ctx.fillText('TELEGIFT', 10, 24)
  ctx.font = `500 13px ${FONT}`; ctx.fillStyle = C.dim
  const w = ctx.measureText(right).width
  ctx.fillText(right, W - 12 - w, 23)
  ctx.fillStyle = C.line; ctx.fillRect(10, 33, W - 20, 1)
}

function drawDeal(ctx: CanvasRenderingContext2D, d: Deal, pic: HTMLCanvasElement | null, back: HTMLCanvasElement | null, pos: string) {
  header(ctx, pos)
  const hot = d.id === hotId && Date.now() < hotUntil
  // ---- gift card (like a card in the Live feed) ----
  const cx = 10, cy = 42, cw = 214, ch = 206
  rrect(ctx, cx, cy, cw, ch, 14); ctx.fillStyle = C.card; ctx.fill()
  ctx.strokeStyle = hot && Math.floor(Date.now() / 500) % 2 ? '#fff' : C.line; ctx.lineWidth = hot ? 3 : 1; ctx.stroke()

  const mh = 128
  ctx.save(); rrect(ctx, cx + 1, cy + 1, cw - 2, mh, 13); ctx.clip()
  ctx.fillStyle = C.media; ctx.fillRect(cx, cy, cw, mh + 2)
  if (back) ctx.drawImage(back, cx + 1, cy + 1)
  if (pic) ctx.drawImage(pic, Math.round(cx + (cw - MODEL_PX) / 2), Math.round(cy + (mh - MODEL_PX) / 2 + 3))   // 1:1, no blur
  ctx.restore()
  // backdrop and pattern names on the picture
  pill(ctx, cx + 7, cy + mh - 26, `◐ ${d.backdrop}`, `600 10px ${FONT}`, '#000', C.text)
  if (d.pattern) pill(ctx, cx + cw - 7, cy + mh - 26, `✦ ${d.pattern}`, `600 10px ${FONT}`, '#000', C.text, true)
  ctx.fillStyle = C.faint; ctx.fillRect(cx + 1, cy + mh + 1, cw - 2, 1)
  pill(ctx, cx + 7, cy + 7, MARKET[d.market] || d.market, `700 11px ${FONT}`, '#000', C.text)
  pill(ctx, cx + cw - 7, cy + 7, `↗ ${xs(d.x)}×`, `800 12px ${FONT}`, '#000', '#fff', true)
  ctx.textBaseline = 'alphabetic'
  let y = cy + mh + 22
  ctx.fillStyle = C.text
  titleLine(ctx, d, cx + 10, y, cw - 20, `700 15px ${FONT}`, `600 14px ${FONT}`)
  y += 18
  ctx.font = `500 12px ${FONT}`; ctx.fillStyle = C.dim
  ctx.fillText(fit(ctx, `${d.model} · ${d.backdrop}`, cw - 20), cx + 10, y)
  y += 26
  ctx.font = `800 17px ${FONT}`; ctx.fillStyle = C.text
  const pt = priceText(d); ctx.fillText(pt, cx + 10, y)
  const pw = ctx.measureText(pt).width
  ctx.font = `600 12px ${FONT}`; ctx.fillStyle = C.dim; ctx.fillText(` ${usd(d.usd)}`, cx + 12 + pw, y)

  // ---- why it is a deal (right side) ----
  const rx = 242
  const rs = d.resell && d.resell.profit_usd > 0.5 ? d.resell : null
  ctx.textBaseline = 'alphabetic'
  if (rs) {
    // the money hook: what you could make if you resell at the usual price (estimate, after the 20 % fee)
    ctx.font = `600 12px ${FONT}`; ctx.fillStyle = C.dim; ctx.fillText('RESELL ESTIMATE', rx, 62)
    ctx.font = `800 46px ${FONT}`; ctx.fillStyle = '#fff'
    ctx.fillText(`+$${money(rs.profit_usd)}`, rx - 2, 108)
    ctx.font = `500 13px ${FONT}`; ctx.fillStyle = C.dim
    ctx.fillText(fit(ctx, `sell ~${num(rs.sell)} ★ → you get ~$${money(rs.get_usd)} (−20%)`, W - rx - 12), rx, 128)
  } else {
    ctx.font = `600 12px ${FONT}`; ctx.fillStyle = C.dim; ctx.fillText('UNDERPRICED', rx, 62)
    ctx.font = `800 46px ${FONT}`; ctx.fillStyle = '#fff'
    ctx.fillText(`↗ ${xs(d.x)}×`, rx - 2, 108)
    ctx.font = `500 13px ${FONT}`; ctx.fillStyle = C.dim; ctx.fillText('vs the top sale of this model + backdrop', rx, 128)
  }
  ctx.fillStyle = C.line; ctx.fillRect(rx, 142, W - rx - 12, 1)
  const usual: [string, string] = d.floor ? ['Floor', `${num(d.floor)} ★`]
    : d.cheapest ? ['Floor', 'cheapest on sale']
    : d.typical ? ['Usual', `${num(Math.round(d.typical))} ★` + (d.sales ? ` · ${d.sales} sales` : '')] : ['Floor', 'no other listings']
  const rows: [string, string][] = [
    rs ? ['Deal', `↗ ${xs(d.x)}× vs top sale`] : ['Sales', d.sales ? `${d.sales} of this model + backdrop` : '—'],
    usual,
    ['Listed', `${ago(liveAge(d))} · ${MARKET[d.market] || d.market}`],
  ]
  let ry = 164
  for (const [k, v] of rows) {
    ctx.font = `500 13px ${FONT}`; ctx.fillStyle = C.dim; ctx.fillText(k, rx, ry)
    ctx.font = `600 14px ${FONT}`; ctx.fillStyle = C.text; ctx.fillText(fit(ctx, v, W - rx - 82), rx + 64, ry)
    ry += 22
  }
  // button like "Buy" in the app
  const label = d.sold ? 'Tap — next deal' : token ? 'Tap — send to Telegram' : 'Tap — link Telegram'
  ctx.font = `700 14px ${FONT}`
  const bw = ctx.measureText(label).width + 28
  rrect(ctx, rx, 222, bw, 26, 13); ctx.fillStyle = '#e8e8e8'; ctx.fill()
  ctx.fillStyle = '#000'; ctx.textBaseline = 'middle'; ctx.fillText(label, rx + 14, 235.5); ctx.textBaseline = 'alphabetic'
  if (hot) {                                          // a very strong deal just arrived — badge in the header
    ctx.font = `900 14px ${FONT}`
    const t = 'HOT DEAL'
    const w = ctx.measureText(t).width + 22
    rrect(ctx, (W - w) / 2, 6, w, 22, 11); ctx.fillStyle = '#fff'; ctx.fill()
    ctx.fillStyle = '#000'; ctx.textBaseline = 'middle'; ctx.fillText(t, (W - w) / 2 + 11, 17.5); ctx.textBaseline = 'alphabetic'
  }
  if (d.sold) {                                       // someone was faster — stamp it
    ctx.save()
    rrect(ctx, cx + 1, cy + 1, cw - 2, ch - 2, 13); ctx.fillStyle = '#000'; ctx.fill()
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.save()
    ctx.translate(cx + cw / 2, cy + 74); ctx.rotate(-0.16)
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 3
    rrect(ctx, -74, -27, 148, 54, 8); ctx.stroke()
    ctx.fillStyle = '#fff'; ctx.font = `900 36px ${FONT}`; ctx.fillText('SOLD', 0, 2)
    ctx.restore()
    ctx.font = `700 14px ${FONT}`; ctx.fillStyle = C.text
    ctx.fillText(fit(ctx, `${d.title} #${d.num}`, cw - 20), cx + cw / 2, cy + 142)
    ctx.font = `500 13px ${FONT}`; ctx.fillStyle = C.dim
    ctx.fillText('someone was faster', cx + cw / 2, cy + 164)
    ctx.fillText('next deal in a moment…', cx + cw / 2, cy + 184)
    ctx.restore()
  }
}

const comboKey = (d: Deal) => `${d.title}|${d.model}|${d.backdrop}`

// ---------- full gift info (the app's "Full gift info" window, on the lens) ----------
// tap on a deal → 3 pages, one tap each: GIFT (picture, price, floors, rarity, supply) → SALES (history of this
// model + backdrop on every marketplace) → ON SALE (the same gifts on sale now, by price, with this lot in place) → back.
// Up / down scroll the lists, 2× tap — straight back to the feed, hold — send to Telegram.
type Sale = { at: number; market: string; cur: 'STARS' | 'GRAM'; price: number; usd: number | null; num: number | null; mine: boolean; pattern?: string | null }
type Hist = { items: Sale[]; week: number; total: number; usual_usd: number | null
  top: { usd: number | null; cur: string; price: number; at: number } | null; top_stars: { price: number; usd: number; at: number } | null }
type Lot = { market: string; num: number | null; pattern?: string | null; cur: 'STARS' | 'GRAM'; price: number; usd: number; listed_at?: number }
type Floor = { market: string; cur: 'STARS' | 'GRAM'; price: number; usd?: number | null } | null
type Full = { floor_col: Floor; floor_model: Floor; floor_backdrop?: Floor; issued: number | null; supply: number | null; n_model: number | null
  n_combo: number | null; history: Hist; on_sale: Lot[]; on_sale_wait: boolean }
const fullCache = new Map<string, { at: number; v: Full | 'loading' | 'error' }>()
const PAGES = ['GIFT', 'SALES', 'ON SALE']
let fpage = 0, fscroll = 0
// tap on the last page (ON SALE) asks where to go (owner 27.11): 0 — from the start (GIFT), 1 — back to the feed
let endMenu: 0 | 1 | null = null
const END_ITEMS = ['↺  From the start  ·  GIFT', '←  Back to the feed']
function drawEndMenu(ctx: CanvasRenderingContext2D) {
  const w = 330, h = 116, x = (W - w) / 2, y = 70
  rrect(ctx, x, y, w, h, 14); ctx.fillStyle = '#000'; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke()
  ctx.textBaseline = 'middle'
  END_ITEMS.forEach((t, i) => {
    const ry = y + 14 + i * 46
    if (i === endMenu) { rrect(ctx, x + 12, ry, w - 24, 38, 10); ctx.fillStyle = '#fff'; ctx.fill(); ctx.fillStyle = '#000' }
    else ctx.fillStyle = G_MID
    ctx.font = `700 17px ${FONT}`; ctx.fillText(t, x + 26, ry + 20)
  })
  ctx.textBaseline = 'alphabetic'
}
const ROWS = 7

async function loadFull(d: Deal) {
  const k = d.id
  const have = fullCache.get(k)
  if (have && have.v !== 'error' && (have.v === 'loading' || Date.now() - have.at < 60_000)) return
  fullCache.set(k, { at: Date.now(), v: have && have.v !== 'loading' && have.v !== 'error' ? have.v : 'loading' })
  const q = new URLSearchParams({ c: d.title, m: d.model, b: d.backdrop, slug: d.id, stars: String(d.stars || ''),
    mr: d.mr || '', br: d.br || '' })
  try {
    const r = await fetch(`${API}/full?${q}`)
    fullCache.set(k, { at: Date.now(), v: r.ok ? await r.json() as Full : 'error' })
  } catch { fullCache.set(k, { at: Date.now(), v: 'error' }) }
  if (view === 'history' && deals[idx]?.id === d.id) paint()
}

const pad2 = (n: number) => String(n).padStart(2, '0')
function when(ts: number) {
  const t = new Date(ts * 1000), now = new Date()
  const hm = `${pad2(t.getHours())}:${pad2(t.getMinutes())}`
  if (t.toDateString() === now.toDateString()) return `today ${hm}`
  const y = new Date(now.getTime() - 86400000)
  if (t.toDateString() === y.toDateString()) return `yesterday ${hm}`
  return `${pad2(t.getDate())}.${pad2(t.getMonth() + 1)}${t.getFullYear() !== now.getFullYear() ? '.' + String(t.getFullYear()).slice(2) : ''} ${hm}`
}
const day = (ts: number) => { const t = new Date(ts * 1000); return `${pad2(t.getDate())}.${pad2(t.getMonth() + 1)}.${String(t.getFullYear()).slice(2)}` }
const histPrice = (cur: string, p: number) => (cur === 'STARS' ? `${num(p)} ★` : `${p < 100 ? +p.toFixed(2) : Math.round(p)} GRAM`)
const floorText = (f: Floor) => (f ? `↓ ${histPrice(f.cur, f.price)} · ${MARKET[f.market] || f.market}` : '')
function age(ts?: number) {
  if (!ts) return '—'
  const s = Math.max(0, Date.now() / 1000 - ts)
  if (s > 60 * 86400) return '—'                 // the marketplace's date is only a guess that old
  return s < 3600 ? `${Math.max(1, Math.round(s / 60))} min` : s < 86400 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} d`
}

// the page tabs in the header: GIFT · SALES · ON SALE, the current one inverted
function fullHeader(ctx: CanvasRenderingContext2D, d: Deal) {
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = C.text; ctx.font = `800 17px ${FONT}`; ctx.fillText('TELEGIFT', 10, 23)
  let x = W - 12
  ctx.font = `700 12px ${FONT}`
  for (let i = PAGES.length - 1; i >= 0; i--) {
    const t = PAGES[i], w = ctx.measureText(t).width + 16
    x -= w
    if (i === fpage) { rrect(ctx, x, 8, w, 20, 10); ctx.fillStyle = '#fff'; ctx.fill(); ctx.fillStyle = '#000' }
    else ctx.fillStyle = C.dim
    ctx.fillText(t, x + 8, 22)
    x -= 6
  }
  ctx.font = `600 13px ${FONT}`; ctx.fillStyle = C.dim
  ctx.fillText(fit(ctx, `${d.title} #${d.num}`, x - 120), 112, 23)
  ctx.fillStyle = C.line; ctx.fillRect(10, 33, W - 20, 1)
}

function loadingText(ctx: CanvasRenderingContext2D, v: unknown) {
  ctx.font = `600 18px ${FONT}`; ctx.fillStyle = C.text
  ctx.fillText(v === 'error' ? 'No connection to the data' : 'Loading…', 250, 130)
}

// page 1 — GIFT: big (animated) model, price, floors, rarity and how many such gifts exist
function drawInfo(ctx: CanvasRenderingContext2D, d: Deal, f: Full | 'loading' | 'error' | undefined, pic: HTMLCanvasElement | null) {
  fullHeader(ctx, d)
  if (pic) ctx.drawImage(pic, 6, 38)
  const x = 236, mw = W - x - 12
  ctx.fillStyle = C.text
  titleLine(ctx, d, x, 62, mw, `800 22px ${FONT}`, `800 20px ${FONT}`)
  ctx.font = `800 21px ${FONT}`; ctx.fillStyle = '#fff'
  const pt = priceText(d); ctx.fillText(pt, x, 90)
  let px = x + ctx.measureText(pt).width + 10
  ctx.font = `600 14px ${FONT}`; ctx.fillStyle = C.dim
  const alt = [usd(d.usd), d.cur === 'STARS' && d.usd ? '' : ''].filter(Boolean).join(' ')
  ctx.fillText(fit(ctx, alt, W - px - 12), px, 90)
  const F = f && f !== 'loading' && f !== 'error' ? f : null
  // collection line: floor of the whole collection + supply
  ctx.font = `600 13px ${FONT}`; ctx.fillStyle = C.dim
  const col = [F?.floor_col ? `collection ${floorText(F.floor_col)}` : 'collection …',
    F?.issued ? `${num(F.issued)}${F.supply ? ' / ' + num(F.supply) : ''}` : ''].filter(Boolean).join('   ')
  ctx.fillText(fit(ctx, col, mw), x, 112)
  // attributes: name, rarity, how many exist, floor of the model
  const rows: [string, string, string, string][] = [
    ['Model', d.model, d.mr || '', [F?.n_model ? `${num(F.n_model)} pcs` : '', F?.floor_model ? floorText(F.floor_model) : ''].filter(Boolean).join('  ')],
    ['Backdrop', d.backdrop, d.br || '', F?.n_combo ? `${num(F.n_combo)} pcs with this model` : ''],
    ['Pattern', d.pattern || '—', d.pr || '', ''],
  ]
  let y = 140
  for (const [k, v, r, extra] of rows) {
    ctx.font = `500 13px ${FONT}`; ctx.fillStyle = C.dim; ctx.fillText(k, x, y)
    ctx.font = `700 15px ${FONT}`; ctx.fillStyle = C.text
    const vv = fit(ctx, v, 150); ctx.fillText(vv, x + 66, y)
    let ax = x + 66 + ctx.measureText(vv).width + 6
    ctx.font = `600 12px ${FONT}`; ctx.fillStyle = C.dim
    if (r) { ctx.fillText(r, ax, y); ax += ctx.measureText(r).width + 10 }
    if (extra) { ctx.font = `700 12px ${FONT}`; ctx.fillStyle = C.text; ctx.fillText(fit(ctx, extra, W - ax - 12), ax, y) }
    y += 24
  }
  // the verdict line
  const below = d.fair && d.stars && d.stars < d.fair ? Math.round((1 - d.stars / d.fair) * 100) : 0
  const v: string[] = [`↗ ${xs(d.x)}× vs top sale`]
  if (below >= 5) v.push(`${below}% below market`)
  if (F) {
    const cheaper = F.on_sale.filter((l) => d.usd && l.usd < d.usd).length
    v.push(cheaper ? `${cheaper} cheaper on sale` : 'cheapest on sale')
  }
  ctx.font = `700 14px ${FONT}`; ctx.fillStyle = C.text
  ctx.fillText(fit(ctx, v.join('  ·  '), mw), x, 236)
}

// Short tables (owner 27.11): the most telling rows stay, runs of similar prices fold into one row "×N".
// SALES: neighbours within ±7 % fold; this gift's own sales, expensive ones (≥1.75× floor), the max and the min never fold;
// at most 14 rows (two screens) — the must-keep ones plus the freshest. ON SALE: neighbours within ±3 % fold, this lot never;
// everything cheaper than this lot is kept, plus 6 rows after it.
type SaleRow = Sale & { n: number; nums: Set<number>; markets: Set<string>; over: number }
type LotRow = Lot & { me?: boolean; n: number; markets: Set<string> }
const SALE_SIM = 0.07, LOT_SIM = 0.03, SALE_MAX = 14, LOTS_AFTER = 6
const DARK_BACKDROPS = ['Black', 'Onyx Black', 'Midnight Blue', 'Gunmetal']
const rowsMemo = new WeakMap<Full, { sales: SaleRow[]; lots: LotRow[]; key: string }>()
function similar(a: { usd: number | null; price: number; cur: string }, b: { usd: number | null; price: number; cur: string }, tol: number) {
  if (a.usd == null || b.usd == null) { if (a.cur !== b.cur) return false; return Math.abs(a.price - b.price) <= tol * Math.max(a.price, b.price) }
  return Math.abs(a.usd - b.usd) <= tol * Math.max(a.usd, b.usd)
}
function tableRows(d: Deal, f: Full) {
  const key = `${d.id}|${d.usd}`
  const m = rowsMemo.get(f)
  if (m && m.key === key) return m
  // sales
  const fUsd = (DARK_BACKDROPS.includes(d.backdrop) && f.floor_backdrop?.usd) || f.floor_model?.usd || null
  const items = f.history.items
  const withUsd = items.filter((i) => i.usd != null)
  const maxI = withUsd.length ? withUsd.reduce((a, b) => (b.usd! > a.usd! ? b : a)) : null
  const minI = withUsd.length ? withUsd.reduce((a, b) => (b.usd! < a.usd! ? b : a)) : null
  const keep = (i: Sale, over: number) => i.mine || over > 0 || i === maxI || i === minI
  const sales: (SaleRow & { must: boolean })[] = []
  for (const it of items) {
    const over = fUsd && it.usd && it.usd >= fUsd * 1.75 ? it.usd / fUsd : 0
    const last = sales[sales.length - 1]
    if (last && !last.must && !keep(it, over) && similar(last, it, SALE_SIM)) {
      last.n++; if (it.num) last.nums.add(it.num); last.markets.add(it.market); continue
    }
    sales.push({ ...it, n: 1, nums: new Set(it.num ? [it.num] : []), markets: new Set([it.market]), over, must: keep(it, over) })
  }
  let shown = sales
  if (sales.length > SALE_MAX) {
    const must = sales.filter((r) => r.must)
    const rest = sales.filter((r) => !r.must).slice(0, Math.max(0, SALE_MAX - must.length))
    const pick = new Set([...must, ...rest])
    shown = sales.filter((r) => pick.has(r))
  }
  // lots on sale, this lot in its place
  const cheaper = f.on_sale.filter((l) => d.usd && l.usd < d.usd).length
  const raw: (Lot & { me?: boolean })[] = f.on_sale.map((l) => ({ ...l }))
  if (d.usd) raw.splice(cheaper, 0, { market: d.market, num: d.num, pattern: d.pattern, cur: d.cur, price: d.price, usd: d.usd, me: true })
  const lots: LotRow[] = []
  let meAt = -1
  for (const l of raw) {
    const last = lots[lots.length - 1]
    if (last && !last.me && !l.me && similar(last, l, LOT_SIM)) {
      last.n++; last.markets.add(l.market)
      if (l.listed_at && (!last.listed_at || l.listed_at > last.listed_at)) last.listed_at = l.listed_at
      continue
    }
    if (l.me) meAt = lots.length
    lots.push({ ...l, n: 1, markets: new Set([l.market]) })
  }
  const cut = meAt >= 0 ? lots.slice(0, meAt + 1 + LOTS_AFTER) : lots.slice(0, SALE_MAX)
  const out = { sales: shown, lots: cut, key }
  rowsMemo.set(f, out)
  return out
}

// page 2 — SALES: the "Maximum" and "Sales" tiles, then the table (this gift's own sales highlighted)
function drawSales(ctx: CanvasRenderingContext2D, d: Deal, f: Full | 'loading' | 'error' | undefined) {
  fullHeader(ctx, d)
  if (!f || f === 'loading' || f === 'error') { loadingText(ctx, f); return }
  const h = f.history
  ctx.textBaseline = 'alphabetic'
  // tiles
  ctx.strokeStyle = C.line; ctx.lineWidth = 1
  rrect(ctx, 10.5, 40.5, 300, 40, 8); ctx.stroke()
  rrect(ctx, 318.5, 40.5, 120, 40, 8); ctx.stroke()
  rrect(ctx, 446.5, 40.5, W - 457, 40, 8); ctx.stroke()
  ctx.font = `600 11px ${FONT}`; ctx.fillStyle = C.dim
  ctx.fillText('MAXIMUM', 20, 55); ctx.fillText('SALES', 328, 55); ctx.fillText('THIS LOT', 456, 55)
  if (h.top) {
    ctx.font = `800 17px ${FONT}`; ctx.fillStyle = '#fff'
    const t = histPrice(h.top.cur, h.top.price); ctx.fillText(t, 20, 74)
    let tx = 20 + ctx.measureText(t).width + 8
    ctx.font = `600 12px ${FONT}`; ctx.fillStyle = C.dim
    const sub = `${h.top.usd ? '≈$' + money(h.top.usd) + ' · ' : ''}${day(h.top.at)}` +
      (h.top.cur !== 'STARS' && h.top_stars ? `   for ★ ${num(h.top_stars.price)}` : '')
    ctx.fillText(fit(ctx, sub, 300 - tx), tx, 74)
  }
  ctx.font = `800 17px ${FONT}`; ctx.fillStyle = '#fff'; ctx.fillText(num(h.total), 328, 74)
  ctx.font = `600 12px ${FONT}`; ctx.fillStyle = C.dim
  ctx.fillText(`${h.week}/wk`, 328 + ctx.measureText(num(h.total)).width * 1.45 + 8, 74)
  ctx.font = `800 17px ${FONT}`; ctx.fillStyle = '#fff'; ctx.fillText(d.usd ? `$${money(d.usd)}` : '—', 456, 74)
  if (!h.items.length) {
    ctx.font = `600 16px ${FONT}`; ctx.fillStyle = C.text
    ctx.fillText('No sales of this model + backdrop yet — a rare combination', 12, 130)
    return
  }
  // expensive sales, as in the app: 1.75× the model's floor in $ or more (dark backdrops — the floor of that backdrop)
  const list = tableRows(d, f).sales
  fscroll = Math.max(0, Math.min(fscroll, list.length - ROWS))
  let y = 104
  for (const it of list.slice(fscroll, fscroll + ROWS)) {
    ctx.font = `500 13px ${FONT}`; ctx.fillStyle = C.dim; ctx.fillText(when(it.at), 12, y)
    const over = it.over
    ctx.font = `800 15px ${FONT}`
    const pt = histPrice(it.cur, it.price)
    if (over) {                                       // inverted price + "×N floor"
      const pw = ctx.measureText(pt).width
      rrect(ctx, 134, y - 15, pw + 12, 20, 6); ctx.fillStyle = '#fff'; ctx.fill(); ctx.fillStyle = '#000'
    } else ctx.fillStyle = C.text
    ctx.fillText(pt, 140, y)
    ctx.font = `500 12px ${FONT}`; ctx.fillStyle = C.dim
    if (it.usd) ctx.fillText(`$${money(it.usd)}`, 250, y)
    if (over) { ctx.font = `800 12px ${FONT}`; ctx.fillStyle = '#fff'; ctx.fillText(`${xs(over)}×fl`, 300, y) }
    else if (it.n > 1) { ctx.font = `700 12px ${FONT}`; ctx.fillStyle = G_MID; ctx.fillText(`×${it.n}`, 304, y) }   // folded similar sales
    ctx.font = `600 12px ${FONT}`; ctx.fillStyle = C.text
    ctx.fillText(it.markets.size > 1 ? `${MARKET[it.market] || it.market} +${it.markets.size - 1}` : MARKET[it.market] || it.market, 350, y)
    if (it.n > 1 && it.nums.size > 1) { ctx.font = `500 12px ${FONT}`; ctx.fillStyle = C.dim; ctx.fillText(`${it.nums.size} gifts`, 430, y) }
    else if (it.num) {
      const t = `#${it.num}`
      ctx.font = `600 13px ${FONT}`
      const tw = ctx.measureText(t).width
      if (it.mine) { rrect(ctx, 424, y - 13, tw + 12, 18, 9); ctx.fillStyle = '#fff'; ctx.fill(); ctx.fillStyle = '#000' }
      else ctx.fillStyle = C.dim
      ctx.fillText(t, 430, y)
    }
    ctx.font = `500 12px ${FONT}`; ctx.fillStyle = C.dim
    if (it.pattern) ctx.fillText(fit(ctx, it.pattern, W - 506 - 10), 506, y)
    y += 21.5
  }
  scrollBar(ctx, fscroll, list.length, 92, 246)
}

function scrollBar(ctx: CanvasRenderingContext2D, from: number, total: number, y0: number, y1: number) {
  if (total <= ROWS) return
  const h = Math.max(14, ((y1 - y0) * ROWS) / total), y = y0 + ((y1 - y0 - h) * from) / Math.max(1, total - ROWS)
  ctx.fillStyle = C.line; ctx.fillRect(W - 4, y0, 2, y1 - y0)
  ctx.fillStyle = '#fff'; ctx.fillRect(W - 5, y, 4, h)
}

// page 3 — ON SALE: the same model + backdrop on every marketplace, by price in $, with this lot in its place
function drawOnSale(ctx: CanvasRenderingContext2D, d: Deal, f: Full | 'loading' | 'error' | undefined) {
  fullHeader(ctx, d)
  if (!f || f === 'loading' || f === 'error') { loadingText(ctx, f); return }
  ctx.textBaseline = 'alphabetic'
  const lots = f.on_sale
  const cheaper = lots.filter((l) => d.usd && l.usd < d.usd).length
  const by = new Map<string, number>()
  for (const l of lots) by.set(l.market, (by.get(l.market) || 0) + 1)
  ctx.font = `700 15px ${FONT}`; ctx.fillStyle = C.text
  ctx.fillText(cheaper ? `${cheaper} sold cheaper than this lot` : 'This lot is the cheapest', 12, 56)
  ctx.font = `500 12px ${FONT}`; ctx.fillStyle = C.dim
  const cnt = [...by].map(([m, n]) => `${MARKET[m] || m} ${n}`).join(' · ') || (f.on_sale_wait ? 'still asking the marketplaces…' : 'nobody else sells it now')
  ctx.fillText(fit(ctx, `${d.model} · ${d.backdrop}   ${cnt}`, W - 270), 262, 56)
  ctx.fillStyle = C.line; ctx.fillRect(10, 66, W - 20, 1)
  // rows, with "this lot" inserted at its place by price; similar prices folded
  const rows = tableRows(d, f).lots
  fscroll = Math.max(0, Math.min(fscroll, rows.length - ROWS))
  let y = 88
  for (const l of rows.slice(fscroll, fscroll + ROWS)) {
    if (l.me) { rrect(ctx, 6, y - 16, W - 14, 22, 6); ctx.fillStyle = '#fff'; ctx.fill() }
    const ink = l.me ? '#000' : C.text, dim = l.me ? '#000' : C.dim
    ctx.font = `700 12px ${FONT}`; ctx.fillStyle = ink
    ctx.fillText(l.markets.size > 1 ? `${MARKET[l.market] || l.market} +${l.markets.size - 1}` : MARKET[l.market] || l.market, 14, y)
    ctx.font = `600 13px ${FONT}`; ctx.fillStyle = dim
    ctx.fillText(l.me ? `this #${l.num}` : l.n > 1 ? `×${l.n} lots` : `#${l.num ?? '—'}`, 100, y)
    ctx.font = `500 12px ${FONT}`; ctx.fillText(fit(ctx, l.n > 1 ? 'similar price' : l.pattern || '', 120), 210, y)
    ctx.fillText(l.me ? 'now' : age(l.listed_at), 340, y)
    ctx.font = `800 15px ${FONT}`; ctx.fillStyle = l.me ? '#000' : '#fff'
    const pt = (l.n > 1 ? 'from ' : '') + histPrice(l.cur, l.price), pw = ctx.measureText(pt).width
    ctx.fillText(pt, 490 - pw, y)
    ctx.font = `500 12px ${FONT}`; ctx.fillStyle = dim; ctx.fillText(`$${money(l.usd)}`, 500, y)
    y += 23
  }
  if (!rows.length) { ctx.font = `600 15px ${FONT}`; ctx.fillStyle = C.text; ctx.fillText('No other lots of this model + backdrop on sale', 12, 110) }
  scrollBar(ctx, fscroll, rows.length, 74, 246)
}

async function loadDetail(d: Deal) {
  const k = comboKey(d)
  const have = detailCache.get(k)
  if (have && have !== 'error') return
  detailCache.set(k, 'loading')
  try {
    const r = await fetch(`${API}/detail?c=${encodeURIComponent(d.title)}&m=${encodeURIComponent(d.model)}&b=${encodeURIComponent(d.backdrop)}`)
    detailCache.set(k, r.ok ? await r.json() as Detail : 'error')
  } catch { detailCache.set(k, 'error') }
  if (view === 'detail') paint()
}

function drawDetail(ctx: CanvasRenderingContext2D, d: Deal, det: Detail | 'loading' | 'error' | undefined) {
  header(ctx, `${d.title} #${d.num}`)
  ctx.textBaseline = 'alphabetic'
  ctx.font = `600 12px ${FONT}`; ctx.fillStyle = C.dim
  ctx.fillText(fit(ctx, `${d.model} · ${d.backdrop} — sales, last 30 days`, 330), 12, 54)
  if (!det || det === 'loading' || det === 'error') {
    ctx.font = `600 18px ${FONT}`; ctx.fillStyle = C.text
    ctx.fillText(det === 'error' ? 'No connection to the sales data' : 'Loading sales…', 12, 120)
    return
  }
  // ---- chart: daily median price on Telegram Market, and this deal's price as a dashed line ----
  const X0 = 14, X1 = 330, Y0 = 70, Y1 = 214
  const pts = det.chart.map((c, i) => ({ i, v: c.usd })).filter((p) => p.v != null) as { i: number; v: number }[]
  const dealUsd = d.usd || 0
  const vals = pts.map((p) => p.v).concat(dealUsd ? [dealUsd] : [])
  ctx.strokeStyle = C.line; ctx.lineWidth = 1
  ctx.strokeRect(X0 + 0.5, Y0 + 0.5, X1 - X0, Y1 - Y0)
  if (pts.length >= 2) {
    const lo = Math.min(...vals) * 0.9, hi = Math.max(...vals) * 1.08
    const xOf = (i: number) => X0 + 6 + (i / (det.days - 1)) * (X1 - X0 - 12)
    const yOf = (v: number) => Y1 - 6 - ((v - lo) / (hi - lo || 1)) * (Y1 - Y0 - 12)
    // soft fill under the line
    ctx.beginPath(); ctx.moveTo(xOf(pts[0].i), Y1)
    for (const p of pts) ctx.lineTo(xOf(p.i), yOf(p.v))
    ctx.lineTo(xOf(pts[pts.length - 1].i), Y1); ctx.closePath()
    ctx.fillStyle = '#060606'; ctx.fill()                // the lens lifts dark grays: keep the fill almost black
    ctx.beginPath()
    pts.forEach((p, j) => (j ? ctx.lineTo(xOf(p.i), yOf(p.v)) : ctx.moveTo(xOf(p.i), yOf(p.v))))
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.stroke()
    for (const p of pts) { ctx.beginPath(); ctx.arc(xOf(p.i), yOf(p.v), 2.2, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill() }
    if (dealUsd) {
      const y = yOf(dealUsd)
      ctx.setLineDash([5, 4]); ctx.strokeStyle = C.text; ctx.lineWidth = 1.5
      ctx.beginPath(); ctx.moveTo(X0 + 2, y); ctx.lineTo(X1 - 2, y); ctx.stroke(); ctx.setLineDash([])
      ctx.font = `700 12px ${FONT}`
      const t = `this deal $${money(dealUsd)}`
      const w = ctx.measureText(t).width + 10
      ctx.fillStyle = '#000'; ctx.fillRect(X1 - w - 6, y - 9, w, 17)
      ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.fillText(t, X1 - w - 1, y); ctx.textBaseline = 'alphabetic'
    }
    ctx.font = `500 11px ${FONT}`; ctx.fillStyle = C.dim
    ctx.fillText(`$${money(Math.max(...pts.map((p) => p.v)))}`, X0 + 6, Y0 + 14)
    ctx.fillText(`${det.chart[0].day.slice(5)}`, X0 + 4, Y1 + 14)
    const last = det.chart[det.chart.length - 1].day.slice(5)
    ctx.fillText(last, X1 - ctx.measureText(last).width - 2, Y1 + 14)
    const total = det.chart.reduce((a, c) => a + c.n, 0)
    const mid = `${total} sales on Telegram Market`
    ctx.fillText(mid, (X0 + X1 - ctx.measureText(mid).width) / 2, Y1 + 14)
  } else {
    ctx.font = `600 14px ${FONT}`; ctx.fillStyle = C.text
    ctx.fillText('Too few Telegram Market sales', X0 + 14, (Y0 + Y1) / 2)
  }
  // ---- marketplaces: median sale price as bars ----
  const RX = 350
  ctx.font = `600 12px ${FONT}`; ctx.fillStyle = C.dim; ctx.fillText('MEDIAN SALE BY MARKETPLACE', RX, 54)
  const vs = det.venues.filter((v) => v.usd)
  const top = Math.max(1, ...vs.map((v) => v.usd as number))
  let y = 78
  for (const v of det.venues) {
    ctx.font = `600 13px ${FONT}`; ctx.fillStyle = v.usd ? C.text : C.dim
    ctx.fillText(v.name, RX, y)
    if (v.usd) {
      const bw = Math.max(6, ((v.usd as number) / top) * 112)
      rrect(ctx, RX + 66, y - 10, bw, 11, 3); ctx.fillStyle = '#fff'; ctx.fill()
      ctx.font = `700 12px ${FONT}`; ctx.fillStyle = C.text
      ctx.fillText(`$${money(v.usd as number)}`, RX + 72 + bw, y)
    } else {
      ctx.font = `500 12px ${FONT}`; ctx.fillStyle = C.dim; ctx.fillText('no sales', RX + 66, y)
    }
    y += 24
  }
  // watch button
  const on = watched.has(d.id)
  const label = on ? '✓ Watching' : token ? 'Tap — watch this deal' : 'Tap — link Telegram'
  ctx.font = `700 13px ${FONT}`
  const bw = ctx.measureText(label).width + 26
  rrect(ctx, RX, 222, bw, 26, 13)
  if (on) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke(); ctx.fillStyle = '#fff' } else { ctx.fillStyle = '#e8e8e8'; ctx.fill(); ctx.fillStyle = '#000' }
  ctx.textBaseline = 'middle'; ctx.fillText(label, RX + 13, 235.5); ctx.textBaseline = 'alphabetic'
}

// Glance type (owner 27.11, variants 2 + 4): three brightness levels — only the ×, the name and the price are bright;
// service lines are small caps with letter spacing, like an instrument panel. The lens brightens grays, hence dark values.
const G_MID = '#5c5c5c', G_DIM = '#262626'
function capsText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, max: number, font: string, color: string) {
  ctx.font = font; ctx.fillStyle = color
  const c = ctx as CanvasRenderingContext2D & { letterSpacing?: string }
  c.letterSpacing = '1.1px'
  ctx.fillText(fit(ctx, text.toUpperCase(), max), x, y)
  c.letterSpacing = '0px'
}
function drawGlance(ctx: CanvasRenderingContext2D, d: Deal, pic: HTMLCanvasElement | null, pos: string) {
  // one look is enough: the money, the gift, how fresh — everything else is one hold away
  const hot = d.id === hotId && Date.now() < hotUntil
  ctx.textBaseline = 'alphabetic'
  ctx.font = `800 14px ${FONT}`; ctx.fillStyle = C.dim; ctx.fillText('TELEGIFT', 12, 22)
  ctx.font = `500 12px ${FONT}`
  const pw = ctx.measureText(pos).width; ctx.fillText(pos, W - 12 - pw, 22)
  if (hot) {
    ctx.font = `900 14px ${FONT}`
    const t = 'HOT DEAL', w = ctx.measureText(t).width + 22
    rrect(ctx, (W - w) / 2, 6, w, 22, 11); ctx.fillStyle = '#fff'; ctx.fill()
    ctx.fillStyle = '#000'; ctx.textBaseline = 'middle'; ctx.fillText(t, (W - w) / 2 + 11, 17.5); ctx.textBaseline = 'alphabetic'
  }
  if (pic) ctx.drawImage(pic, 10, 28)
  const x = 240
  // Layout B (owner 27.11 «цена наверху»): dollars big on top → the price in its own currency · market · age →
  // name → model · backdrop → "↗ N×" with the money words in small caps → signals
  const rs = d.resell && d.resell.profit_usd > 0.5 ? d.resell : null
  // owner 27.11: on top the price as listed — in GRAM or Stars (the unit smaller); below it in dollars at today's
  // rates: Stars × $0.015, GRAM × the current GRAM rate (d.usd from the backend)
  const pt = priceText(d), sp = pt.lastIndexOf(' ')
  ctx.fillStyle = '#fff'; ctx.font = `800 56px ${FONT}`
  ctx.fillText(pt.slice(0, sp), x - 2, 90)
  const nw = ctx.measureText(pt.slice(0, sp)).width
  ctx.font = `800 ${d.cur === 'STARS' ? 40 : 26}px ${FONT}`; ctx.fillText(pt.slice(sp + 1), x - 2 + nw + 8, 90)
  const dollars = d.cur === 'STARS' ? d.price * STAR_USD : d.usd
  ctx.font = `600 17px ${FONT}`; ctx.fillStyle = G_MID
  ctx.fillText(fit(ctx, `${dollars != null ? usd(dollars) + '  ·  ' : ''}${MARKET[d.market] || d.market}  ·  ${ago(liveAge(d))}`, W - x - 12), x, 116)
  ctx.fillStyle = C.text
  titleLine(ctx, d, x, 153, W - x - 12, `700 23px ${FONT}`, `400 21px ${FONT}`)
  ctx.font = `400 15px ${FONT}`; ctx.fillStyle = G_MID
  ctx.fillText(fit(ctx, `${d.model} · ${d.backdrop}`, W - x - 12), x, 177)
  // the "×" and, after it in small caps, what you would make on a resale / how far below the usual price
  ctx.font = `800 23px ${FONT}`; ctx.fillStyle = '#fff'
  const xt = `↗ ${xs(d.x)}×`
  ctx.fillText(xt, x, 211)
  const xw = ctx.measureText(xt).width + 10
  const below = d.fair && d.stars && d.stars < d.fair ? Math.round((1 - d.stars / d.fair) * 100) : 0
  // the "×" is to the top clean sale of this model + backdrop — say so, with that price (owner 27.11; "usual" removed)
  // in dollars, the same way as the price on top (owner 27.11): × times this lot's dollar price
  const mk = d.max_mk ? ` · ${d.max_mk}` : ''                     // the marketplace of that top sale (owner 27.11)
  const maxUsd = dollars != null ? d.x * dollars : null
  const parts: string[] = [maxUsd != null ? `max sale $${maxUsd >= 10 ? Math.round(maxUsd) : money(maxUsd)}${mk}` : `to max sale${mk}`]
  if (below >= 5) parts.push(`${below}% below market`)
  if (rs) parts.push(`sell ~${num(rs.sell)} ★ → +${Math.round((rs.profit_usd / Math.max(0.01, rs.cost_usd)) * 100)}%`)
  if (parts.length) capsText(ctx, parts.join('  ·  '), x + xw, 210, W - x - xw - 12, `600 12px ${FONT}`, G_MID)
  // one quiet line of signals: competition and how such resales usually end
  const sig: string[] = []
  if (d.cheapest) sig.push('cheapest on sale')
  else if (d.floor) sig.push(`on sale from ${num(d.floor)} ★`)
  if (d.rs_good && d.rs_pct) sig.push(`★ ${Math.round(d.rs_pct * 100)}% of resales in profit`)
  else if (d.sales) sig.push(`${num(d.sales)} sales`)
  if (sig.length) capsText(ctx, sig.join('  ·  '), x, 242, W - x - 12, `600 11px ${FONT}`, G_DIM)
  if (d.sold) {
    ctx.fillStyle = '#000'; ctx.fillRect(0, 36, W, H - 36)
    ctx.save(); ctx.translate(W / 2, 120); ctx.rotate(-0.12)
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; rrect(ctx, -92, -32, 184, 64, 10); ctx.stroke()
    ctx.fillStyle = '#fff'; ctx.font = `900 44px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('SOLD', 0, 2)
    ctx.restore()
    ctx.font = `600 15px ${FONT}`; ctx.fillStyle = C.text; ctx.textAlign = 'center'
    ctx.fillText(`${d.title} #${d.num} — someone was faster`, W / 2, 196)
    ctx.fillStyle = C.dim; ctx.fillText('next deal in a moment…', W / 2, 220); ctx.textAlign = 'left'
  }
}

function drawMessage(ctx: CanvasRenderingContext2D, right: string, title: string, lines: string[], big?: string) {
  header(ctx, right)
  ctx.textBaseline = 'alphabetic'
  ctx.font = `700 20px ${FONT}`; ctx.fillStyle = C.text; ctx.fillText(title, 24, 76)
  let y = 108
  ctx.font = `500 15px ${FONT}`; ctx.fillStyle = C.dim
  for (const l of lines) { ctx.fillText(l, 24, y); y += 24 }
  if (big) { ctx.font = `800 48px ${FONT}`; ctx.fillStyle = '#fff'; ctx.fillText(big, 24, y + 40) }
}

// send the canvas to the glasses as 4 tiles, one update at a time; skip tiles that did not change
const sentTile = new Map<number, string>()
let drawing = false
let wanted: (() => Promise<HTMLCanvasElement>) | null = null

async function show(render: () => Promise<HTMLCanvasElement>) {
  wanted = render
  if (drawing) return
  drawing = true
  try {
    while (wanted) {
      const r = wanted; wanted = null
      const full = await r()
      // encode all changed tiles first, then send them one right after another — the halves of the gift (top and bottom
      // tiles) change together, without a visible tear between them
      const ready: { t: typeof TILES[number]; url: string; bytes: number[] }[] = []
      for (const t of TILES) {
        const c = document.createElement('canvas'); c.width = t.w; c.height = t.h
        const ctx = c.getContext('2d')!
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, t.w, t.h)
        ctx.drawImage(full, -t.x, -t.y)
        const url = c.toDataURL('image/png')
        if (sentTile.get(t.id) === url) continue
        const blob: Blob = await new Promise((res) => c.toBlob((b) => res(b!), 'image/png'))
        ready.push({ t, url, bytes: Array.from(new Uint8Array(await blob.arrayBuffer())) })
      }
      for (const { t, url, bytes } of ready) {
        await bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: t.id, containerName: t.name, imageData: bytes }))
        sentTile.set(t.id, url)
      }
    }
  } catch { /* keep going on the next paint */ } finally { drawing = false }
}

function blank() {
  const c = document.createElement('canvas'); c.width = W; c.height = H
  const ctx = c.getContext('2d')!; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H)
  return { c, ctx }
}

// ---------- state ----------
let deals: Deal[] = []
let idx = 0
let fresh = 0                     // new deals arrived while you were looking at an older one
let token = localStorage.getItem(TOKEN_KEY) || ''
let mode: 'pair' | 'deals' = token ? 'deals' : 'pair'
// glance → hold → card → hold → detail (chart, marketplaces) → hold → glance
let view: 'glance' | 'card' | 'detail' | 'history' = 'glance'
let asleep = false                               // quiet by default: the lens goes dark and wakes on a matching deal
let lastActive = Date.now()
let animOnce = false                             // bot /settings: play the gift animation once instead of looping
let quiet = false                                // quiet hours from the bot /settings: no pop-ups
let filtered = false
const AWAKE_MS = 600000                           // 10 min: in the simulator only Click wakes it (swipes need a scrollable container)
type Detail = { chart: { day: string; usd: number | null; n: number }[]; venues: { market: string; name: string; n: number; usd: number | null }[]; days: number }
const detailCache = new Map<string, Detail | 'loading' | 'error'>()
const watched = new Set<string>()
let hotId = ''                                  // a very strong fresh deal that jumped to the screen
let hotUntil = 0
const HOT_X = 3
let pairCode = ''
let toastUntil = 0
let toastText = ''
let pollAt = Date.now()            // when the deals were fetched — the 'listed Ns ago' timer ticks from here
let confirmUntil = 0               // the full-screen 'Sent to Telegram' confirmation
let confirmDeal: Deal | null = null
const liveAge = (d: Deal) => d.seen_s + Math.floor((Date.now() - pollAt) / 1000)

const num = (n: number) => n.toLocaleString('en-US').replace(/,/g, ' ')
function ago(s: number) {
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  return `${Math.floor(s / 3600)} h ago`
}
function paint() {
  const tip = Date.now() < toastUntil ? toastText : null
  if (mode === 'pair') {
    const code = pairCode
    show(async () => {
      const { c, ctx } = blank()
      if (code) drawMessage(ctx, 'link Telegram', 'Get deals in your Telegram', ['1.  Open @telefeedgifts_ai', '2.  Send this code:'], `${code.slice(0, 3)} ${code.slice(3)}`)
      else drawMessage(ctx, 'link Telegram', 'Connecting…', [])
      return c
    })
    put(5, 'foot', tip || 'tap: skip    2× tap: exit', tip ? 4 : 1)
    return
  }
  const total = deals.length
  if (!total) {
    show(async () => {
      const { c, ctx } = blank()
      drawMessage(ctx, 'live', 'No underpriced gifts in the last hour', ['Watching Telegram Market, MRKT, Portals,', 'Tonnel and on-chain — new deals appear here.'])
      return c
    })
    put(5, 'foot', tip || '2× tap: exit', tip ? 4 : 1)
    return
  }
  if (confirmDeal && Date.now() < confirmUntil) {
    const cd = confirmDeal
    show(async () => { const { c, ctx } = blank(); drawConfirm(ctx, cd); return c })
    put(5, 'foot', tip || '2× tap: next', tip ? 4 : 1)
    return
  }
  const d = deals[Math.min(idx, total - 1)]
  if (asleep) {                                      // dark lens: nothing to look at until a matching deal comes
    show(async () => blank().c)
    put(5, 'foot', 'watching for deals · tap or swipe to wake', 0)   // the text keeps swipe events coming
    return
  }
  if (view === 'glance') {
    const pos = `${idx === 0 && d.seen_s < 120 ? 'NEW · ' : ''}${idx + 1}/${total}` + (fresh ? ` · +${fresh} new` : '') + (filtered ? ' · your filters' : '')
    show(async () => {
      const { c, ctx } = blank()
      const frames = animId === d.id && animStep >= 0 ? await modelFrames(d.id) : null
      drawGlance(ctx, d, frames ? frames[animStep] : restFrame.get(d.id) || await stillPicture(d.title, d.model), pos)
      return c
    })
    if (!d.sold) playModel(d)
    put(5, 'foot', tip || hint(d.sold ? 'tap: next deal   swipe: next' : `swipe up: next   tap: info   2×: ${watched.has(d.id) ? 'watching' : 'watch'}   hold: ${token ? 'send' : 'link'}`), tip ? 4 : HINT_COLOR)
    return
  }
  if (view === 'history') {
    const f = fullCache.get(d.id)
    loadFull(d)
    const page = fpage
    show(async () => {
      const { c, ctx } = blank()
      if (page === 0) {
        const frames = animId === d.id && animStep >= 0 ? await modelFrames(d.id) : null
        drawInfo(ctx, d, f?.v, frames ? frames[animStep] : restFrame.get(d.id) || await stillPicture(d.title, d.model))
      } else if (page === 1) drawSales(ctx, d, f?.v)
      else drawOnSale(ctx, d, f?.v)
      if (endMenu !== null) drawEndMenu(ctx)
      return c
    })
    if (page === 0 && !d.sold) playModel(d)
    const nextT = page < PAGES.length - 1 ? `tap: ${PAGES[page + 1].toLowerCase()}` : 'tap: back'
    if (endMenu !== null && !tip) { put(5, 'foot', 'SWIPE: CHOOSE  ·  TAP: OK  ·  2×: FEED', HINT_COLOR); return }
    const atEnd = fpage > 0 && fullRows(fpage) > ROWS && fscroll + ROWS >= fullRows(fpage)
    const scrolls = fpage > 0 && fullRows(fpage) > ROWS
    put(5, 'foot', tip || hint(`${scrolls ? `swipe down: ${atEnd ? 'from top' : 'more'}   ` : ''}${nextT}   2×: feed   hold: ${token ? 'send' : 'link'}`), tip ? 4 : HINT_COLOR)
    return
  }
  if (view === 'detail') {
    const det = detailCache.get(comboKey(d))
    if (!det) loadDetail(d)
    show(async () => { const { c, ctx } = blank(); drawDetail(ctx, d, det); return c })
    put(5, 'foot', tip || 'tap: watch    hold / swipe: back', tip ? 4 : 1)
    return
  }
  const pos = `${idx === 0 && d.seen_s < 120 ? 'NEW · ' : ''}deal ${idx + 1}/${total}` + (fresh ? ` · +${fresh} new` : ' · live')
  show(async () => {
    const { c, ctx } = blank()
    const [pic, back] = await Promise.all([modelPicture(d.title, d.model, MODEL_PX), giftBackdrop(d.id, 212, 128)])
    drawDeal(ctx, d, pic, back, pos)
    return c
  })
  put(5, 'foot', tip || '2× tap: next    hold: chart', tip ? 4 : 1)
}

function toast(t: string, ms = 2500) {
  toastText = t; toastUntil = Date.now() + ms; paint()
  setTimeout(paint, ms + 50)
}

// ---------- data ----------
function markSold(d: Deal) {
  d.sold = true
  setTimeout(() => {                                   // after 3 s the next deal takes its place
    const j = deals.indexOf(d)
    if (j >= 0) deals.splice(j, 1)
    if (idx >= deals.length) idx = Math.max(0, deals.length - 1)
    paint()
  }, 3000)
}

function drawConfirm(ctx: CanvasRenderingContext2D, d: Deal) {
  header(ctx, 'sent')
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 6; ctx.lineCap = 'round'; ctx.lineJoin = 'round'
  ctx.beginPath(); ctx.arc(110, 146, 62, 0, Math.PI * 2); ctx.stroke()
  ctx.beginPath(); ctx.moveTo(80, 148); ctx.lineTo(102, 170); ctx.lineTo(142, 124); ctx.stroke()
  ctx.textBaseline = 'alphabetic'
  ctx.font = `800 30px ${FONT}`; ctx.fillStyle = '#fff'; ctx.fillText('Sent to Telegram', 206, 112)
  ctx.font = `600 16px ${FONT}`; ctx.fillStyle = C.text; ctx.fillText(fit(ctx, `${d.title} #${d.num} · ${priceText(d)}`, W - 220), 206, 146)
  ctx.font = `500 14px ${FONT}`; ctx.fillStyle = C.dim
  ctx.fillText('Open it on your phone and buy in two taps.', 206, 176)
  ctx.fillText('Next deal in a moment…', 206, 200)
}

async function poll() {
  try {
    const r = await fetch(`${API}/signals?limit=20&minutes=60` + (token ? `&token=${encodeURIComponent(token)}` : ''))
    if (!r.ok) throw new Error(String(r.status))
    const data = await r.json() as { items: Deal[]; gone?: string[]; quiet?: boolean; filtered?: boolean; anim?: string }
    animOnce = data.anim === 'once'; quiet = !!data.quiet; filtered = !!data.filtered
    const goneSet = new Set(data.gone || [])
    const known = new Set(deals.map((d) => d.id))
    const curDeal = deals[idx]
    if (curDeal && !curDeal.sold && goneSet.has(curDeal.id)) markSold(curDeal)   // the one you look at was just bought
    const items = data.items.filter((d) => !goneSet.has(d.id))
    const added = items.filter((d) => !known.has(d.id)).length
    const cur = curDeal?.id
    pollAt = Date.now()
    const hot = known.size ? items.find((d) => !known.has(d.id) && d.x >= HOT_X && d.seen_s < 60) : undefined
    deals = curDeal?.sold ? [curDeal, ...items.filter((d) => d.id !== curDeal.id)] : items
    prefetchFrames()
    const fresh1 = known.size ? items.find((d) => !known.has(d.id) && d.seen_s < 120) : undefined
    if (asleep && fresh1 && !quiet) {                  // a new matching deal wakes the lens up
      asleep = false; lastActive = Date.now(); view = 'glance'
      idx = Math.max(0, deals.indexOf(fresh1)); fresh = 0
      if (fresh1.x >= HOT_X) { hotId = fresh1.id; hotUntil = Date.now() + 10000 }
    } else if (hot && !asleep && view === 'glance' && !confirmDeal && Date.now() - lastActive > 8000) {      // a very strong fresh deal jumps to the screen
      idx = Math.max(0, deals.indexOf(hot)); fresh = 0
      hotId = hot.id; hotUntil = Date.now() + 10000
    } else if (view === 'history' && curDeal) {          // reading the full info: the gift must not change under you
      const j = deals.findIndex((d) => d.id === curDeal.id)
      if (j < 0) { deals = [curDeal, ...deals]; idx = 0 } else idx = j
      fresh += known.size ? added : 0
    } else if (idx > 0 && cur) {                         // keep your place while you browse older deals
      const j = deals.findIndex((d) => d.id === cur)
      idx = j >= 0 ? j : 0
      fresh += known.size ? added : 0
    } else {
      idx = 0; fresh = 0
    }
  } catch {
    if (!deals.length) {
      show(async () => { const { c, ctx } = blank(); drawMessage(ctx, 'offline', 'No connection to the deal feed', ['Retrying…']); return c })
      return
    }
  }
  if (mode === 'deals') paint()
}

async function startPairing() {
  mode = 'pair'; pairCode = ''; paint()
  try {
    const r = await fetch(`${API}/pair`, { method: 'POST' })
    pairCode = (await r.json()).code || ''
  } catch { pairCode = '' }
  paint()
  const code = pairCode
  if (!code) return                               // no bot on the server: stay view-only
  const t0 = Date.now()
  while (mode === 'pair' && code === pairCode && Date.now() - t0 < 600_000) {
    await new Promise((res) => setTimeout(res, 2000))
    try {
      const r = await fetch(`${API}/pair/${code}`)
      const j = await r.json()
      if (j.paired && j.token) {
        token = j.token; localStorage.setItem(TOKEN_KEY, token)
        mode = 'deals'; toast('Telegram linked. Tap a deal to send it.')
        return
      }
    } catch { /* keep waiting */ }
  }
}

async function watchCurrent() {
  const d = deals[idx]
  if (!d) return
  if (!token) { startPairing(); return }
  if (watched.has(d.id)) { toast('Already watching this lot'); return }
  try {
    const r = await fetch(`${API}/watch`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, item: d }),
    })
    if (r.ok) { watched.add(d.id); toast('Watching: the bot writes if it gets cheaper or sells') } else toast('Could not set the watch')
  } catch { toast('No connection. Hold to retry.') }
}

async function sendCurrent() {
  const d = deals[idx]
  if (!d) return
  if (d.sold) { if (idx < deals.length - 1) idx++; paint(); return }   // it is gone — go to the next one
  if (!token) { startPairing(); return }
  toast('Sending to Telegram...', 4000)
  try {
    const r = await fetch(`${API}/send`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, item: d }),
    })
    if (r.status === 403) { token = ''; localStorage.removeItem(TOKEN_KEY); toast('Link expired. Hold to link again.'); return }
    if (!r.ok) { toast('Could not send. Hold to retry.'); return }
    toastUntil = 0
    confirmDeal = d; confirmUntil = Date.now() + 2200; paint()
    setTimeout(() => {                                  // then straight to the next deal
      confirmDeal = null; view = 'glance'
      if (deals[idx]?.id === d.id && idx < deals.length - 1) idx++
      paint()
    }, 2300)
  } catch { toast('No connection. Hold to retry.') }
}

function fullRows(page: number): number {
  const d = deals[Math.min(idx, deals.length - 1)]
  const f = d && fullCache.get(d.id)?.v
  if (!f || f === 'loading' || f === 'error') return 0
  const t = tableRows(d, f)
  return page === 1 ? t.sales.length : page === 2 ? t.lots.length : 0
}
// Swipes stay inside the current page (owner 27.11 «1 и 2»): down — further down the table (at the end of a long one —
// from its top again), up — back; up at the top of a page — to the feed. Pages change only by tap; 2× tap — the feed.
function fullStep(dir: 1 | -1) {
  const STEP = 3, rows = fullRows(fpage)
  if (dir > 0) {
    if (fpage > 0 && fscroll + ROWS < rows) fscroll += STEP            // more rows below
    else if (fpage > 0 && rows > ROWS) fscroll = 0                       // end of a long table: from its top again
    else return                                                          // GIFT or a short table: nothing to scroll
  } else {
    if (fpage > 0 && fscroll > 0) fscroll = Math.max(0, fscroll - STEP)
    else view = 'glance'                                                 // top of the page: back to the feed
  }
  paint()
}

// the model animation of the deal on screen and the next two is prepared ahead, one at a time,
// so it starts right away when you get there
let prefetching = false
async function prefetchFrames() {
  if (prefetching) return
  prefetching = true
  try {
    for (let k = 0; k < 3; k++) {
      const d = deals[Math.min(deals.length - 1, idx + k)]
      if (d && !d.sold) await modelFrames(d.id)
    }
  } finally { prefetching = false }
}

// ---------- input ----------
function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}
bridge.onEvenHubEvent((event) => {
  const sysType = eventTypeOf(event.sysEvent)
  const textType = eventTypeOf(event.textEvent)
  const is = (t: OsEventTypeList) => sysType === t || textType === t
  if (is(OsEventTypeList.LONG_PRESS_RELEASE_EVENT)) return
  lastActive = Date.now()
  if (asleep && mode === 'deals') {                   // any touch wakes the lens — show the freshest deal, do nothing else
    asleep = false; view = 'glance'; idx = 0; fresh = 0; paint(); return
  }
  if (is(OsEventTypeList.LONG_PRESS_EVENT)) {          // hold: send the deal to Telegram (from the glance or the sales history)
    if (mode === 'deals' && deals.length) sendCurrent()
    return
  }
  if (is(OsEventTypeList.DOUBLE_CLICK_EVENT)) {          // double tap: next deal (wraps to the freshest); no deals — exit
    if (view === 'history') { endMenu = null; view = 'glance'; paint(); return }       // in the full info: straight back to the feed
    if (mode === 'deals' && deals.length) {        // in the feed: watch this lot (deals are flipped by swipes now)
      const d = deals[Math.min(idx, deals.length - 1)]
      if (d.sold) { idx = idx < deals.length - 1 ? idx + 1 : 0; paint(); return }
      watchCurrent(); return
    }
    bridge.shutDownPageContainer(1); return
  }
  if (view === 'detail' && (is(OsEventTypeList.SCROLL_BOTTOM_EVENT) || is(OsEventTypeList.SCROLL_TOP_EVENT))) {
    view = 'card'; paint(); return
  }
  // swipe UP = forward, DOWN = back (as on a phone). In the full info it is one long page: GIFT → the sales rows →
  // ON SALE rows; back past the top of GIFT returns to the feed. In the feed it flips deals.
  const fwd = is(OsEventTypeList.SCROLL_TOP_EVENT), back = is(OsEventTypeList.SCROLL_BOTTOM_EVENT)
  // in the full info it is the other way round (owner 27.11: «список спускается свайпом вниз — так естественнее»):
  // swipe DOWN goes deeper into the lists, UP goes back (above GIFT — to the feed)
  if ((fwd || back) && view === 'history' && endMenu !== null) { endMenu = endMenu ? 0 : 1; paint(); return }
  if ((fwd || back) && view === 'history' && mode === 'deals' && deals.length) { fullStep(back ? 1 : -1); return }
  if (fwd && mode === 'deals' && deals.length) {
    idx = Math.min(deals.length - 1, idx + 1); paint(); prefetchFrames(); return
  }
  if (back && mode === 'deals' && deals.length) {
    idx = Math.max(0, idx - 1); if (idx === 0) fresh = 0; paint(); return
  }
  if (sysType === OsEventTypeList.CLICK_EVENT || textType === OsEventTypeList.CLICK_EVENT) {
    if (mode === 'pair') { mode = 'deals'; paint(); return }   // skip linking: view only
    if (view === 'detail') { watchCurrent(); return }
    if (mode === 'deals' && deals.length) {          // tap: the deal <-> its sales history (back to the same deal)
      const d = deals[Math.min(idx, deals.length - 1)]
      if (d.sold && view === 'glance') { idx = idx < deals.length - 1 ? idx + 1 : 0; paint(); return }
      if (view === 'history' && endMenu !== null) {  // the end menu: from the start or back to the feed
        if (endMenu === 0) { fpage = 0; fscroll = 0 } else view = 'glance'
        endMenu = null; paint(); return
      }
      if (view === 'history' && fpage === PAGES.length - 1) { endMenu = 0; paint(); return }
      if (view === 'history') {                      // next page; after the last one — back to the feed
        fpage++; fscroll = 0
        if (fpage >= PAGES.length) view = 'glance'
      } else { view = 'history'; fpage = 0; fscroll = 0; endMenu = null; loadFull(d) }
      paint(); return
    }
  }
})

paint()
if (mode === 'pair') startPairing()
poll()
setInterval(poll, POLL_MS)
setInterval(() => {
  if (mode !== 'deals') return
  if (!asleep && !confirmDeal && view !== 'detail' && view !== 'history' && Date.now() - lastActive > AWAKE_MS) { asleep = true; paint(); return }
  if (deals.length && !asleep && !drawing) paint()                 // timer ticks, HOT blinks
}, 500)   // 'listed Ns ago' ticks
