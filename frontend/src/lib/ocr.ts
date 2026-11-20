import type { BallotCandidate } from './types'

export interface SheetReading {
  votes: Record<string, number> // party code -> votes read from the sheet
  rejected?: number
  accredited?: number
  total?: number // printed total cast, used only to cross-check what was read
  lines: number
}

interface Word {
  text: string
  x0: number
  y0: number
  x1: number
  y1: number
}

/** Fix common OCR confusions inside number-like tokens (O→0, l/I→1, S→5, B→8). */
function toNumber(token: string): number | null {
  if (!/\d/.test(token)) return null // a lone "|" or "l" is a box edge, not a 1
  const fixed = token.replace(/[Oo]/g, '0').replace(/[lI|]/g, '1').replace(/S/g, '5').replace(/B/g, '8').replace(/[,.\s]/g, '')
  return /^\d{1,6}$/.test(fixed) ? Number(fixed) : null
}

/** Text-only parser (e.g. typed sheets where figures sit on the same line as the label). */
export function parseSheet(text: string, candidates: BallotCandidate[]): SheetReading {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const last = (line: string) => {
    for (const t of line.split(/\s+/).reverse()) {
      const n = toNumber(t.replace(/[^0-9OoIlSB|,.]/g, ''))
      if (n !== null) return n
    }
    return undefined
  }
  const reading: SheetReading = { votes: {}, lines: lines.length }
  for (const c of candidates) {
    const re = new RegExp(`(^|[^A-Z])${c.party_code}([^A-Z]|$)`)
    const line = lines.find((l) => re.test(l.toUpperCase()) || l.toLowerCase().includes(c.party_name.toLowerCase()))
    const n = line ? last(line) : undefined
    if (n !== undefined) reading.votes[c.party_code] = n
  }
  const pick = (re: RegExp) => {
    const line = lines.find((l) => re.test(l))
    return line ? last(line) : undefined
  }
  reading.rejected = pick(/reject/i)
  reading.accredited = pick(/accredit/i)
  reading.total = pick(/total/i)
  return reading
}

async function toCanvas(file: Blob, maxSide = 2000): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
  const c = document.createElement('canvas')
  c.width = Math.round(bitmap.width * scale)
  c.height = Math.round(bitmap.height * scale)
  c.getContext('2d')!.drawImage(bitmap, 0, 0, c.width, c.height)
  bitmap.close()
  return c
}

/**
 * Crop the figure area of one row, binarise it, and erase long straight lines (box borders and
 * ruled lines) that otherwise hide handwritten or printed digits from the recogniser.
 */
function cleanCrop(src: HTMLCanvasElement, x: number, y: number, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  const scale = h < 60 ? 60 / h : 1 // small crops read better upscaled
  c.width = Math.max(1, Math.round(w * scale))
  c.height = Math.max(1, Math.round(h * scale))
  const g = c.getContext('2d', { willReadFrequently: true })!
  g.drawImage(src, x, y, w, h, 0, 0, c.width, c.height)
  const img = g.getImageData(0, 0, c.width, c.height)
  const d = img.data
  let sum = 0
  for (let i = 0; i < d.length; i += 4) sum += d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114
  const threshold = (sum / (d.length / 4)) * 0.72
  const dark = new Uint8Array(c.width * c.height)
  for (let i = 0, p = 0; i < d.length; i += 4, p++) dark[p] = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114 < threshold ? 1 : 0
  // Erase long straight runs of ink: box edges and ruled lines are long and thin, digits are not.
  const W = c.width
  const H = c.height
  const eraseRuns = (len: number, at: (i: number, j: number) => number, maxRun: number) => {
    for (let i = 0; i < len; i++) {
      let start = -1
      for (let j = 0; j <= (len === W ? H : W); j++) {
        const on = j < (len === W ? H : W) && dark[at(i, j)]
        if (on && start < 0) start = j
        if (!on && start >= 0) {
          if (j - start > maxRun) for (let k = start; k < j; k++) dark[at(i, k)] = 0
          start = -1
        }
      }
    }
  }
  eraseRuns(W, (x, y) => y * W + x, H * 0.5) // vertical runs taller than half the crop
  eraseRuns(H, (y, x) => y * W + x, Math.max(H * 1.2, 40)) // horizontal runs much wider than a digit
  // Drop leftover border fragments: a tilted sheet breaks box edges into short, hair-thin
  // segments that survive the run filter. Digits are compact blobs; fragments are not.
  const seen = new Uint8Array(W * H)
  const stack: number[] = []
  for (let start = 0; start < W * H; start++) {
    if (!dark[start] || seen[start]) continue
    const pixels: number[] = []
    let x0 = W, y0 = H, x1 = 0, y1 = 0
    stack.push(start)
    seen[start] = 1
    while (stack.length) {
      const p = stack.pop()!
      pixels.push(p)
      const px = p % W
      const py = (p - px) / W
      if (px < x0) x0 = px
      if (px > x1) x1 = px
      if (py < y0) y0 = py
      if (py > y1) y1 = py
      for (const q of [p - 1, p + 1, p - W, p + W, p - W - 1, p - W + 1, p + W - 1, p + W + 1]) {
        if (q < 0 || q >= W * H || seen[q] || !dark[q]) continue
        if (Math.abs((q % W) - px) > 1) continue // no wrap across rows
        seen[q] = 1
        stack.push(q)
      }
    }
    const w = x1 - x0 + 1
    const h = y1 - y0 + 1
    const thin = Math.min(w, h) <= Math.max(3, Math.round(H * 0.05))
    const sliver = Math.min(w, h) / Math.max(w, h) < 0.14
    const speck = pixels.length < Math.max(6, H * 0.08)
    // Frame remnants (L/U-shaped box corners) are large but hollow; digits are dense.
    const hollow = pixels.length / (w * h) < 0.12 && Math.max(w, h) > H * 0.6
    if (thin || sliver || speck || hollow) for (const p of pixels) dark[p] = 0
  }
  // Tight crop around the remaining ink: isolated figures read far better without empty space.
  let minX = c.width, minY = c.height, maxX = -1, maxY = -1
  for (let yy = 0; yy < c.height; yy++)
    for (let xx = 0; xx < c.width; xx++)
      if (dark[yy * c.width + xx]) {
        if (xx < minX) minX = xx
        if (xx > maxX) maxX = xx
        if (yy < minY) minY = yy
        if (yy > maxY) maxY = yy
      }
  const out = document.createElement('canvas')
  if (maxX < 0) {
    out.width = out.height = 1
    return out
  }
  const pad = 16
  out.width = maxX - minX + 1 + pad * 2
  out.height = maxY - minY + 1 + pad * 2
  const og = out.getContext('2d')!
  const oimg = og.createImageData(out.width, out.height)
  oimg.data.fill(255)
  for (let yy = minY; yy <= maxY; yy++)
    for (let xx = minX; xx <= maxX; xx++)
      if (dark[yy * c.width + xx]) {
        const o = ((yy - minY + pad) * out.width + (xx - minX + pad)) * 4
        oimg.data[o] = oimg.data[o + 1] = oimg.data[o + 2] = 0
      }
  og.putImageData(oimg, 0, 0)
  return out
}

/**
 * On-device OCR of a result sheet. Pass 1 finds the row labels (party codes, "Rejected",
 * "Accredited", "Total"); pass 2 reads each row's figure area as digits. Tesseract loads lazily.
 */
export async function readSheet(file: Blob, candidates: BallotCandidate[], onProgress?: (p: number) => void): Promise<SheetReading> {
  const { createWorker, PSM } = await import('tesseract.js')
  const canvas = await toCanvas(file)
  const worker = await createWorker('eng')
  try {
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT })
    const { data } = await worker.recognize(canvas, {}, { blocks: true, text: true })
    onProgress?.(0.35)
    const words: Word[] = []
    for (const b of data.blocks ?? []) for (const p of b.paragraphs) for (const l of p.lines) for (const w of l.words) words.push({ text: w.text, ...w.bbox })

    // Typed sheets: figures already on the label's line.
    const reading = parseSheet(data.text, candidates)

    const targets: { key: string; match: (t: string) => boolean }[] = [
      ...candidates.map((c) => ({ key: c.party_code, match: (t: string) => t.toUpperCase().replace(/[^A-Z]/g, '') === c.party_code })),
      { key: 'rejected', match: (t: string) => /reject/i.test(t) },
      { key: 'accredited', match: (t: string) => /accredit/i.test(t) },
      { key: 'total', match: (t: string) => /total/i.test(t) },
    ]
    const has = (key: string) =>
      key === 'rejected' ? reading.rejected !== undefined : key === 'accredited' ? reading.accredited !== undefined : key === 'total' ? reading.total !== undefined : reading.votes[key] !== undefined
    const pending = targets.filter((t) => !has(t.key))

    await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE, tessedit_char_whitelist: '0123456789' })
    for (const [i, target] of pending.entries()) {
      const label = words.find((w) => target.match(w.text))
      if (!label) continue
      const rowH = label.y1 - label.y0
      const y = Math.max(0, Math.round(label.y0 - rowH * 0.9))
      const h = Math.min(canvas.height - y, Math.round(rowH * 2.8))
      const x = Math.round(Math.min(canvas.width - 10, label.x1 + canvas.width * 0.02))
      const crop = cleanCrop(canvas, x, y, canvas.width - x, h)
      if (crop.width < 4) continue
      let { data: row } = await worker.recognize(crop)
      // Single-digit cells (e.g. rejected ballots) often read better as one word or character.
      for (const mode of [PSM.SINGLE_WORD, PSM.SINGLE_BLOCK, PSM.SINGLE_CHAR]) {
        if (/\d/.test(row.text)) break
        await worker.setParameters({ tessedit_pageseg_mode: mode })
        ;({ data: row } = await worker.recognize(crop))
      }
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE })
      const digits = (row.text.match(/\d+/g) ?? []).sort((a, b) => b.length - a.length)[0]
      if (digits && digits.length <= 6) {
        const n = Number(digits)
        if (target.key === 'rejected') reading.rejected = n
        else if (target.key === 'accredited') reading.accredited = n
        else if (target.key === 'total') reading.total = n
        else reading.votes[target.key] = n
      }
      onProgress?.(0.35 + (0.65 * (i + 1)) / pending.length)
    }
    return reading
  } finally {
    await worker.terminate()
  }
}
