/**
 * Capturing what the reader paints.
 *
 * WeRead's web reader renders chapter prose to two <canvas> elements — one per
 * displayed column — and never puts that text in the DOM. Nine spike rounds
 * confirmed this: a sentence plainly visible on screen has zero holders
 * anywhere in the document. So the canvas pixels ARE the book, and capture is
 * the only faithful read path.
 *
 * The running header (chapter title) IS real DOM text sitting above the canvas,
 * which is what makes chapter boundaries detectable.
 */
import { createHash } from 'node:crypto'
import type { Page } from 'playwright-core'

/** A canvas smaller than this is a UI flourish, not a prose column. */
const MIN_COLUMN_WIDTH = 150
const MIN_COLUMN_HEIGHT = 300

/** Where the running header sits, relative to the reader card. */
const HEADER_BAND = { top: 90, bottom: 152, left: 140, right: 760 }

export interface ColumnCapture {
  /** 0 for the left column, 1 for the right. */
  column: number
  png: Buffer
  /** Content hash, used to detect that pagination did not advance. */
  hash: string
  width: number
  height: number
}

export interface ScreenCapture {
  header: string | null
  columns: ColumnCapture[]
  signature: string
}

interface CanvasBox {
  index: number
  x: number
  y: number
  width: number
  height: number
}

function hashOf(buf: Buffer): string {
  return createHash('sha1').update(buf).digest('hex').slice(0, 16)
}

/** Locate the prose column canvases, ordered left to right. */
export async function findColumns(page: Page): Promise<CanvasBox[]> {
  const boxes = await page.evaluate(
    ({ minW, minH }) =>
      Array.from(document.querySelectorAll('canvas'))
        .map((c, index) => {
          const r = c.getBoundingClientRect()
          return { index, x: r.left, y: r.top, width: r.width, height: r.height }
        })
        .filter((b) => b.width >= minW && b.height >= minH),
    { minW: MIN_COLUMN_WIDTH, minH: MIN_COLUMN_HEIGHT },
  )
  return boxes.sort((a, b) => a.x - b.x)
}

/**
 * Read the running header. Uses Range rects over text nodes because element
 * rects lie about clipped text, and restricts to the header band so body
 * chrome cannot be mistaken for a chapter title.
 */
export async function readHeader(page: Page): Promise<string | null> {
  return page.evaluate((band) => {
    const found: Array<{ text: string; y: number }> = []
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode
      const text = (node.nodeValue ?? '').replace(/\s+/g, ' ').trim()
      if (!text || text.length > 80) continue
      const parent = node.parentElement
      if (!parent) continue
      const cs = getComputedStyle(parent)
      if (cs.display === 'none' || cs.visibility === 'hidden') continue
      const range = document.createRange()
      range.selectNodeContents(node)
      const r = range.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) continue
      if (r.top < band.top || r.top > band.bottom) continue
      if (r.left < band.left || r.left > band.right) continue
      found.push({ text, y: r.top })
    }
    if (!found.length) return null
    found.sort((a, b) => a.y - b.y || b.text.length - a.text.length)
    return found[0].text
  }, HEADER_BAND)
}

const HIDE_STYLE_ID = 'wr-export-hide-chrome'

/**
 * Hide reader chrome that overlays the columns.
 *
 * `visibility: hidden` rather than `display: none` on purpose — removing these
 * from layout could reflow the columns and change where pages break, which
 * would corrupt the capture mid-walk.
 */
async function setChromeHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate(
    ({ id, hidden }) => {
      const existing = document.getElementById(id)
      if (!hidden) {
        existing?.remove()
        for (const el of Array.from(document.querySelectorAll('[data-wr-export-hide]')))
          el.removeAttribute('data-wr-export-hide')
        return
      }
      if (existing) return

      // The membership banner ("你正在使用会员卡阅读付费部分") sits above the
      // columns and has no stable class, so it is matched by its wording. The
      // length guard keeps this from catching prose that merely mentions 会员.
      for (const el of Array.from(document.querySelectorAll('div, span, p'))) {
        const text = (el.textContent ?? '').trim()
        if (text.length > 0 && text.length < 40 && /会员卡阅读|付费部分/.test(text)) {
          el.setAttribute('data-wr-export-hide', '1')
        }
      }
      const style = document.createElement('style')
      style.id = id
      // wr_underline_* are other readers' 划线, drawn as positioned overlays
      // rather than painted into the canvas — so they can be left out of the
      // Export, which is meant to be a clean copy of the book.
      style.textContent = `
        [class*="renderTarget_pager"],
        [class*="float_corner_bookmark"],
        [class*="wr_underline"],
        [data-wr-export-hide] { visibility: hidden !important; }
      `
      document.head.appendChild(style)
    },
    { id: HIDE_STYLE_ID, hidden },
  )
}

/** True when the reader is currently painting in its light theme. */
export async function isLightTheme(page: Page): Promise<boolean> {
  return page.evaluate(() => document.body.classList.contains('wr_whiteTheme'))
}

/**
 * Switch the reader to its light theme.
 *
 * Necessary because prose is canvas-painted: a dark reader produces a dark PDF
 * and no amount of CSS on our side can invert it without wrecking the coloured
 * headings. Returns true if the theme was changed, so the caller can put the
 * reader back the way the user had it.
 */
export async function ensureLightTheme(page: Page): Promise<boolean> {
  if (await isLightTheme(page)) return false
  const toggle = page.locator('.readerControls_item.white').first()
  if ((await toggle.count()) === 0) return false
  await toggle.click({ timeout: 8000 })
  await page.waitForTimeout(2500)
  return await isLightTheme(page)
}

/** Put the theme back to dark, for when we changed it. */
export async function restoreDarkTheme(page: Page): Promise<void> {
  if (!(await isLightTheme(page))) return
  const toggle = page.locator('.readerControls_item.white').first()
  if ((await toggle.count()) === 0) return
  await toggle.click({ timeout: 8000 }).catch(() => {})
  await page.waitForTimeout(1500)
}

/**
 * The unit-identifying suffix WeRead appends to a reader URL.
 *
 * WeRead addresses every TOC entry — 章 *and* 节 — as its own unit with its own
 * key, and the key changes exactly when the reader crosses into the next one.
 * That makes it the boundary signal. The running header is only a label: it
 * shows the current 节, so treating a header change as a chapter change stops a
 * walk two screens in.
 */
export function chapterKeyOf(url: string): string {
  return /\/web\/reader\/[^/?#]*?(k[0-9a-f]{8,})/.exec(url)?.[1] ?? ''
}

/**
 * Wait until the reader has settled on a unit: a stable, non-empty URL key with
 * rendered columns.
 *
 * Without this the first screen after navigation can still belong to the
 * previous unit, which made a walk compare against a stale start key and stop
 * immediately.
 */
export async function waitForSettled(page: Page, timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let previous = ''
  while (Date.now() < deadline) {
    const key = chapterKeyOf(page.url())
    if (key && key === previous && (await findColumns(page)).length > 0) return key
    previous = key
    await page.waitForTimeout(800)
  }
  return chapterKeyOf(page.url())
}

/** Wait until both prose columns exist and have non-trivial size. */
export async function waitForColumns(page: Page, timeoutMs = 45_000): Promise<CanvasBox[]> {
  const deadline = Date.now() + timeoutMs
  let last: CanvasBox[] = []
  while (Date.now() < deadline) {
    last = await findColumns(page)
    if (last.length >= 1) return last
    await page.waitForTimeout(700)
  }
  return last
}

/**
 * Screenshot each column.
 *
 * Element screenshots rather than canvas.toDataURL(): the canvas draws
 * cross-origin illustrations from res.weread.qq.com, which taints it and makes
 * toDataURL throw. A screenshot is immune and honours deviceScaleFactor, so
 * capture resolution is controlled by the browser context.
 */
export async function captureScreen(page: Page): Promise<ScreenCapture> {
  const boxes = await waitForColumns(page)
  const header = await readHeader(page)
  const canvases = page.locator('canvas')
  const columns: ColumnCapture[] = []

  // An element screenshot includes whatever is painted over that element, so
  // the pager buttons would otherwise be baked into the page image.
  await setChromeHidden(page, true)
  try {
    for (const [ordinal, box] of boxes.entries()) {
      let png: Buffer
      try {
        png = await canvases.nth(box.index).screenshot({ timeout: 15_000 })
      } catch {
        continue // column vanished mid-capture; the walk will retry
      }
      columns.push({ column: ordinal, png, hash: hashOf(png), width: box.width, height: box.height })
    }
  } finally {
    await setChromeHidden(page, false)
  }

  return {
    header,
    columns,
    signature: columns.map((c) => c.hash).join('-') || 'empty',
  }
}

export interface WalkOptions {
  maxScreens?: number
  /** Conservative pacing: traffic should look like a person reading, not a bot. */
  minDelayMs?: number
  maxDelayMs?: number
  onScreen?: (screen: ScreenCapture, index: number) => Promise<void> | void
}

export interface BookWalkOptions extends WalkOptions {
  /** Column hashes already cached, so a resumed walk re-pages without re-storing. */
  known?: Set<string>
  onProgress?: (msg: string) => void
}

export interface BookWalkResult {
  /** Screens seen, including ones skipped as already known. */
  screensSeen: number
  /** Screens handed to onScreen, i.e. new ones. */
  screensNew: number
  stoppedBecause: string
}

/**
 * Did the walk stop because 下一页 stopped taking it anywhere?
 *
 * Three different `stoppedBecause` reasons mean this, and *all three* are also
 * how the last page of a book presents itself:
 *
 * - `end of book (screen repeated)` — the click lands, the same pixels come back
 * - `下一页 not clickable` — the control is there but refuses the click
 * - `no 下一页 control` — it is not in the DOM at all
 *
 * Only the 目录 can tell the end of a book from a stalled reader (see
 * `looksTruncated`), so the three are grouped here rather than being handled one
 * at a time. They are grouped in this file because this is where the strings are
 * produced; matching them from elsewhere is how the second and third came to be
 * treated as failures for as long as they were.
 *
 * `no canvas columns rendered` is deliberately *not* one of them: that is the
 * reader failing to paint after six attempts, which says nothing about whether
 * pages remain.
 */
export function pageTurnExhausted(stoppedBecause: string): boolean {
  return (
    stoppedBecause.startsWith('end of book') ||
    stoppedBecause === '下一页 not clickable' ||
    stoppedBecause === 'no 下一页 control'
  )
}

/**
 * Walk the whole book forward from the current position, capturing every screen.
 *
 * There is deliberately no chapter boundary here. 节 can start partway down a
 * page, so pages cannot be partitioned per chapter — walking unit-by-unit either
 * lost pages or repeated them. A single linear pass cannot do either.
 *
 * Stops when a screen repeats, which is how the reader behaves at the end of the
 * book: 下一页 stops advancing and the same pixels come back.
 */
export async function walkBook(page: Page, opts: BookWalkOptions = {}): Promise<BookWalkResult> {
  const { maxScreens = 3000, minDelayMs = 1000, maxDelayMs = 3000, onScreen, known, onProgress } = opts

  const seenThisRun = new Set<string>()
  let seen = 0
  let fresh = 0
  let misses = 0

  for (let i = 0; i < maxScreens + misses; i++) {
    const screen = await captureScreen(page)

    // Front matter — 扉页, 版权信息, the flyleaf — is rendered as ordinary DOM
    // rather than painted to canvas, so it has no columns to capture. Those
    // pages are not the book's prose and are skipped rather than treated as a
    // failure; only a run of them means the reader really is stuck.
    if (!screen.columns.length) {
      misses++
      if (misses > 6) {
        return { screensSeen: seen, screensNew: fresh, stoppedBecause: 'no canvas columns rendered' }
      }
      onProgress?.(`跳过无正文页（${misses}）· ${screen.header ?? ''}`)
      const skipNext = page.locator('text=下一页').first()
      if ((await skipNext.count()) === 0) {
        return { screensSeen: seen, screensNew: fresh, stoppedBecause: 'no 下一页 control' }
      }
      try {
        await skipNext.click({ timeout: 8000 })
      } catch {
        return { screensSeen: seen, screensNew: fresh, stoppedBecause: '下一页 not clickable' }
      }
      await page.waitForTimeout(1500)
      continue
    }
    misses = 0
    // A screen we already captured *this run* means pagination stopped moving.
    if (seenThisRun.has(screen.signature)) {
      return { screensSeen: seen, screensNew: fresh, stoppedBecause: 'end of book (screen repeated)' }
    }
    seenThisRun.add(screen.signature)
    seen++

    const alreadyCached = known?.has(screen.columns[0]?.hash ?? '')
    if (!alreadyCached) {
      await onScreen?.(screen, i)
      fresh++
    }
    if (seen % 25 === 0) onProgress?.(`已翻 ${seen} 屏（新增 ${fresh}）· ${screen.header ?? ''}`)

    await page.waitForTimeout(minDelayMs + Math.floor(Math.random() * (maxDelayMs - minDelayMs)))

    const next = page.locator('text=下一页').first()
    if ((await next.count()) === 0) {
      return { screensSeen: seen, screensNew: fresh, stoppedBecause: 'no 下一页 control' }
    }
    try {
      await next.click({ timeout: 8000 })
    } catch {
      return { screensSeen: seen, screensNew: fresh, stoppedBecause: '下一页 not clickable' }
    }
    await page.waitForTimeout(1200)
  }
  return { screensSeen: seen, screensNew: fresh, stoppedBecause: `hit maxScreens=${maxScreens}` }
}

export interface WalkResult {
  screenCount: number
  stoppedBecause: string
  /** Running header seen when the walk began — a label, not an identity. */
  header: string | null
  /** URL key of the unit that was captured. */
  key: string
}

/**
 * Capture one unit by paging forward until it ends.
 *
 * The boundary is the running header, which names the current 节 and therefore
 * changes exactly at a unit boundary. The URL key is recorded for diagnostics
 * but is NOT used as the boundary: it lags behind the display and is sometimes
 * absent entirely, which made walks stop on a stale value.
 *
 * A repeated capture means the end of the book, where 下一页 stops advancing.
 */
export async function walkChapter(page: Page, opts: WalkOptions = {}): Promise<WalkResult> {
  const { maxScreens = 400, minDelayMs = 1000, maxDelayMs = 3000, onScreen } = opts

  const first = await captureScreen(page)
  const startKey = chapterKeyOf(page.url())
  if (!first.columns.length) {
    return { screenCount: 0, stoppedBecause: 'no canvas columns rendered', header: first.header, key: startKey }
  }

  const startHeader = first.header
  const seen = new Set<string>([first.signature])
  await onScreen?.(first, 0)
  let count = 1

  for (let i = 1; i < maxScreens; i++) {
    // Randomised pause between page turns.
    await page.waitForTimeout(minDelayMs + Math.floor(Math.random() * (maxDelayMs - minDelayMs)))

    const next = page.locator('text=下一页').first()
    if ((await next.count()) === 0) {
      return { screenCount: count, stoppedBecause: 'no 下一页 control', header: startHeader, key: startKey }
    }
    try {
      await next.click({ timeout: 8000 })
    } catch {
      return { screenCount: count, stoppedBecause: '下一页 not clickable', header: startHeader, key: startKey }
    }
    await page.waitForTimeout(1200)

    const screen = await captureScreen(page)
    if (!screen.columns.length) {
      return { screenCount: count, stoppedBecause: 'blank screen', header: startHeader, key: startKey }
    }
    if (seen.has(screen.signature)) {
      return { screenCount: count, stoppedBecause: 'end of book (screen repeated)', header: startHeader, key: startKey }
    }
    if (startHeader && screen.header && screen.header !== startHeader) {
      return { screenCount: count, stoppedBecause: `next unit (${screen.header})`, header: startHeader, key: startKey }
    }

    seen.add(screen.signature)
    await onScreen?.(screen, i)
    count++
  }
  return { screenCount: count, stoppedBecause: `hit maxScreens=${maxScreens}`, header: startHeader, key: startKey }
}
