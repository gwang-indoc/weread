/**
 * Capture cache for one Book.
 *
 * The unit of capture is a Screen, not a Chapter. WeRead's 节 can begin partway
 * down a page, so no clean per-chapter partition of pages exists — the running
 * header lags by up to a page and clicking a 节 in the 目录 lands on the page
 * where it starts, which may still be headed by the previous 节. Attempts to
 * walk chapter-by-chapter therefore either skipped content or captured it twice.
 *
 * So a Book is stored as an ordered list of Screens, each identified by the
 * content hash of its columns. Hashes make the cache idempotent: a resumed run
 * can re-page over ground it already covered and simply not store it again.
 * Chapter titles are recorded per screen as labels, for bookmarks and headers.
 */
import { mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Chapter } from './types.ts'
import type { ScreenCapture } from './capture.ts'

export const CACHE_ROOT = join(homedir(), '.cache', 'weread-export')

/** Bumped when the cache layout changes; older caches are discarded. */
export const CACHE_VERSION = 2

/** How a walk ended, when it ended for a reason worth reporting. */
export type WalkOutcome = 'complete' | 'unauthorized' | 'interrupted' | 'failed'

export interface ScreenRecord {
  /** Position in reading order, from the start of the book. */
  seq: number
  /** Cache-relative file names, left column first. */
  files: string[]
  /** Content hashes of those columns — the screen's identity. */
  hashes: string[]
  /** Running header when this screen was captured. A label, not an identity. */
  header: string | null
}

export interface BookMeta {
  version: number
  bookId: string
  title: string
  chapters: Chapter[]
  screens: ScreenRecord[]
  /**
   * deviceScaleFactor the screens were captured at. Recorded so a resumed run
   * can tell the user it is about to append pages at a different resolution
   * than the ones already stored.
   */
  scale?: number
  outcome?: WalkOutcome
  note?: string
  updatedAt: string
}

export function bookDir(bookId: string): string {
  return join(CACHE_ROOT, bookId)
}

const metaPath = (bookId: string) => join(bookDir(bookId), 'meta.json')
const pad = (n: number, w = 5) => String(n).padStart(w, '0')

export function screenFileName(seq: number, column: number): string {
  return `s${pad(seq)}-c${column}.png`
}

export async function readMeta(bookId: string): Promise<BookMeta | null> {
  const p = metaPath(bookId)
  if (!existsSync(p)) return null
  try {
    const meta = JSON.parse(await readFile(p, 'utf8')) as BookMeta
    // A cache written by an older layout cannot be trusted or merged.
    if (meta.version !== CACHE_VERSION) return null
    return meta
  } catch {
    return null // corrupt cache is the same as no cache
  }
}

export async function writeMeta(meta: BookMeta): Promise<void> {
  await mkdir(bookDir(meta.bookId), { recursive: true })
  meta.updatedAt = new Date().toISOString()
  await writeFile(metaPath(meta.bookId), JSON.stringify(meta, null, 2))
}

export async function initMeta(bookId: string, title: string, chapters: Chapter[]): Promise<BookMeta> {
  const existing = await readMeta(bookId)
  if (existing) {
    // Keep the screens, refresh the TOC in case the book was updated.
    existing.chapters = chapters
    existing.title = title
    return existing
  }
  return { version: CACHE_VERSION, bookId, title, chapters, screens: [], updatedAt: new Date().toISOString() }
}

/** Every column hash already stored, so a resumed walk can skip known ground. */
export function knownHashes(meta: BookMeta): Set<string> {
  const out = new Set<string>()
  for (const s of meta.screens) for (const h of s.hashes) out.add(h)
  return out
}

/** The header of the last captured screen — what the walk got to, for reporting. */
export function lastHeader(meta: BookMeta): string | null {
  return meta.screens.length ? meta.screens[meta.screens.length - 1].header : null
}

/**
 * Every running header the walk has seen, in capture order.
 *
 * Where the walk has got to is a question about this whole trail, not about its
 * last entry: 目录 titles are not unique, so one header on its own can name two
 * different positions in the book. See `reachedIndex`.
 */
export function headerTrail(meta: BookMeta): (string | null)[] {
  return meta.screens.map((s) => s.header)
}

/**
 * Store one screen and return its record. Idempotent by hash: a screen already
 * present is returned unchanged rather than written twice.
 */
export async function appendScreen(meta: BookMeta, screen: ScreenCapture): Promise<ScreenRecord | null> {
  const signature = screen.columns.map((c) => c.hash).join('-')
  const existing = meta.screens.find((s) => s.hashes.join('-') === signature)
  if (existing) return null

  const seq = meta.screens.length
  const dir = bookDir(meta.bookId)
  await mkdir(dir, { recursive: true })
  const files: string[] = []
  for (const col of screen.columns) {
    const name = screenFileName(seq, col.column)
    await writeFile(join(dir, name), col.png)
    files.push(name)
  }
  const record: ScreenRecord = { seq, files, hashes: screen.columns.map((c) => c.hash), header: screen.header }
  meta.screens.push(record)
  return record
}

/**
 * Every captured page in reading order.
 *
 * `isUnitStart` marks a page where the running header changed, which is where
 * the renderer puts a chapter mark and hence a PDF bookmark.
 */
export interface OrderedPage {
  file: string
  /** Content hash of this column — its identity, and the OCR cache key. */
  hash: string
  header: string | null
  isUnitStart: boolean
}

export function orderedPages(meta: BookMeta): OrderedPage[] {
  const out: OrderedPage[] = []
  let previousHeader: string | null = null
  for (const screen of meta.screens) {
    const changed = (screen.header ?? '') !== (previousHeader ?? '')
    for (const [n, file] of screen.files.entries()) {
      out.push({ file, hash: screen.hashes[n] ?? '', header: screen.header, isUnitStart: changed && n === 0 })
    }
    previousHeader = screen.header
  }
  return out
}

/**
 * Every book in the cache, as Books — so `resolveBook` can match a title
 * without a session or a browser.
 *
 * This is what lets `epub` and `render` work offline: the cache already knows
 * every title it holds, and re-reading the 书架 over the network to learn a name
 * we have on disk would be the only thing forcing a login.
 */
export function listCachedBooks(): Array<{ id: string; title: string; readerUrl: string }> {
  if (!existsSync(CACHE_ROOT)) return []
  const out: Array<{ id: string; title: string; readerUrl: string }> = []
  for (const id of readdirSync(CACHE_ROOT)) {
    const path = join(CACHE_ROOT, id, 'meta.json')
    if (!existsSync(path)) continue
    try {
      const meta = JSON.parse(readFileSync(path, 'utf8')) as Partial<BookMeta>
      if (meta.title) out.push({ id, title: meta.title, readerUrl: `https://weread.qq.com/web/reader/${id}` })
    } catch {
      // A corrupt meta.json is simply not offered as a choice.
    }
  }
  return out.sort((a, b) => a.title.localeCompare(b.title, 'zh'))
}

export async function clearBook(bookId: string): Promise<void> {
  await rm(bookDir(bookId), { recursive: true, force: true })
}

export async function cacheSize(bookId: string): Promise<number> {
  const dir = bookDir(bookId)
  if (!existsSync(dir)) return 0
  const files = await readdir(dir)
  return files.filter((f) => f.endsWith('.png')).length
}
