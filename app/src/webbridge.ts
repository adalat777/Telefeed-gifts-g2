// Browser demo of TeleGift Glance (for the jury, owner 27.11): no glasses, no Even Hub app needed.
// A stand-in for the Even Hub bridge — the very same app code draws the lens on the page:
//   · image tiles (PNG) are composed on a 576×288 canvas and tinted like the green G2 display;
//   · the text container (hint line) is drawn below them;
//   · gestures come from buttons, the keyboard (↑ ↓ Enter, D — double tap, H — hold) and the mouse wheel.
// Open the app with ?demo (or anywhere outside the Even Hub app — then it switches on by itself).

type Handler = (e: { sysEvent?: { eventType?: number }; textEvent?: { eventType?: number } }) => void
type Tile = { id: number; x: number; y: number; w: number; h: number }
type TextBox = { id: number; x: number; y: number; w: number; h: number; content: string; color?: number }

const LW = 576, LH = 288
const EV = { CLICK: 0, UP: 1, DOWN: 2, DOUBLE: 3, HOLD: 9 }   // OsEventTypeList: CLICK, SCROLL_TOP, SCROLL_BOTTOM, DOUBLE_CLICK, LONG_PRESS

export function isDemo(): boolean {
  const q = new URLSearchParams(location.search)
  if (q.has('demo')) return true
  const w = window as unknown as Record<string, unknown>
  return !w.flutter_inappwebview && !w.webkit_bridge && !/EvenHub|Even\s?Realities/i.test(navigator.userAgent)
}

export function webBridge() {
  const tiles = new Map<number, Tile>()
  const images = new Map<number, HTMLImageElement>()
  const texts = new Map<number, TextBox>()
  let handler: Handler | null = null

  // ---------- page ----------
  document.title = 'TeleGift Glance — browser demo'
  const app = document.getElementById('app')!
  app.innerHTML = ''
  app.style.flexDirection = 'column'
  app.style.gap = '18px'
  const style = document.createElement('style')
  style.textContent = `
    .lens-wrap{position:relative;padding:18px;border-radius:28px;background:#0b0b0b;box-shadow:0 0 0 1px #2c2c2c,0 20px 60px #0008}
    .lens{display:block;width:min(92vw,864px);aspect-ratio:2/1;image-rendering:auto;border-radius:14px;background:#000}
    .pad{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;max-width:864px}
    .pad button{font:500 14px/1 -apple-system,system-ui,sans-serif;color:#e5e5e5;background:#2e2e2e;border:1px solid #444;
      border-radius:10px;padding:11px 14px;cursor:pointer;min-width:96px}
    .pad button:hover{background:#3a3a3a}.pad button:active{transform:scale(.97)}
    .pad kbd{font:12px ui-monospace,monospace;color:#9a9a9a;margin-left:6px}
    .note{max-width:760px;color:#a8a8a8;font-size:13px;line-height:1.55}
    .note b{color:#e5e5e5;font-weight:600}`
  document.head.appendChild(style)

  const wrap = document.createElement('div'); wrap.className = 'lens-wrap'
  const cv = document.createElement('canvas'); cv.className = 'lens'
  cv.width = LW * 2; cv.height = LH * 2                        // 2× for a crisp picture
  wrap.appendChild(cv); app.appendChild(wrap)
  const ctx = cv.getContext('2d', { willReadFrequently: true })!

  const pad = document.createElement('div'); pad.className = 'pad'
  const btn = (label: string, key: string, ev: number) => {
    const b = document.createElement('button')
    b.innerHTML = `${label}<kbd>${key}</kbd>`
    b.onclick = () => fire(ev)
    pad.appendChild(b)
  }
  btn('Swipe ↑', '↑', EV.UP)
  btn('Swipe ↓', '↓', EV.DOWN)
  btn('Tap', 'Enter', EV.CLICK)
  btn('Double tap', 'D', EV.DOUBLE)
  btn('Hold', 'H', EV.HOLD)
  app.appendChild(pad)

  const note = document.createElement('div'); note.className = 'note'
  note.innerHTML = '<b>Live data</b> — underpriced Telegram gifts as our scanner finds them. ' +
    '<b>Swipe ↑</b> next deal · <b>Tap</b> full gift info (gift → sales → on sale) · <b>Double tap</b> watch the lot · ' +
    '<b>Hold</b> send it to Telegram (works after linking the bot). The picture is the real 576×288 G2 lens image.'
  app.appendChild(note)

  function fire(eventType: number) {
    handler?.({ textEvent: { eventType } })
  }
  addEventListener('keydown', (e) => {
    if (e.repeat) return
    const k = e.key.toLowerCase()
    if (e.key === 'ArrowUp') fire(EV.UP)
    else if (e.key === 'ArrowDown') fire(EV.DOWN)
    else if (e.key === 'Enter' || e.key === ' ') fire(EV.CLICK)
    else if (k === 'd' || k === 'в') fire(EV.DOUBLE)
    else if (k === 'h' || k === 'р') fire(EV.HOLD)
    else return
    e.preventDefault()
  })
  let wheelAt = 0
  cv.addEventListener('wheel', (e) => {
    e.preventDefault()
    if (Date.now() - wheelAt < 350) return
    wheelAt = Date.now(); fire(e.deltaY > 0 ? EV.DOWN : EV.UP)
  }, { passive: false })
  cv.addEventListener('click', () => fire(EV.CLICK))

  // ---------- drawing: grayscale → G2 green ----------
  let queued = false
  function paint() {
    if (queued) return
    queued = true
    requestAnimationFrame(() => {
      queued = false
      ctx.setTransform(2, 0, 0, 2, 0, 0)
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, LW, LH)
      for (const [id, t] of tiles) {
        const img = images.get(id)
        if (img) ctx.drawImage(img, t.x, t.y, t.w, t.h)
      }
      for (const t of texts.values()) {
        if (!t.content.trim()) continue
        const lum = t.color === 0 ? 0.55 : 0.85
        ctx.fillStyle = `rgba(255,255,255,${lum})`
        ctx.font = '600 13px -apple-system, system-ui, sans-serif'
        ctx.textBaseline = 'middle'; ctx.textAlign = 'center'
        ctx.fillText(t.content, t.x + t.w / 2, t.y + t.h / 2, t.w - 12)
        ctx.textAlign = 'left'
      }
      // tint: the lens shows brightness in green; dark grays are lifted like on the real display
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      const data = ctx.getImageData(0, 0, cv.width, cv.height)
      const p = data.data
      for (let i = 0; i < p.length; i += 4) {
        const v = (p[i] * 0.299 + p[i + 1] * 0.587 + p[i + 2] * 0.114) / 255
        const b = v <= 0.02 ? 0 : Math.pow(v, 0.62)
        p[i] = 40 * b; p[i + 1] = 255 * b; p[i + 2] = 90 * b
      }
      ctx.putImageData(data, 0, 0)
    })
  }

  function layout(page: { textObject?: Array<Record<string, unknown>>; imageObject?: Array<Record<string, unknown>> }) {
    tiles.clear(); texts.clear()
    for (const o of page.imageObject || []) {
      tiles.set(o.containerID as number, { id: o.containerID as number, x: o.xPosition as number, y: o.yPosition as number,
        w: o.width as number, h: o.height as number })
    }
    for (const o of page.textObject || []) {
      texts.set(o.containerID as number, { id: o.containerID as number, x: o.xPosition as number, y: o.yPosition as number,
        w: o.width as number, h: o.height as number, content: String(o.content || '') })
    }
    paint()
  }

  return {
    async createStartUpPageContainer(p: Record<string, unknown>) { layout(p as never); return 0 },
    async rebuildPageContainer(p: Record<string, unknown>) { layout(p as never); return true },
    async textContainerUpgrade(u: { containerID: number; content: string; textColor?: number }) {
      const t = texts.get(u.containerID)
      if (t) { t.content = u.content; t.color = u.textColor; paint() }
      return true
    },
    async updateImageRawData(u: { containerID: number; imageData: number[] }) {
      const blob = new Blob([new Uint8Array(u.imageData)], { type: 'image/png' })
      const url = URL.createObjectURL(blob)
      const img = new Image()
      await new Promise<void>((res) => { img.onload = () => res(); img.onerror = () => res(); img.src = url })
      const old = images.get(u.containerID)
      if (old) URL.revokeObjectURL(old.src)
      images.set(u.containerID, img)
      paint()
      return 0
    },
    onEvenHubEvent(h: Handler) { handler = h; return () => { handler = null } },
    async shutDownPageContainer() { return true },
  }
}
