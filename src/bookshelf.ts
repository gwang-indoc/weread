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

/** Navigate to a Chapter by clicking its title, then clear the TOC backdrop. */
export async function gotoChapter(page: Page, index: number): Promise<void> {
  await openToc(page)
  const item = page.locator(TOC_ITEM).nth(index)
  const title = item.locator(TOC_ITEM_TITLE)
  await (await title.count() > 0 ? title : item).click({ timeout: 10_000 })
  await page.waitForTimeout(1500)
  await closeToc(page)
}
