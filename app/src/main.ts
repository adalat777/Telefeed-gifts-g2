// TeleGift Glance — underpriced Telegram Gifts on Even Realities G2.
// Read: the freshest gift listing that sells far below the top sale of its model + backdrop.
// Write: one tap sends the deal to your Telegram via our bot (with an "Open gift" button to buy on the phone).
//   swipe down / up — next / previous deal · tap — send to Telegram · double tap — exit
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

type Deal = {
  id: string; title: string; num: number; model: string; backdrop: string; pattern?: string
  price: number; cur: 'STARS' | 'GRAM'; usd: number | null; x: number; floor: number | null; cheapest?: boolean
  typical: number | null; max: number | null; sales: number | null; market: string; url: string | null; seen_s: number
  resell?: { sell: number; net: number; cost_usd: number; get_usd: number; profit_usd: number } | null
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
  { id: 1, name: 't1', x: 0, y: 0, w: TW, h: 144 },
  { id: 2, name: 't2', x: TW, y: 0, w: TW, h: 144 },
  { id: 3, name: 't3', x: 0, y: 144, w: TW, h: H - 144 },
  { id: 4, name: 't4', x: TW, y: 144, w: TW, h: H - 144 },
]
const tiles = TILES.map((t) => new ImageContainerProperty({
  xPosition: t.x, yPosition: t.y, width: t.w, height: t.h, containerID: t.id, containerName: t.name,
}))
const foot = new TextContainerProperty({
  xPosition: 0, yPosition: H, width: 576, height: 288 - H, borderWidth: 0, borderColor: 5, paddingLength: 4,
  containerID: 5, containerName: 'foot', content: '', isEventCapture: 1,
})
const page = { containerTotalNum: 5, textObject: [foot], imageObject: tiles }
await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(page))
// After an app reload the glasses keep the old page — rebuild it so every container exists.
await bridge.rebuildPageContainer(new RebuildPageContainer(page))

const putLast = new Map<number, string>()
function put(id: number, name: string, content: string, textColor?: number) {
  const k = `${content}|${textColor}`
  if (putLast.get(id) === k) return                  // the timer repaints every second — don't resend the same text
  putLast.set(id, k)
  bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: id, containerName: name, content, textColor }))
}

// ---------- model picture: shading + contours, in grayscale ----------
const modelCache = new Map<string, HTMLCanvasElement | null>()
const MODEL_PX = 116                     // drawn pixel-for-pixel on the lens

async function modelPicture(title: string, model: string, size: number): Promise<HTMLCanvasElement | null> {
  const key = `${title}|${model}|${size}`
  if (modelCache.has(key)) return modelCache.get(key)!
  let out: HTMLCanvasElement | null = null
  try {
    const r = await fetch(`${API}/model?c=${encodeURIComponent(title)}&m=${encodeURIComponent(model)}`)
    if (r.ok) {
      const bmp = await createImageBitmap(await r.blob())
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
      const lo = vals.length ? vals[Math.floor(vals.length * 0.04)] : 0
      const hi = vals.length ? vals[Math.floor(vals.length * 0.97)] : 255
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
      out = c
    }
  } catch { out = null }
  modelCache.set(key, out)
  if (modelCache.size > 40) modelCache.delete(modelCache.keys().next().value!)
  return out
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
function fit(ctx: CanvasRenderingContext2D, text: string, max: number) {
  if (ctx.measureText(text).width <= max) return text
  while (text.length > 1 && ctx.measureText(text + '…').width > max) text = text.slice(0, -1)
  return text + '…'
}
const money = (v: number) => (v < 100 ? v.toFixed(2).replace(/\.00$/, '') : String(Math.round(v)))
const xs = (x: number) => x.toFixed(2).replace(/\.?0+$/, '')   // 2.00 → 2, 2.10 → 2.1, 2.22 → 2.22
const usd = (v: number | null) => (v == null ? '' : `≈ $${v < 100 ? v.toFixed(2).replace(/\.00$/, '') : Math.round(v)}`)
const priceText = (d: Deal) => (d.cur === 'STARS' ? `${num(d.price)} ★` : `${d.price < 100 ? d.price : Math.round(d.price)} GRAM`)

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
  // ---- gift card (like a card in the Live feed) ----
  const cx = 10, cy = 42, cw = 214, ch = 206
  rrect(ctx, cx, cy, cw, ch, 14); ctx.fillStyle = C.card; ctx.fill()
  ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.stroke()
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
  ctx.font = `700 15px ${FONT}`; ctx.fillStyle = C.text
  const name = fit(ctx, d.title, cw - 90)
  ctx.fillText(name, cx + 10, y)
  const nw = ctx.measureText(name).width
  ctx.font = `500 14px ${FONT}`; ctx.fillStyle = C.dim; ctx.fillText(` #${d.num}`, cx + 10 + nw, y)
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
      for (const t of TILES) {
        const c = document.createElement('canvas'); c.width = t.w; c.height = t.h
        const ctx = c.getContext('2d')!
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, t.w, t.h)
        ctx.drawImage(full, -t.x, -t.y)
        const url = c.toDataURL('image/png')
        if (sentTile.get(t.id) === url) continue
        const blob: Blob = await new Promise((res) => c.toBlob((b) => res(b!), 'image/png'))
        const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()))
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
    put(5, 'foot', tip || 'swipe: next    2× tap: exit', tip ? 4 : 1)
    return
  }
  const d = deals[Math.min(idx, total - 1)]
  const pos = `${idx === 0 && d.seen_s < 120 ? 'NEW · ' : ''}deal ${idx + 1}/${total}` + (fresh ? ` · +${fresh} new` : ' · live')
  show(async () => {
    const { c, ctx } = blank()
    const [pic, back] = await Promise.all([modelPicture(d.title, d.model, MODEL_PX), giftBackdrop(d.id, 212, 128)])
    drawDeal(ctx, d, pic, back, pos)
    return c
  })
  put(5, 'foot', tip || 'swipe: next    2× tap: exit', tip ? 4 : 1)
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
    const r = await fetch(`${API}/signals?limit=20&minutes=60`)
    if (!r.ok) throw new Error(String(r.status))
    const data = await r.json() as { items: Deal[]; gone?: string[] }
    const goneSet = new Set(data.gone || [])
    const known = new Set(deals.map((d) => d.id))
    const curDeal = deals[idx]
    if (curDeal && !curDeal.sold && goneSet.has(curDeal.id)) markSold(curDeal)   // the one you look at was just bought
    const items = data.items.filter((d) => !goneSet.has(d.id))
    const added = items.filter((d) => !known.has(d.id)).length
    const cur = curDeal?.id
    pollAt = Date.now()
    deals = curDeal?.sold ? [curDeal, ...items.filter((d) => d.id !== curDeal.id)] : items
    if (idx > 0 && cur) {                         // keep your place while you browse older deals
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
    if (r.status === 403) { token = ''; localStorage.removeItem(TOKEN_KEY); toast('Link expired. Tap to link again.'); return }
    if (!r.ok) { toast('Could not send. Tap to retry.'); return }
    toastUntil = 0
    confirmDeal = d; confirmUntil = Date.now() + 2200; paint()
    setTimeout(() => {                                  // then straight to the next deal
      confirmDeal = null
      if (deals[idx]?.id === d.id && idx < deals.length - 1) idx++
      paint()
    }, 2300)
  } catch { toast('No connection. Tap to retry.') }
}

// ---------- input ----------
function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}
bridge.onEvenHubEvent((event) => {
  const sysType = eventTypeOf(event.sysEvent)
  const textType = eventTypeOf(event.textEvent)
  if (sysType === OsEventTypeList.DOUBLE_CLICK_EVENT || textType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    bridge.shutDownPageContainer(1); return
  }
  if (textType === OsEventTypeList.SCROLL_BOTTOM_EVENT && mode === 'deals' && deals.length) {
    idx = Math.min(deals.length - 1, idx + 1); paint(); return
  }
  if (textType === OsEventTypeList.SCROLL_TOP_EVENT && mode === 'deals' && deals.length) {
    idx = Math.max(0, idx - 1); if (idx === 0) fresh = 0; paint(); return
  }
  if (sysType === OsEventTypeList.CLICK_EVENT || textType === OsEventTypeList.CLICK_EVENT) {
    if (mode === 'pair') { mode = 'deals'; paint(); return }   // skip linking: view only
    sendCurrent()
  }
})

paint()
if (mode === 'pair') startPairing()
poll()
setInterval(poll, POLL_MS)
setInterval(() => { if (mode === 'deals' && deals.length && !drawing) paint() }, 1000)   // 'listed Ns ago' ticks
