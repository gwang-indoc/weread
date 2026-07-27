/**
 * Exporting one Book to one PDF.
 *
 * Orchestrates the verified pieces: read the 目录, walk each Chapter capturing
 * canvas columns, cache as we go, then typeset the cache. Chapters are recorded
 * the moment they finish, so an interrupted run resumes rather than restarts.
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserContext, Page } from 'playwright-core'
import type { Book, Chapter } from './types.ts'
import { readToc, gotoChapter, closeToc } from './bookshelf.ts'
import { walkChapter, ensureLightTheme, restoreDarkTheme } from './capture.ts'
import {
  initMeta,
  isChapterDone,
  recordChapter,
  saveScreen,
  writeMeta,
  clearBook,
  type BookMeta,
  type ChapterStatus,
} from './cache.ts'
import { renderPdf } from './render.ts'

/** Wording WeRead shows when the account cannot read further. */
const PAYWALL_MARKERS = ['试读结束', '购买本书', '开通会员', '付费会员', '限时免费', '加入书架继续阅读']

export interface ExportOptions {
  outDir: string
  /** Restrict to these TOC indices. Omit for the whole book. */
  onlyChapters?: number[]
  force?: boolean
  /** Cap screens per chapter. Mainly useful for quick end-to-end checks. */
  maxScreensPerChapter?: number
  onProgress?: (msg: string) => void
}

export interface ExportResult {
  pdfPath: string
  chaptersCaptured: number
  chaptersSkipped: number
  problems: Array<{ chapter: Chapter; status: ChapterStatus; note?: string }>
}

async function detectAccessProblem(page: Page): Promise<string | null> {
  const text = await page.evaluate(() => document.body?.innerText ?? '')
  const hit = PAYWALL_MARKERS.find((m) => text.includes(m))
  return hit ?? null
}

/**
 * Which TOC entries to walk.
 *
 * The running header stays constant across a chapter's 节, and the walk stops
 * only when it changes — so starting at a level-1 entry already captures all of
 * its level-2 subsections. Walking the 节 as well would duplicate every page.
 * Level-2 entries are therefore navigation targets, not capture units.
 */
export function isCaptureUnit(chapters: Chapter[], index: number): boolean {
  return chapters[index]?.level === 1
}

export async function exportBook(ctx: BrowserContext, book: Book, opts: ExportOptions): Promise<ExportResult> {
  const { outDir, onlyChapters, force = false, maxScreensPerChapter, onProgress = () => {} } = opts
  await mkdir(outDir, { recursive: true })
  if (force) await clearBook(book.id)

  const page = await ctx.newPage()
  const problems: ExportResult['problems'] = []
  let captured = 0
  let skipped = 0
  let meta: BookMeta
  let themeChanged = false

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

    // An explicit chapter list is honoured as given; otherwise walk the
    // level-1 units, which subsume their 节.
    const targets = chapters
      .map((c) => c.index)
      .filter((i) => (onlyChapters ? onlyChapters.includes(i) : isCaptureUnit(chapters, i)))

    for (const index of targets) {
      const chapter = chapters[index]
      if (!force && isChapterDone(meta, index)) {
        skipped++
        onProgress(`跳过 ${index}. ${chapter.title}（已缓存）`)
        continue
      }

      onProgress(`抓取 ${index}. ${chapter.title}`)
      await gotoChapter(page, index)
      await closeToc(page)

      const files: string[] = []
      let result
      try {
        result = await walkChapter(page, {
          ...(maxScreensPerChapter ? { maxScreens: maxScreensPerChapter } : {}),
          onScreen: async (screen, screenIndex) => {
            files.push(...(await saveScreen(book.id, index, screenIndex, screen)))
          },
        })
      } catch (e) {
        recordChapter(meta, {
          index,
          title: chapter.title,
          level: chapter.level,
          status: 'failed',
          screens: 0,
          files,
          note: (e as Error).message.split('\n')[0],
        })
        problems.push({ chapter, status: 'failed', note: (e as Error).message.split('\n')[0] })
        await writeMeta(meta)
        continue
      }

      let status: ChapterStatus = result.screenCount > 0 ? 'complete' : 'empty'
      let note: string | undefined = result.stoppedBecause
      if (result.screenCount === 0) {
        const paywall = await detectAccessProblem(page)
        if (paywall) {
          status = 'unauthorized'
          note = paywall
        }
      }

      recordChapter(meta, { index, title: chapter.title, level: chapter.level, status, screens: result.screenCount, files, stoppedBecause: result.stoppedBecause, note })
      await writeMeta(meta)

      if (status === 'complete') {
        captured++
        onProgress(`  ✓ ${result.screenCount} 屏 / ${files.length} 页（${result.stoppedBecause}）`)
      } else {
        problems.push({ chapter, status, note })
        onProgress(`  ⚠ ${status}${note ? `：${note}` : ''}`)
      }
    }
  } finally {
    // Leave the user's reader as we found it.
    if (themeChanged) await restoreDarkTheme(page).catch(() => {})
    await page.close()
  }

  const safeTitle = book.title.replace(/[/\\:*?"<>|]/g, '_').slice(0, 80)
  const pdfPath = join(outDir, `${safeTitle}.pdf`)
  onProgress(`排版 PDF → ${pdfPath}`)
  await renderPdf(ctx, meta, pdfPath, { author: undefined })

  return { pdfPath, chaptersCaptured: captured, chaptersSkipped: skipped, problems }
}
