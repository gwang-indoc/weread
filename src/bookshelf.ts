/**
 * Reading the 书架 and a book's 目录.
 *
 * Selectors here are the ones the spike verified. TOC <li> elements carry no
 * chapterUid or href, so a Chapter is identified by its index in the list and
 * navigated by clicking its title element.
 */
import type { BrowserContext, Page } from 'playwright-core'
import type { Book, Chapter } from './types.ts'
import { SHELF_URL } from './session.ts'

const TOC_BUTTON = 'button[title="目录"]'
const TOC_LIST = '.readerCatalog_list'
const TOC_ITEM = '.readerCatalog_list_item'
const TOC_ITEM_TITLE = '.readerCatalog_list_item_title_text'

/** The id WeRead embeds in a reader URL, used as the cache key for a Book. */
export function bookIdFromUrl(url: string): string {
  return /\/web\/reader\/([^/?#]+)/.exec(url)?.[1] ?? url
}

export async function listBooks(ctx: BrowserContext): Promise<Book[]> {
  const page = await ctx.newPage()
  try {
    await page.goto(SHELF_URL, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('a[href*="/web/reader/"]', { timeout: 20_000 })
    const raw = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href*="/web/reader/"]')).map((a) => ({
        href: (a as HTMLAnchorElement).href,
        text: (a as HTMLElement).innerText.trim(),
      })),
    )
    const seen = new Set<string>()
    const books: Book[] = []
    for (const r of raw) {
      const id = bookIdFromUrl(r.href)
      if (seen.has(id) || !r.text) continue
      seen.add(id)
      books.push({ id, title: r.text, readerUrl: r.href })
    }
    return books
  } finally {
    await page.close()
  }
}

/** Resolve a user-supplied query to exactly one Book, or explain why not. */
export function resolveBook(books: Book[], query: string): Book {
  const exact = books.filter((b) => b.title === query || b.id === query)
  if (exact.length === 1) return exact[0]
  const partial = books.filter((b) => b.title.includes(query))
  if (partial.length === 1) return partial[0]
  if (partial.length === 0) throw new Error(`书架上找不到「${query}」`)
  throw new Error(`「${query}」匹配到 ${partial.length} 本书：${partial.map((b) => b.title).join('、')}`)
}

async function isTocOpen(page: Page): Promise<boolean> {
  const list = page.locator(TOC_LIST).first()
  if ((await list.count()) === 0) return false
  return list.isVisible().catch(() => false)
}

export async function openToc(page: Page): Promise<void> {
  if (await isTocOpen(page)) return
  await page.click(TOC_BUTTON, { timeout: 15_000 })
  await page.waitForSelector(TOC_ITEM, { timeout: 15_000 })
  // Let the panel finish auto-scrolling to the current chapter before anyone
  // clicks a row.
  await waitUntilStill(page.locator(TOC_ITEM).first())
}

/**
 * The TOC panel's backdrop is a full-viewport .wr_mask with pointer-events:auto,
 * so leaving it open makes every later click time out. Nine spike rounds lost
 * time to exactly this.
 */
export async function closeToc(page: Page): Promise<boolean> {
  for (const attempt of ['escape', 'button', 'corner'] as const) {
    if (!(await isTocOpen(page))) return true
    try {
      if (attempt === 'escape') await page.keyboard.press('Escape')
      else if (attempt === 'button') await page.click(TOC_BUTTON, { timeout: 3000 })
      else await page.mouse.click(120, 450)
      await page.waitForTimeout(1200)
    } catch {
      /* fall through to the next attempt */
    }
  }
  return !(await isTocOpen(page))
}

export async function readToc(page: Page): Promise<Chapter[]> {
  await openToc(page)
  return page.evaluate(
    ({ item, title }) =>
      Array.from(document.querySelectorAll(item)).map((el, index) => {
        const inner = el.querySelector('[class*="readerCatalog_list_item_inner"]')
        const cls = inner && typeof inner.className === 'string' ? inner.className : ''
        const titleEl = el.querySelector(title)
        return {
          index,
          level: Number(/level_(\d)/.exec(cls)?.[1] ?? 1),
          title: ((titleEl as HTMLElement)?.innerText ?? (el as HTMLElement).innerText ?? '').trim(),
        }
      }),
    { item: TOC_ITEM, title: TOC_ITEM_TITLE },
  )
}

/**
 * Wait until a locator has stopped moving.
 *
 * The 目录 panel auto-scrolls to the current chapter when it opens. Clicking
 * during that animation lands on whichever row slid under the pointer — which
 * is how navigating to 牛顿的家族 ended up on 第一章 离弃, silently capturing the
 * wrong unit.
 */
async function waitUntilStill(locator: ReturnType<Page['locator']>, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let previous: string | null = null
  while (Date.now() < deadline) {
    const box = await locator.boundingBox().catch(() => null)
    const current = box ? `${Math.round(box.x)},${Math.round(box.y)}` : null
    if (current && current === previous) return
    previous = current
    await locator.page().waitForTimeout(250)
  }
}

/**
 * Navigate to a Chapter by clicking its title, then clear the TOC backdrop.
 *
 * Returns the title text actually clicked, so the caller can tell whether the
 * reader honoured it — a click that lands on the wrong row must not pass for
 * success.
 */
export async function gotoChapter(page: Page, index: number): Promise<string> {
  await openToc(page)
  const item = page.locator(TOC_ITEM).nth(index)
  const titleEl = item.locator(TOC_ITEM_TITLE)
  const target = (await titleEl.count()) > 0 ? titleEl : item

  await target.scrollIntoViewIfNeeded({ timeout: 10_000 }).catch(() => {})
  await waitUntilStill(target)
  const clickedTitle = (await target.innerText().catch(() => '')).trim()

  await target.click({ timeout: 10_000 })
  await page.waitForTimeout(1500)
  await closeToc(page)
  return clickedTitle
}
