/**
 * Exporting one Book to one PDF.
 *
 * One linear pass: open the book at its first page and turn pages to the end,
 * caching every screen as it appears, then typeset the cache.
 *
 * It does NOT walk chapter by chapter. WeRead's 节 can begin partway down a
 * page, so pages do not partition cleanly per chapter: the running header lags
 * by up to a page, and clicking a 节 in the 目录 lands on the page where it
 * begins — which is often still headed by the previous 节. Per-chapter walking
 * therefore either skipped content (a 节 mistaken for "already covered") or
 * captured it twice. A linear pass can do neither.
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserContext, Page } from 'playwright-core'
import type { Book, Chapter } from './types.ts'
import { readToc, gotoChapter, closeToc } from './bookshelf.ts'
import { walkBook, ensureLightTheme, restoreDarkTheme, waitForColumns, readHeader } from './capture.ts'
import {
  initMeta,
  appendScreen,
  knownHashes,
  lastHeader,
  writeMeta,
  clearBook,
  type BookMeta,
  type WalkOutcome,
} from './cache.ts'
import { renderPdf } from './render.ts'

/** Wording WeRead shows when the account cannot read further. */
const PAYWALL_MARKERS = ['试读结束', '购买本书', '开通会员', '限时免费', '加入书架继续阅读']

export interface ExportOptions {
  outDir: string
  force?: boolean
  /** Cap screens for a quick end-to-end check. */
  maxScreens?: number
  onProgress?: (msg: string) => void
}

export interface ExportResult {
  pdfPath: string
  screensCaptured: number
  screensSkipped: number
  outcome: WalkOutcome
  note?: string
}

async function detectAccessProblem(page: Page): Promise<string | null> {
  const text = await page.evaluate(() => document.body?.innerText ?? '')
  return PAYWALL_MARKERS.find((m) => text.includes(m)) ?? null
}

/** TOC titles and running headers should match ignoring whitespace only. */
export function sameTitle(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, '')
  const left = norm(a)
  return left.length > 0 && left === norm(b)
}

/**
 * Pick where to start paging.
 *
 * A fresh run starts at the first 目录 entry. A resumed run aims at the entry
 * matching the last captured header, so it re-pages only a little before
 * reaching new ground — hash-based caching makes that overlap harmless.
 */
export function resumeIndex(chapters: Chapter[], header: string | null): number {
  if (!header) return 0
  const found = chapters.findIndex((c) => sameTitle(c.title, header))
  return found >= 0 ? found : 0
}

export async function exportBook(ctx: BrowserContext, book: Book, opts: ExportOptions): Promise<ExportResult> {
  const { outDir, force = false, maxScreens, onProgress = () => {} } = opts
  await mkdir(outDir, { recursive: true })
  if (force) await clearBook(book.id)

  const page = await ctx.newPage()
  let meta: BookMeta
  let themeChanged = false
  let outcome: WalkOutcome = 'failed'
  let note: string | undefined

  try {
    onProgress(`打开《${book.title}》…`)
    await page.goto(book.readerUrl, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(6000)

    // A dark reader yields a dark PDF, since the prose is canvas pixels.
    themeChanged = await ensureLightTheme(page)
    if (themeChanged) onProgress('已切换到浅色主题（导出结束后会切回）')

    const chapters = await readToc(page)
    await closeToc(page)
    onProgress(`目录 ${chapters.length} 项`)
    meta = await initMeta(book.id, book.title, chapters)

    const startAt = resumeIndex(chapters, lastHeader(meta))
    if (meta.screens.length) {
      onProgress(`已缓存 ${meta.screens.length} 屏，从 #${startAt} ${chapters[startAt]?.title ?? ''} 续抓`)
    }
    await gotoChapter(page, startAt)
    await closeToc(page)
    await waitForColumns(page)

    const before = meta.screens.length
    const result = await walkBook(page, {
      known: knownHashes(meta),
      ...(maxScreens ? { maxScreens } : {}),
      onProgress,
      onScreen: async (screen) => {
        await appendScreen(meta, screen)
        // Persist as we go: an interrupted run must keep what it captured.
        if (meta.screens.length % 10 === 0) await writeMeta(meta)
      },
    })

    onProgress(`共翻 ${result.screensSeen} 屏，新增 ${meta.screens.length - before} 屏（${result.stoppedBecause}）`)

    if (result.stoppedBecause.startsWith('end of book')) outcome = 'complete'
    else if (result.stoppedBecause.startsWith('hit maxScreens')) outcome = 'interrupted'
    else {
      const paywall = await detectAccessProblem(page)
      outcome = paywall ? 'unauthorized' : 'interrupted'
      note = paywall ?? result.stoppedBecause
    }
    meta.outcome = outcome
    meta.note = note
    await writeMeta(meta)
  } finally {
    // Leave the user's reader as we found it.
    if (themeChanged) await restoreDarkTheme(page).catch(() => {})
    await page.close()
  }

  const safeTitle = book.title.replace(/[/\\:*?"<>|]/g, '_').slice(0, 80)
  const pdfPath = join(outDir, `${safeTitle}.pdf`)
  onProgress(`排版 PDF → ${pdfPath}`)
  await renderPdf(ctx, meta, pdfPath)

  return {
    pdfPath,
    screensCaptured: meta.screens.length,
    screensSkipped: 0,
    outcome,
    note,
  }
}

// Re-exported for the header-verification helper used by dev scripts.
export { readHeader }
