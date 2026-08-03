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
  /** deviceScaleFactor in use, recorded so resumes can flag a change. */
  scale?: number
  /** Cap screens for a quick end-to-end check. */
  maxScreens?: number
  /**
   * Typeset the PDF after capture. Off when the caller only wants an EPUB, so
   * `--format epub` does not also write hundreds of megabytes nobody asked for.
   */
  renderPdf?: boolean
  /**
   * Rest this long after an interruption, then reload the reader and carry on.
   * 0 disables retrying, which is the old single-pass behaviour.
   */
  retryDelayMs?: number
  /** Total walks, including the first. A backstop against looping forever. */
  maxAttempts?: number
  onProgress?: (msg: string) => void
}

/**
 * Warn when a resume would append pages at a different capture resolution than
 * the ones already cached.
 *
 * Not an error — the PDF scales every column to the page, so a mixed-resolution
 * book is readable — but it is a silent quality inconsistency otherwise, and
 * this project's rule is that nothing uneven about an export is left implicit.
 *
 * Call only when screens are already cached. `previous` being undefined then
 * means the cache predates this field, which is the riskiest case rather than a
 * safe one: those screens were captured when the default was 3.
 */
export function scaleChangeWarning(previous: number | undefined, current: number): string | null {
  if (previous === current) return null
  if (previous === undefined) {
    return `已缓存的页面没有记录分辨率（早于该字段，很可能是 --scale 3），本次是 ${current}；续抓会混入不同分辨率。要统一请加 --force 重抓（会丢弃已有缓存）`
  }
  return `已缓存的页面是 --scale ${previous} 抓的，本次是 ${current}；续抓会混入不同分辨率。要统一请加 --force 重抓（会丢弃已有缓存）`
}

export interface ExportResult {
  /** Null when PDF typesetting was skipped. */
  pdfPath: string | null
  screensCaptured: number
  screensSkipped: number
  outcome: WalkOutcome
  note?: string
  /** How many walks it took. More than one means the reader stalled and resumed. */
  attempts: number
}

/**
 * How many consecutive fruitless attempts before giving up.
 *
 * An attempt that captures nothing new has hit a wall that resting did not move.
 * One more try covers a second transient failure; beyond that it is waiting for
 * something that is not going to change.
 */
const FUTILE_LIMIT = 2

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Split a rest into chunks so the wait can report progress instead of looking
 * hung. Pure, and the invariant worth pinning is that the chunks sum to exactly
 * the requested time — this is the second arithmetic slip in this spot.
 */
export function restSchedule(totalMs: number, chunkMs = 60_000): number[] {
  const chunks: number[] = []
  for (let left = Math.max(0, totalMs); left > 0; left -= chunkMs) {
    chunks.push(Math.min(chunkMs, left))
  }
  return chunks
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

/**
 * How near the end of the 目录 counts as having reached the end of the book.
 *
 * There is slack because the last entries are often 版权信息 or a colophon, which
 * are DOM rather than canvas and so yield no columns and never become a header —
 * the walk legitimately ends a few entries short. Capped as a fraction of the 目录
 * as well, because three entries is under 4% of a 196-entry book but half of a
 * six-entry one, and being generous here is what silently passes a truncated book
 * off as complete.
 */
const END_TOLERANCE = 3

function endTolerance(entries: number): number {
  return Math.min(END_TOLERANCE, Math.max(1, Math.floor(entries / 4)))
}

/**
 * Did the walk stop short of the end of the book?
 *
 * This exists because "the end of the book" and "the page turn silently failed"
 * produce the *same* observation: 下一页 stops advancing and the same pixels come
 * back. `walkBook` reports both as `end of book (screen repeated)`, so taking that
 * at face value records a stalled reader as a complete export — and a retry that
 * waits for `interrupted` would then never fire.
 *
 * The 目录 breaks the tie, because we already know how long the book is. A repeat
 * while the last header seen is still far from the final entry is a stall.
 *
 * A header that is *not* in the 目录 returns false — treated as the end. Headers
 * lag and do not always correspond to an entry (ADR 0002), and `resumeIndex`
 * collapses an unknown header to 0, which would otherwise read as "we are at the
 * very beginning" and retry forever at a genuine end of book.
 */
export function looksTruncated(chapters: Chapter[], header: string | null): boolean {
  if (!chapters.length || !header) return false
  const found = chapters.findIndex((c) => sameTitle(c.title, header))
  if (found < 0) return false
  return found < chapters.length - endTolerance(chapters.length)
}

export async function exportBook(ctx: BrowserContext, book: Book, opts: ExportOptions): Promise<ExportResult> {
  const {
    outDir,
    force = false,
    scale = 2,
    maxScreens,
    renderPdf: wantPdf = true,
    retryDelayMs = 0,
    maxAttempts = 20,
    onProgress = () => {},
  } = opts
  await mkdir(outDir, { recursive: true })
  if (force) await clearBook(book.id)

  const page = await ctx.newPage()
  let meta: BookMeta
  let themeChanged = false
  let outcome: WalkOutcome = 'failed'
  let note: string | undefined
  let attempts = 0

  /**
   * Get to the resume point, reloading the reader first when asked.
   *
   * Later attempts reload on purpose: a stalled reader is most often fixed by
   * reloading it, which is the whole reason resting and retrying works at all. A
   * reload also resets the theme, so that is re-applied here.
   */
  const goToResumePoint = async (chapters: Chapter[], reload: boolean): Promise<number> => {
    if (reload) {
      await page.goto(book.readerUrl, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(6000)
      // A dark reader yields dark pixels, since the prose is painted.
      if (await ensureLightTheme(page)) themeChanged = true
    }
    const startAt = resumeIndex(chapters, lastHeader(meta))
    await gotoChapter(page, startAt)
    await closeToc(page)
    await waitForColumns(page)
    return startAt
  }

  try {
    onProgress(`打开《${book.title}》…`)
    await page.goto(book.readerUrl, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(6000)

    themeChanged = await ensureLightTheme(page)
    if (themeChanged) onProgress('已切换到浅色主题（导出结束后会切回）')

    const chapters = await readToc(page)
    await closeToc(page)
    onProgress(`目录 ${chapters.length} 项`)
    meta = await initMeta(book.id, book.title, chapters)

    if (meta.screens.length) {
      const warning = scaleChangeWarning(meta.scale, scale)
      if (warning) onProgress(`⚠ ${warning}`)
    }
    meta.scale = scale

    let futile = 0
    for (attempts = 1; attempts <= maxAttempts; attempts++) {
      // The reader is already loaded on the first pass; later ones reload it.
      const startAt = await goToResumePoint(chapters, attempts > 1)
      const where = `#${startAt} ${chapters[startAt]?.title ?? ''}`
      if (attempts > 1) onProgress(`第 ${attempts} 次尝试，从 ${where} 继续`)
      else if (meta.screens.length) onProgress(`已缓存 ${meta.screens.length} 屏，从 ${where} 续抓`)

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
      const gained = meta.screens.length - before
      onProgress(`共翻 ${result.screensSeen} 屏，新增 ${gained} 屏（${result.stoppedBecause}）`)

      // A repeated screen means 下一页 stopped advancing — which is how both the
      // end of the book and a stalled reader present. The 目录 tells them apart.
      const repeated = result.stoppedBecause.startsWith('end of book')
      const truncated = looksTruncated(chapters, lastHeader(meta))
      if (repeated && !truncated) {
        outcome = 'complete'
        note = undefined
      } else if (result.stoppedBecause.startsWith('hit maxScreens')) {
        outcome = 'interrupted'
        note = result.stoppedBecause
      } else {
        const paywall = await detectAccessProblem(page)
        outcome = paywall ? 'unauthorized' : 'interrupted'
        note = paywall ?? (repeated ? `翻页停在《${lastHeader(meta) ?? '?'}》，目录还没走完` : result.stoppedBecause)
      }
      meta.outcome = outcome
      meta.note = note
      await writeMeta(meta)

      // Done, or waiting will not help: a paywall does not lift in five minutes,
      // and --max-screens stopped us deliberately.
      if (outcome === 'complete' || outcome === 'unauthorized') break
      if (result.stoppedBecause.startsWith('hit maxScreens')) break
      if (retryDelayMs <= 0) break

      futile = gained > 0 ? 0 : futile + 1
      if (futile >= FUTILE_LIMIT) {
        onProgress(`连续 ${futile} 次没有抓到新内容，停止重试`)
        break
      }
      if (attempts >= maxAttempts) {
        onProgress(`已尝试 ${attempts} 次，达到上限`)
        break
      }

      onProgress(
        `⏸ 休息 ${Math.round(retryDelayMs / 60_000)} 分钟后继续` +
          `（已存 ${meta.screens.length} 屏，随时可 Ctrl-C，重跑会从缓存续上）`,
      )
      let remaining = retryDelayMs
      for (const chunk of restSchedule(retryDelayMs)) {
        await sleep(chunk)
        remaining -= chunk
        if (remaining > 0) onProgress(`   还有 ${Math.ceil(remaining / 60_000)} 分钟…`)
      }
    }
  } finally {
    // Leave the user's reader as we found it.
    if (themeChanged) await restoreDarkTheme(page).catch(() => {})
    await page.close()
  }

  const safeTitle = book.title.replace(/[/\\:*?"<>|]/g, '_').slice(0, 80)
  let pdfPath: string | null = null
  if (wantPdf) {
    pdfPath = join(outDir, `${safeTitle}.pdf`)
    onProgress(`排版 PDF → ${pdfPath}`)
    await renderPdf(ctx, meta, pdfPath)
  }

  return {
    pdfPath,
    screensCaptured: meta.screens.length,
    screensSkipped: 0,
    outcome,
    note,
    attempts,
  }
}

// Re-exported for the header-verification helper used by dev scripts.
export { readHeader }
