// TeleGift Glance — underpriced Telegram Gifts on Even Realities G2.
// Read: the freshest gift listing that sells far below the top sale of its model + backdrop.
// Write: one tap sends the deal to your Telegram via our bot (with an "Open gift" button to buy on the phone).
//   swipe down / up — next / previous deal · tap — send to Telegram · double tap — exit
import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
  ImageContainerProperty,
  ImageRawDataUpdate,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'

type Deal = {
  id: string; title: string; num: number; model: string; backdrop: string; pattern?: string
  price: number; cur: 'STARS' | 'GRAM'; usd: number | null; x: number; floor: number | null; cheapest?: boolean
  typical: number | null; max: number | null; sales: number | null; market: string; url: string | null; seen_s: number
}

const API = (import.meta.env.VITE_API as string | undefined) || 'http://localhost:8090'
const POLL_MS = 8000
const TOKEN_KEY = 'telegift.token'
const MARKET: Record<string, string> = {
  telegram: 'Telegram', onchain: 'On-chain', mrkt: 'MRKT', portals: 'Portals', tonnel: 'Tonnel', getgems: 'GetGems',
}

const bridge = await waitForEvenAppBridge()

const head = new TextContainerProperty({
  xPosition: 0, yPosition: 0, width: 576, height: 44, borderWidth: 0, borderColor: 5, paddingLength: 6,
  containerID: 1, containerName: 'head', content: 'TELEGIFT GLANCE', isEventCapture: 0,
})
// picture of the gift model (no background) on the left, the deal text on the right
const PIC = 140
const pic = new ImageContainerProperty({
  xPosition: 6, yPosition: 74, width: PIC, height: PIC, containerID: 4, containerName: 'pic',
})
const body = new TextContainerProperty({
  xPosition: PIC + 12, yPosition: 44, width: 576 - PIC - 12, height: 200, borderWidth: 1, borderColor: 8, borderRadius: 6,
  paddingLength: 10, containerID: 2, containerName: 'body', content: 'Loading deals...', isEventCapture: 1,
})
const foot = new TextContainerProperty({
  xPosition: 0, yPosition: 248, width: 576, height: 40, borderWidth: 0, borderColor: 5, paddingLength: 6,
  containerID: 3, containerName: 'foot', content: '', isEventCapture: 0,
})
await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer({ containerTotalNum: 4, textObject: [head, body, foot], imageObject: [pic] }),
)

function put(id: number, name: string, content: string) {
  bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: id, containerName: name, content }))
}

// ---------- model picture ----------
// The lens is monochrome green: we turn the model into a bright grayscale silhouette on black (black = transparent).
const picCache = new Map<string, number[]>()
let picShown = ''
let picBusy = false
let picWant = ''

async function picBytes(title: string, model: string): Promise<number[]> {
  const key = `${title}|${model}`
  const hit = picCache.get(key)
  if (hit) return hit
  const canvas = document.createElement('canvas')
  canvas.width = PIC; canvas.height = PIC
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, PIC, PIC)
  try {
    const r = await fetch(`${API}/model?c=${encodeURIComponent(title)}&m=${encodeURIComponent(model)}`)
    if (r.ok) {
      const bmp = await createImageBitmap(await r.blob())
      const k = Math.min(PIC / bmp.width, PIC / bmp.height) * 0.96
      const w = bmp.width * k, h = bmp.height * k
      ctx.drawImage(bmp, (PIC - w) / 2, (PIC - h) / 2, w, h)
      const img = ctx.getImageData(0, 0, PIC, PIC)
      const d = img.data
      let max = 1
      for (let i = 0; i < d.length; i += 4) {
        const g = 0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2]
        d[i] = g; if (g > max) max = g
      }
      for (let i = 0; i < d.length; i += 4) {               // stretch contrast: brightest part = full brightness
        const v = d[i] > 0 ? Math.min(255, 40 + Math.pow(d[i] / max, 0.8) * 215) : 0
        d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255
      }
      ctx.putImageData(img, 0, 0)
    }
  } catch { /* no picture: stays black */ }
  const blob: Blob = await new Promise((res) => canvas.toBlob((b) => res(b!), 'image/png'))
  const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()))
  picCache.set(key, bytes)
  if (picCache.size > 60) picCache.delete(picCache.keys().next().value!)
  return bytes
}

async function showPic(title: string, model: string) {
  picWant = `${title}|${model}`
  if (picBusy || picWant === picShown) return
  picBusy = true
  try {
    while (picWant !== picShown) {
      const want = picWant
      const [t, m] = want.split('|')
      const bytes = t && m ? await picBytes(t, m) : await picBytes('', '')
      await bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: 4, containerName: 'pic', imageData: bytes }))
      picShown = want
    }
  } catch { /* keep text working even if the picture fails */ } finally { picBusy = false }
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

const num = (n: number) => n.toLocaleString('en-US').replace(/,/g, ' ')
function ago(s: number) {
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  return `${Math.floor(s / 3600)} h ago`
}
function priceLine(d: Deal) {
  const p = d.cur === 'STARS' ? `${num(d.price)} Stars` : `${d.price} GRAM`
  return d.usd ? `${p}   ~ $${d.usd}` : p
}

function paint() {
  if (mode === 'pair') {
    showPic('', '')
    put(1, 'head', 'TELEGIFT GLANCE  |  link Telegram')
    put(2, 'body', pairCode
      ? `Get deals sent to your Telegram:\n\n1. Open @telefeedgifts_ai\n2. Send this code:  ${pairCode.slice(0, 3)} ${pairCode.slice(3)}\n\nWaiting...`
      : 'Connecting...')
    put(3, 'foot', 'tap: skip (view only)   double tap: exit')
    return
  }
  const total = deals.length
  if (!total) {
    showPic('', '')
    put(1, 'head', 'TELEGIFT GLANCE  |  live')
    put(2, 'body', 'No underpriced gifts in the last hour.\n\nWatching Telegram Market, MRKT, Portals,\nTonnel and on-chain... new deals appear here.')
    put(3, 'foot', 'double tap: exit')
    return
  }
  const d = deals[Math.min(idx, total - 1)]
  showPic(d.title, d.model)
  const badge = idx === 0 && d.seen_s < 120 ? 'NEW  ' : ''
  put(1, 'head', `TELEGIFT  deal ${idx + 1}/${total}` + (fresh ? `   +${fresh} new` : '   live'))
  put(2, 'body', [
    `${badge}${d.title} #${d.num}`,
    `${d.model} | ${d.backdrop}`,
    priceLine(d),
    `x${d.x} vs top sale`,
    d.floor ? `floor ${num(d.floor)} Stars` : d.cheapest ? 'cheapest on sale' : '',
    `${MARKET[d.market] || d.market}  |  ${ago(d.seen_s)}` + (d.sales ? `  |  ${d.sales} sales` : ''),
  ].join('\n'))
  const tip = token ? 'tap: send to Telegram' : 'tap: link Telegram'
  put(3, 'foot', Date.now() < toastUntil ? toastText : `${tip}   swipe: next   2x tap: exit`)
}

function toast(t: string, ms = 2500) {
  toastText = t; toastUntil = Date.now() + ms; paint()
  setTimeout(paint, ms + 50)
}

// ---------- data ----------
async function poll() {
  try {
    const r = await fetch(`${API}/signals?limit=20&minutes=60`)
    if (!r.ok) throw new Error(String(r.status))
    const data = await r.json() as { items: Deal[] }
    const known = new Set(deals.map((d) => d.id))
    const added = data.items.filter((d) => !known.has(d.id)).length
    const cur = deals[idx]?.id
    deals = data.items
    if (idx > 0 && cur) {                         // keep your place while you browse older deals
      const j = deals.findIndex((d) => d.id === cur)
      idx = j >= 0 ? j : 0
      fresh += known.size ? added : 0
    } else {
      idx = 0; fresh = 0
    }
  } catch {
    if (!deals.length) { put(2, 'body', 'No connection to the deal feed.\nRetrying...'); return }
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
  if (!token) { startPairing(); return }
  toast('Sending to Telegram...', 4000)
  try {
    const r = await fetch(`${API}/send`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, item: d }),
    })
    if (r.status === 403) { token = ''; localStorage.removeItem(TOKEN_KEY); toast('Link expired. Tap to link again.'); return }
    toast(r.ok ? `Sent: ${d.title} #${d.num} -> Telegram` : 'Could not send. Tap to retry.')
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
