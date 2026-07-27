/**
 * Per-chapter capture cache.
 *
 * A book is hundreds of page-turns against a live site, so a failure at chapter
 * 130 must not cost the first 129. Captures land on disk as they happen, keyed
 * by book and chapter, and a re-run skips whatever is already complete.
 *
 * Caching images rather than a finished PDF also means the PDF can be
 * re-typeset — or an OCR text layer added later — with no re-scraping.
 */
import { mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Chapter } from './types.ts'
import type { ScreenCapture } from './capture.ts'

export const CACHE_ROOT = join(homedir(), '.cache', 'weread-export')

/** Why a chapter has no captures, when that is expected rather than a bug. */
export type ChapterStatus = 'complete' | 'empty' | 'unauthorized' | 'failed'

export interface ChapterRecord {
  index: number
  title: string
  level: number
  status: ChapterStatus
  screens: number
  /** Cache-relative file names, in reading order. */
  files: string[]
  stoppedBecause?: string
  note?: string
}

export interface BookMeta {
  bookId: string
  title: string
  chapters: Chapter[]
  captured: Record<string, ChapterRecord>
  updatedAt: string
}

export function bookDir(bookId: string): string {
  return join(CACHE_ROOT, bookId)
}

const metaPath = (bookId: string) => join(bookDir(bookId), 'meta.json')

const pad = (n: number, w = 4) => String(n).padStart(w, '0')

export function screenFileName(chapterIndex: number, screenIndex: number, column: number): string {
  return `ch${pad(chapterIndex)}-s${pad(screenIndex)}-c${column}.png`
}

export async function readMeta(bookId: string): Promise<BookMeta | null> {
  const p = metaPath(bookId)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(await readFile(p, 'utf8')) as BookMeta
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
    // Keep captures, refresh the TOC in case the book was updated.
    existing.chapters = chapters
    existing.title = title
    return existing
  }
  return { bookId, title, chapters, captured: {}, updatedAt: new Date().toISOString() }
}

/** Persist one screen's columns; returns the file names written. */
export async function saveScreen(
  bookId: string,
  chapterIndex: number,
  screenIndex: number,
  screen: ScreenCapture,
): Promise<string[]> {
  const dir = bookDir(bookId)
  await mkdir(dir, { recursive: true })
  const names: string[] = []
  for (const col of screen.columns) {
    const name = screenFileName(chapterIndex, screenIndex, col.column)
    await writeFile(join(dir, name), col.png)
    names.push(name)
  }
  return names
}

export function isChapterDone(meta: BookMeta, chapterIndex: number): boolean {
  const rec = meta.captured[String(chapterIndex)]
  if (!rec) return false
  // 'failed' is worth retrying; the others are settled.
  return rec.status !== 'failed'
}

export function recordChapter(meta: BookMeta, rec: ChapterRecord): void {
  meta.captured[String(rec.index)] = rec
}

/** Every captured page, in reading order, for the renderer. */
export function orderedPages(meta: BookMeta): Array<{ chapter: ChapterRecord; file: string; isChapterStart: boolean }> {
  const out: Array<{ chapter: ChapterRecord; file: string; isChapterStart: boolean }> = []
  const indices = Object.keys(meta.captured)
    .map(Number)
    .sort((a, b) => a - b)
  for (const i of indices) {
    const rec = meta.captured[String(i)]
    for (const [n, file] of rec.files.entries()) {
      out.push({ chapter: rec, file, isChapterStart: n === 0 })
    }
  }
  return out
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
