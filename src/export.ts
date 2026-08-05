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
import {
  walkBook,
  ensureLightTheme,
  restoreDarkTheme,
  waitForColumns,
  readHeader,
  pageTurnExhausted,
} from './capture.ts'
import {
  initMeta,
  appendScreen,
  knownHashes,
  lastHeader,
  headerTrail,
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
 * How far behind the current position a lagging header may still be naming.
 *
 * The lag is up to a page (ADR 0002), which spans at most a 节 or two of the 目录.
 * It has to stay small: the wider this window, the more a genuine arrival at a
 * repeated title reads as a lag and is ignored — which is the original bug, just
 * reached from the other side.
 */
const HEADER_LAG_ENTRIES = 2

/**
 * The furthest 目录 position the walk can be shown to have reached.
 *
 * Takes the whole trail of headers rather than just the last one, because a title
 * is not a unique key: a 目录 may list the same title twice. 《于是一片光明》 lists
 * its five chapter titles once for the prose and again under 参考文献, so
 * `第五章 新世纪` appears at both #8 and #15 of 17. Matching the last header alone
 * takes the *first* occurrence, which put a walk that had reached the references
 * back at #8 — reading as "less than half way" when it was one entry from the end.
 *
 * The trail resolves it because a walk is linear (ADR 0002): each header can only
 * be at or after where the previous one put us, so the same title later in the
 * book can only be the later occurrence. Matching forward-only also means a title
 * found solely *behind* the current position is no evidence of progress and never
 * moves the position backwards — headers lag the display by up to a page, so a
 * brief apparent rewind is normal and must not read as one.
 *
 * Returns -1 when no header matched any entry at all.
 */
export function reachedIndex(chapters: Chapter[], headers: readonly (string | null | undefined)[]): number {
  let at = -1
  for (const header of headers) {
    if (!header) continue

    // A header naming an entry just behind the current position is the lag, not a
    // rewind and not progress, so it is skipped rather than matched.
    //
    // This is not a nicety: scanning forward from `at` unconditionally is wrong in
    // exactly the case the trail exists to fix. A header repeating while the walk
    // sat still — 第一章, 第二章, 第一章, 第二章 across four screens, which is what a
    // lag looks like — finds no 第一章 ahead of #5, takes the *duplicate* at #11,
    // and lands the walk in the 参考文献 section it never reached. A test asserting
    // the position must not move backwards is what caught it.
    let lagging = false
    for (let i = Math.max(0, at - HEADER_LAG_ENTRIES); i <= at; i++) {
      if (sameTitle(chapters[i]?.title, header)) {
        lagging = true
        break
      }
    }
    if (lagging) continue

    const found = chapters.findIndex((c, i) => i > at && sameTitle(c.title, header))
    if (found >= 0) at = found
  }
  return at
}

/**
 * Pick where to start paging.
 *
 * A fresh run starts at the first 目录 entry. A resumed run aims at the entry the
 * trail of headers reached, so it re-pages only a little before reaching new
 * ground — hash-based caching makes that overlap harmless.
 */
export function resumeIndex(chapters: Chapter[], headers: readonly (string | null | undefined)[]): number {
  const at = reachedIndex(chapters, headers)
  return at >= 0 ? at : 0
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
 * produce the *same* observation: 下一页 stops advancing. `pageTurnExhausted`
 * lists the three ways that presents, and none of them distinguishes the two, so
 * taking any of them at face value records a stalled reader as a complete export
 * — and a retry that waits for `interrupted` would then never fire.
 *
 * The 目录 breaks the tie, because we already know how long the book is. A dead
 * page turn while the trail of headers is still far from the final entry is a
 * stall.
 *
 * No header matching the 目录 at all returns false — treated as the end. Headers
 * lag and do not always correspond to an entry (ADR 0002), and `resumeIndex`
 * collapses that case to 0, which would otherwise read as "we are at the very
 * beginning" and retry forever at a genuine end of book.
 */
export function looksTruncated(chapters: Chapter[], headers: readonly (string | null | undefined)[]): boolean {
  if (!chapters.length) return false
  const at = reachedIndex(chapters, headers)
  if (at < 0) return false
  if (at < chapters.length - endTolerance(chapters.length)) return true

  /**
   * The trail says the end was reached; require that the walk is still *there*.
   *
   * `reachedIndex` only ever moves forward, so one stray header latches it for the
   * rest of the book — and a 目录 is not always in physical order, so strays are
   * real. 《于是一片光明》 shows a 致谢 header at screen 645 as well as at 859, its
   * true position: 200 screens of references come after the first one. Taking the
   * furthest point alone, a reader that stalled anywhere after screen 645 would
   * have reported a complete book, which is the one failure this project refuses
   * to allow.
   *
   * So the last header has to be consistent with being at the end too — at or
   * after the reached entry, allowing for the lag. A last header that matches no
   * 目录 entry at all still reads as the end, for the reason above: headers do not
   * always correspond to entries, and guessing "truncated" retries forever at a
   * genuine end of book.
   */
  const last = [...headers].reverse().find((h) => !!h)
  if (!last) return false
  const matches = chapters.map((c, i) => (sameTitle(c.title, last) ? i : -1)).filter((i) => i >= 0)
  if (!matches.length) return false
  return !matches.some((i) => i >= at - HEADER_LAG_ENTRIES)
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
    const startAt = resumeIndex(chapters, headerTrail(meta))
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

      // 下一页 stopped advancing — which is how both the end of the book and a
      // stalled reader present, in any of three ways (`pageTurnExhausted`). The
      // 目录 tells them apart; the stop reason alone cannot.
      const exhausted = pageTurnExhausted(result.stoppedBecause)
      const truncated = looksTruncated(chapters, headerTrail(meta))
      if (exhausted && !truncated) {
        outcome = 'complete'
        note = undefined
      } else if (result.stoppedBecause.startsWith('hit maxScreens')) {
        outcome = 'interrupted'
        note = result.stoppedBecause
      } else {
        const paywall = await detectAccessProblem(page)
        outcome = paywall ? 'unauthorized' : 'interrupted'
        // Keep the mechanism as well as the diagnosis: which of the three ways the
        // page turn died is the first thing wanted when a stall is investigated.
        note =
          paywall ??
          (exhausted
            ? `翻页停在《${lastHeader(meta) ?? '?'}》，目录还没走完（${result.stoppedBecause}）`
            : result.stoppedBecause)
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
