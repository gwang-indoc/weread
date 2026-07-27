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

export interface WalkResult {
  screenCount: number
  stoppedBecause: string
  /** Header seen when the walk began, i.e. the chapter we were capturing. */
  header: string | null
}

/**
 * Capture a chapter by paging forward until it ends.
 *
 * Stops when the running header changes (we have crossed into the next
 * chapter, so that screen is not ours) or when a capture repeats (pagination
 * refused to advance, i.e. end of book).
 */
export async function walkChapter(page: Page, opts: WalkOptions = {}): Promise<WalkResult> {
  const { maxScreens = 400, minDelayMs = 1000, maxDelayMs = 3000, onScreen } = opts

  const first = await captureScreen(page)
  if (!first.columns.length) return { screenCount: 0, stoppedBecause: 'no canvas columns rendered', header: first.header }

  const startHeader = first.header
  const seen = new Set<string>([first.signature])
  await onScreen?.(first, 0)
  let count = 1

  for (let i = 1; i < maxScreens; i++) {
    // Randomised pause between page turns.
    await page.waitForTimeout(minDelayMs + Math.floor(Math.random() * (maxDelayMs - minDelayMs)))

    const next = page.locator('text=下一页').first()
    if ((await next.count()) === 0) return { screenCount: count, stoppedBecause: 'no 下一页 control', header: startHeader }
    try {
      await next.click({ timeout: 8000 })
    } catch {
      return { screenCount: count, stoppedBecause: '下一页 not clickable', header: startHeader }
    }
    await page.waitForTimeout(1200)

    const screen = await captureScreen(page)
    if (!screen.columns.length) return { screenCount: count, stoppedBecause: 'blank screen', header: startHeader }
    if (seen.has(screen.signature)) return { screenCount: count, stoppedBecause: 'end of book (screen repeated)', header: startHeader }
    if (startHeader && screen.header && screen.header !== startHeader) {
      return { screenCount: count, stoppedBecause: `next chapter (${screen.header})`, header: startHeader }
    }

    seen.add(screen.signature)
    await onScreen?.(screen, i)
    count++
  }
  return { screenCount: count, stoppedBecause: `hit maxScreens=${maxScreens}`, header: startHeader }
}
