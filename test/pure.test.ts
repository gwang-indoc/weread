/**
 * Offline tests for the pure parts.
 *
 * Nothing here touches the network or a browser: these are the decisions that
 * shape the export (where a resumed walk restarts, how pages are named and
 * ordered, what the print document contains), so they must be checkable without
 * logging into WeRead. The browser-dependent halves are exercised by the dev
 * harness in scripts/ and by the live smoke test.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inflateRawSync } from 'node:zlib'
import { bookIdFromUrl, resolveBook } from '../src/bookshelf.ts'
import {
  assembleChapters,
  columnBlocks,
  columnMetrics,
  findHoles,
  isNoise,
  isSpeck,
  joinBaselines,
  joinText,
  mergeLines,
  visualLength,
  type ColumnInput,
  type EpubChapter,
  type OcrColumn,
  type OcrLine,
} from '../src/text.ts'
import {
  buildChapterXhtml,
  buildEpub,
  buildNavXhtml,
  buildOpf,
  buildQaXhtml,
  collectQa,
} from '../src/epub.ts'
import { crc32, zip } from '../src/zip.ts'
import { sameTitle, resumeIndex, scaleChangeWarning, looksTruncated, restSchedule } from '../src/export.ts'
import { chapterKeyOf } from '../src/capture.ts'
import { screenFileName, orderedPages, knownHashes, lastHeader, CACHE_VERSION, type BookMeta } from '../src/cache.ts'
import { buildHtml } from '../src/render.ts'
import { unitsOf, coverageOf, buildStatusHtml, type StatusView, type BookStatus } from '../src/status.ts'
import type { Book, Chapter } from '../src/types.ts'

const books: Book[] = [
  { id: 'a1', title: '我的第一本算法书', readerUrl: 'https://weread.qq.com/web/reader/a1' },
  { id: 'b2', title: '马斯克：重回太空', readerUrl: 'https://weread.qq.com/web/reader/b2' },
  { id: 'c3', title: '望向星空深处（天际线）', readerUrl: 'https://weread.qq.com/web/reader/c3' },
]

const chapters: Chapter[] = [
  { index: 0, level: 1, title: '扉页' },
  { index: 1, level: 1, title: '版权信息' },
  { index: 2, level: 1, title: '第一章 离弃' },
  { index: 3, level: 2, title: '牛顿的家族' },
  { index: 4, level: 2, title: '艾萨克·牛顿出世' },
]

test('bookIdFromUrl extracts the id, with or without a chapter suffix', () => {
  assert.equal(bookIdFromUrl('https://weread.qq.com/web/reader/a9c32f40717db77aa9c9171'), 'a9c32f40717db77aa9c9171')
  assert.equal(bookIdFromUrl('https://weread.qq.com/web/reader/a1?foo=1#x'), 'a1')
})

test('resolveBook matches exactly, then partially', () => {
  assert.equal(resolveBook(books, '我的第一本算法书').id, 'a1')
  assert.equal(resolveBook(books, '算法').id, 'a1')
  assert.equal(resolveBook(books, 'b2').id, 'b2')
})

test('resolveBook refuses to guess when a query is ambiguous', () => {
  const ambiguous: Book[] = [
    { id: 'x', title: '算法导论', readerUrl: 'u' },
    { id: 'y', title: '算法图解', readerUrl: 'u' },
  ]
  assert.throws(() => resolveBook(ambiguous, '算法'), /匹配到 2 本书/)
  assert.throws(() => resolveBook(books, '不存在的书'), /找不到/)
})

test('sameTitle ignores whitespace but never matches on emptiness', () => {
  assert.ok(sameTitle('第一章 离弃', '第一章　离弃'))
  assert.ok(sameTitle(' 牛顿的家族 ', '牛顿的家族'))
  assert.ok(!sameTitle('牛顿的家族', '艾萨克·牛顿出世'))
  assert.ok(!sameTitle(null, null), 'two unknown headers are not a match')
  assert.ok(!sameTitle('', ''))
})

test('chapterKeyOf reads the unit key when the URL carries one', () => {
  assert.equal(
    chapterKeyOf('https://weread.qq.com/web/reader/1d232b8071f3ef871d2908dk8f132430178f14e45fce0f7'),
    'k8f132430178f14e45fce0f7',
  )
  // Recorded for diagnostics only: the key is often absent or stale, which is
  // exactly why it is not used as a boundary signal.
  assert.equal(chapterKeyOf('https://weread.qq.com/web/reader/a9c32f40717db77aa9c9171'), '')
})

test('resumeIndex aims a resumed walk at the last header seen', () => {
  assert.equal(resumeIndex(chapters, '牛顿的家族'), 3)
  assert.equal(resumeIndex(chapters, '第一章 离弃'), 2)
  assert.equal(resumeIndex(chapters, null), 0, 'a fresh run starts at the beginning')
  assert.equal(resumeIndex(chapters, '这本书里没有的标题'), 0, 'an unknown header restarts from the beginning')
})

test('looksTruncated tells a stalled reader from the end of the book', () => {
  // Both present identically — 下一页 stops advancing and the same pixels come
  // back — so the 目录 position is what separates them. Without this, a stall is
  // recorded as a complete export and the retry never fires.
  const toc: Chapter[] = [
    { index: 0, level: 1, title: '第一章' },
    { index: 1, level: 2, title: '第一节' },
    { index: 2, level: 2, title: '第二节' },
    { index: 3, level: 1, title: '第二章' },
    { index: 4, level: 1, title: '附录' },
    { index: 5, level: 1, title: '版权信息' },
  ]
  // 6 entries -> tolerance 1, so only the final entry reads as the end.
  assert.equal(looksTruncated(toc, '第一章'), true, 'stopped at entry 0 of 6 — a stall')
  assert.equal(looksTruncated(toc, '第二节'), true)
  assert.equal(looksTruncated(toc, '附录'), true)
  assert.equal(looksTruncated(toc, '版权信息'), false, 'the last entry — genuinely the end')
})

test('the end-of-book tolerance scales with the length of the 目录', () => {
  // Trailing 版权信息 / colophon entries are DOM, never become a header, so the
  // walk ends a few entries short of a long 目录. But a fixed allowance of three
  // would be half of a short one, and over-generous here means a truncated book
  // is silently reported complete.
  const toc = (n: number): Chapter[] =>
    Array.from({ length: n }, (_, i) => ({ index: i, level: 1, title: `第${i}章` }))

  // 200 entries -> tolerance 3: stopping 4 from the end is still a stall.
  assert.equal(looksTruncated(toc(200), '第196章'), true)
  assert.equal(looksTruncated(toc(200), '第197章'), false)

  // 8 entries -> tolerance 2.
  assert.equal(looksTruncated(toc(8), '第5章'), true)
  assert.equal(looksTruncated(toc(8), '第6章'), false)

  // A 3-entry book must still be completable — tolerance floors at 1.
  assert.equal(looksTruncated(toc(3), '第2章'), false)
  assert.equal(looksTruncated(toc(3), '第1章'), true)
})

test('looksTruncated treats an unrecognised header as the end, not as a stall', () => {
  // Headers lag and do not always match an entry (ADR 0002). Guessing "truncated"
  // here would retry forever at a real end of book, five minutes at a time.
  assert.equal(looksTruncated(chapters, '这本书里没有的标题'), false)
  assert.equal(looksTruncated(chapters, null), false)
  assert.equal(looksTruncated([], '第一章 离弃'), false)
})

test('restSchedule splits the rest into chunks that sum to exactly the wait', () => {
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
  assert.deepEqual(restSchedule(5 * 60_000), [60_000, 60_000, 60_000, 60_000, 60_000])
  assert.deepEqual(restSchedule(90_000), [60_000, 30_000])
  assert.deepEqual(restSchedule(30_000), [30_000])
  assert.deepEqual(restSchedule(60_000), [60_000])
  assert.deepEqual(restSchedule(0), [], 'no rest means no waiting at all')
  assert.deepEqual(restSchedule(-1), [])
  for (const total of [1, 999, 60_001, 5 * 60_000, 17 * 60_000 + 13]) {
    assert.equal(sum(restSchedule(total)), total, `chunks must sum to ${total}`)
  }
})

test('screen file names sort into reading order as plain strings', () => {
  const names = [screenFileName(10, 1), screenFileName(2, 0), screenFileName(10, 0), screenFileName(1, 0)]
  assert.deepEqual([...names].sort(), ['s00001-c0.png', 's00002-c0.png', 's00010-c0.png', 's00010-c1.png'])
})

function metaFixture(): BookMeta {
  return {
    version: CACHE_VERSION,
    bookId: 'a1',
    title: '测试书',
    chapters,
    screens: [
      { seq: 0, files: ['s00000-c0.png', 's00000-c1.png'], hashes: ['h0a', 'h0b'], header: '第一章 离弃' },
      { seq: 1, files: ['s00001-c0.png', 's00001-c1.png'], hashes: ['h1a', 'h1b'], header: '第一章 离弃' },
      { seq: 2, files: ['s00002-c0.png'], hashes: ['h2a'], header: '牛顿的家族' },
    ],
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

test('orderedPages yields one page per column and marks only header changes', () => {
  const pages = orderedPages(metaFixture())
  assert.deepEqual(
    pages.map((p) => [p.file, p.isUnitStart]),
    [
      ['s00000-c0.png', true], // first screen: a header appears
      ['s00000-c1.png', false], // same screen, second column
      ['s00001-c0.png', false], // header unchanged
      ['s00001-c1.png', false],
      ['s00002-c0.png', true], // header changed -> new unit
    ],
  )
})

test('knownHashes collects every stored column, for skipping on resume', () => {
  assert.deepEqual([...knownHashes(metaFixture())].sort(), ['h0a', 'h0b', 'h1a', 'h1b', 'h2a'])
})

test('lastHeader reports where the walk got to', () => {
  assert.equal(lastHeader(metaFixture()), '牛顿的家族')
  assert.equal(lastHeader({ ...metaFixture(), screens: [] }), null)
})

test('the cache layout is versioned, so v1 per-chapter caches are discarded', () => {
  // readMeta enforces this; the constant is what that check pins to.
  assert.ok(CACHE_VERSION >= 2, 'v1 stored per-chapter records that cannot be reinterpreted')
})

test('buildHtml emits one page per captured column, with a mark per unit', () => {
  const html = buildHtml(metaFixture())
  assert.equal((html.match(/class="page content"/g) ?? []).length, 5)
  // Two units in the fixture -> two outline entries, not one per page.
  assert.equal((html.match(/class="chapter-mark"/g) ?? []).length, 2)
  assert.match(html, /size: A5 portrait/)
})

test('buildHtml adds a notice page when the walk did not finish', () => {
  const complete = buildHtml({ ...metaFixture(), outcome: 'complete' })
  assert.ok(!complete.includes('导出未完成'))

  const cut = buildHtml({ ...metaFixture(), outcome: 'unauthorized', note: '试读结束' })
  assert.match(cut, /导出未完成/)
  assert.match(cut, /未授权/)
  assert.match(cut, /试读结束/)
})

test('buildHtml escapes titles so a book name cannot inject markup', () => {
  const meta = metaFixture()
  meta.title = '<script>alert(1)</script>'
  const html = buildHtml(meta)
  assert.ok(!html.includes('<script>alert(1)</script>'))
  assert.match(html, /&lt;script&gt;/)
})

/* ---------------------------------------------------------------- status report */

test('unitsOf groups consecutive screens by running header', () => {
  const units = unitsOf([
    { seq: 0, header: '第一章 离弃' },
    { seq: 1, header: '第一章 离弃' },
    { seq: 2, header: '牛顿的家族' },
    { seq: 3, header: '艾萨克·牛顿出世' },
    { seq: 4, header: '艾萨克·牛顿出世' },
  ])
  assert.deepEqual(units, [
    { header: '第一章 离弃', screens: 2, firstSeq: 0 },
    { header: '牛顿的家族', screens: 1, firstSeq: 2 },
    { header: '艾萨克·牛顿出世', screens: 2, firstSeq: 3 },
  ])
})

test('unitsOf starts a new unit when a header recurs later', () => {
  // Reading order is what the strip shows, so a header coming back after
  // another one is a second visit, not a continuation of the first.
  const units = unitsOf([
    { seq: 0, header: '附录' },
    { seq: 1, header: '卷二' },
    { seq: 2, header: '附录' },
  ])
  assert.equal(units.length, 3)
  assert.deepEqual(units.map((u) => u.firstSeq), [0, 1, 2])
})

test('unitsOf labels a missing header rather than dropping the screen', () => {
  const units = unitsOf([{ seq: 0, header: null }, { seq: 1, header: null }])
  assert.deepEqual(units, [{ header: '（无页眉）', screens: 2, firstSeq: 0 }])
})

function statusFixture(): StatusView {
  const screens = [
    { seq: 0, header: '第一章', columns: 2 },
    { seq: 1, header: '第一章', columns: 2 },
    { seq: 2, header: '第二节', columns: 1 },
  ]
  const book: BookStatus = {
    id: 'b1', title: '测试书', legacy: false, chapters: 4,
    screenCount: 3, pages: 5, bytes: 5 * 1048576,
    outcome: 'interrupted', note: '下一页 not clickable',
    updatedAt: '2026-07-27T02:00:00.000Z',
    units: unitsOf(screens), screens,
  }
  return { books: [book], totals: { books: 1, screens: 3, pages: 5, bytes: 5 * 1048576 } }
}

test('coverageOf is units seen over TOC entries, and never exceeds 1', () => {
  const view = statusFixture()
  assert.equal(coverageOf(view.books[0]), 0.5) // 2 units / 4 entries
  assert.equal(coverageOf({ ...view.books[0], chapters: 0 }), 0, 'no TOC means no ratio, not a divide by zero')
  assert.equal(coverageOf({ ...view.books[0], chapters: 1 }), 1, 'more units than entries still caps at 1')
})

test('buildStatusHtml renders one tick per screen and one detail row per book', () => {
  const html = buildStatusHtml(statusFixture())
  assert.equal((html.match(/class="tick/g) ?? []).length, 3)
  // One filmstrip row per book. (Counting <tbody> would also catch the units
  // table nested inside that row, which is not the invariant being pinned.)
  assert.equal((html.match(/class="detail"/g) ?? []).length, 1)
  assert.match(html, /测试书/)
})

test('buildStatusHtml states an unfinished export and offers the resume command', () => {
  const html = buildStatusHtml(statusFixture())
  assert.match(html, /未抓完/)
  assert.match(html, /需要处理/)
  assert.match(html, /weread-export 测试书/)
})

test('buildStatusHtml flags a legacy cache as needing --force', () => {
  const view = statusFixture()
  view.books[0].legacy = true
  const html = buildStatusHtml(view)
  assert.match(html, /旧格式缓存/)
  assert.match(html, /--force/)
})

test('buildStatusHtml says so plainly when nothing is cached', () => {
  const html = buildStatusHtml({ books: [], totals: { books: 0, screens: 0, pages: 0, bytes: 0 } })
  assert.match(html, /还没有任何缓存/)
  assert.ok(!html.includes('class="tick'), 'no strip without screens')
})

test('buildStatusHtml escapes book titles and headers', () => {
  const view = statusFixture()
  view.books[0].title = '<img onerror=alert(1)>'
  view.books[0].units[0].header = '</style><script>x</script>'
  const html = buildStatusHtml(view)
  assert.ok(!html.includes('<img onerror'))
  assert.ok(!html.includes('<script>x</script>'))
})

test('buildStatusHtml is pure — same view, same document', () => {
  assert.equal(buildStatusHtml(statusFixture(), 'fixed'), buildStatusHtml(statusFixture(), 'fixed'))
})

test('scaleChangeWarning is silent only when the scale is unchanged', () => {
  assert.equal(scaleChangeWarning(3, 3), null)
  assert.equal(scaleChangeWarning(2, 2), null)

  const changed = scaleChangeWarning(3, 2)
  assert.ok(changed, 'a changed scale must be surfaced, not silently mixed')
  assert.match(changed, /--scale 3/)
  assert.match(changed, /--force/)
})

test('scaleChangeWarning treats an unrecorded scale as risky, not safe', () => {
  // Only called when screens already exist, so a missing scale means the cache
  // predates the field — captured back when the default was 3. Returning null
  // here would silence the warning in exactly the case that needs it.
  const warning = scaleChangeWarning(undefined, 2)
  assert.ok(warning)
  assert.match(warning, /没有记录分辨率/)
  assert.match(warning, /--force/)
})

/* ------------------------------------------------------------------ ocr → text */

/**
 * Fixtures are shaped like real Vision output for a 1179×2310 column at
 * `--scale 2`: a ~21-character measure, a line every ~0.045 of the height, and
 * the running header painted at the top of the page.
 */
const LH = 0.029
const MEASURE = 0.998
const CHAR = MEASURE / 21

const line = (t: number, s: string, over: Partial<OcrLine> = {}): OcrLine => ({
  t,
  l: 0,
  w: Math.min(MEASURE, visualLength(s) * CHAR),
  h: LH,
  c: 1,
  s,
  ...over,
})

const column = (lines: OcrLine[]): OcrColumn => ({ width: 1179, height: 2310, lines })

/**
 * A run of ordinary full-measure body lines.
 *
 * Fixtures need these: every rule in text.ts is calibrated against the column's
 * own median line height and widest line, so a two-line fixture would let the
 * heading it is testing for define what "normal" means. Real columns hold ~15
 * lines.
 */
const body = (from: number, count: number, over: Partial<OcrLine> = {}): OcrLine[] =>
  Array.from({ length: count }, (_, i) => full(from + i * (LH + 0.016), `${i}`.repeat(1) + '正'.repeat(20), over))

/** Assert a block's kind and narrow to it, so the assertions below can read it. */
const of = <T extends { kind: string }, K extends T['kind']>(block: T | undefined, kind: K): Extract<T, { kind: K }> => {
  assert.equal(block?.kind, kind)
  return block as Extract<T, { kind: K }>
}

const full = (t: number, s: string, over: Partial<OcrLine> = {}) => line(t, s, { w: MEASURE, ...over })

test('visualLength counts a CJK glyph as twice an ASCII one', () => {
  assert.equal(visualLength('中文'), 2)
  assert.equal(visualLength('abcd'), 2)
  assert.equal(visualLength('中a'), 1.5)
})

test('columnMetrics measures the column instead of assuming a scale', () => {
  const m = columnMetrics([full(0.1, '一'.repeat(21)), line(0.15, '短行'), full(0.2, '二'.repeat(21))])
  assert.ok(Math.abs(m.lineHeight - LH) < 1e-9)
  assert.ok(Math.abs(m.measure - MEASURE) < 1e-9)
  assert.equal(m.margin, 0)
  assert.ok(Math.abs(m.charWidth - CHAR) < 1e-4, 'derived from the widest line’s own text')
})

test('columnMetrics ignores noise when confident lines exist', () => {
  // An illustrated page: many tiny low-confidence boxes from a facsimile plus
  // two real lines. Letting the noise set the median line height would
  // misclassify the prose sharing the page.
  const scribble = Array.from({ length: 12 }, (_, i) =>
    line(0.3 + i * 0.02, 'wodely uolywg', { h: LH * 0.4, l: 0.15, c: 0.3 }),
  )
  const m = columnMetrics([full(0.1, '一'.repeat(21)), ...scribble, full(0.9, '二'.repeat(21))])
  assert.ok(Math.abs(m.lineHeight - LH) < 1e-9, 'median comes from the prose, not the scribble')
})

test('columnMetrics takes the margin most lines share, not the smallest left', () => {
  // A single box with a negative left would otherwise define the margin and make
  // every real line look indented.
  const m = columnMetrics([
    full(0.1, '一'.repeat(21), { l: -0.0004 }),
    full(0.15, '二'.repeat(21), { l: 0 }),
    full(0.2, '三'.repeat(21), { l: 0 }),
  ])
  assert.equal(m.margin, 0)
})

test('mergeLines keeps the most confident reading of a duplicated line', () => {
  const merged = mergeLines(
    [
      full(0.12, '那些近1万年就开始构建找们知识遗产的人一', { c: 0.5 }),
      full(0.1205, '那些近1万年前就开始构建我们知识遗产的人一', { c: 1 }),
    ],
    LH,
  )
  assert.equal(merged.length, 1)
  assert.match(merged[0].s, /1万年前/)
  assert.match(merged[0].s, /我们/)
})

test('mergeLines unions the geometry, because a clipped reading under-reports', () => {
  // A band can cut a line, and Vision then reads only part of it and reports a
  // box to match. A median would take that short width and the line would look
  // like the end of a paragraph — splitting it mid-sentence.
  const merged = mergeLines(
    [
      line(0.617, '的楷模，但他一生花费在炼金术上的精', { w: 0.6, c: 1 }),
      line(0.6172, '的楷模，但他一生花费在炼', { w: 0.55, c: 1 }),
      full(0.6168, '的楷模，但他一生花费在炼金术上的精力，远远', { c: 1 }),
    ],
    LH,
  )
  assert.equal(merged.length, 1)
  assert.ok(Math.abs(merged[0].w - MEASURE) < 1e-9, 'union width, not median')
})

test('joinBaselines rejoins one visual line returned as two boxes', () => {
  const m = columnMetrics([full(0.1, '一'.repeat(21))])
  const joined = joinBaselines(
    [
      line(0.6527, '手资料为基础写成的，', { w: 0.4542 }),
      line(0.6549, '故而是十分重要的一部', { l: 0.4625, w: 0.5333, c: 0.5 }),
    ],
    m,
  )
  assert.equal(joined.length, 1)
  assert.equal(joined[0].s, '手资料为基础写成的，故而是十分重要的一部')
  assert.ok(Math.abs(joined[0].l + joined[0].w - 0.9958) < 1e-9, 'extent spans both halves')
  assert.equal(joined[0].c, 0.5, 'a badly read half makes the whole line worth checking')
})

test('joinBaselines leaves a genuine next line alone', () => {
  const m = columnMetrics([full(0.1, '一'.repeat(21))])
  const joined = joinBaselines([full(0.1, '一'.repeat(21)), full(0.145, '二'.repeat(21))], m)
  assert.equal(joined.length, 2)
})

test('joinText never inserts a space at a CJK line wrap', () => {
  assert.equal(joinText('那些近1万年前就开始构建我们知识遗产的人一', '样，用相同的目光'), '那些近1万年前就开始构建我们知识遗产的人一样，用相同的目光')
  assert.equal(joinText('the last', 'word'), 'the last word')
  assert.equal(joinText('中文', 'English'), '中文English')
  assert.equal(joinText('', '开头'), '开头')
})

test('isSpeck drops footnote markers but never a short final line', () => {
  const m = columnMetrics([full(0.1, '一'.repeat(21))])
  assert.ok(isSpeck(line(0.26, '注', { l: 0.88, w: 0.027, c: 0.3 }), m), 'low-confidence marker')
  assert.ok(isSpeck(line(0.26, '注', { l: 0.88, w: 0.03, c: 1 }), m), 'confident, but still just a marker')
  assert.ok(!isSpeck(line(0.65, '经影响了他在纯科学上的成就？', { w: 0.63 }), m), 'a real short line survives')
  assert.ok(!isSpeck(line(0.65, '圣人。', { w: 0.12 }), m), 'a three-character line is prose')
})

test('isNoise needs geometry as well as low confidence', () => {
  const m = columnMetrics([full(0.1, '一'.repeat(21))])
  // A centred caption comes back at 0.5 and must survive.
  assert.ok(!isNoise(line(0.64, '达•芬奇《自画像》局部', { l: 0.26, w: 0.48, c: 0.5 }), m))
  // Transcribed manuscript strokes: low confidence, and inset where prose never starts.
  assert.ok(isNoise(line(0.55, 'Jmalewodoncoucalebcnr', { l: 0.16, w: 0.53, h: LH * 0.9, c: 0.3 }), m))
  // Low confidence and far too short to be a line of prose.
  assert.ok(isNoise(line(0.55, 'wodely uolywg', { l: 0, w: 0.12, h: LH * 0.4, c: 0.3 }), m))
})

test('findHoles reports the gaps, including the page margins', () => {
  // Margins are reported deliberately: whether a gap is a plate or white space is
  // decided from the pixels, not from here.
  const holes = findHoles([full(0.3, '一'.repeat(21)), full(0.8, '二'.repeat(21))], LH)
  assert.equal(holes.length, 3)
  assert.ok(Math.abs(holes[0].top - 0) < 1e-9)
  assert.ok(Math.abs(holes[1].top - 0.329) < 1e-9, 'the interior gap')
  assert.ok(holes[2].top > 0.8, 'the trailing margin')
})

test('columnBlocks joins wrapped lines into one paragraph', () => {
  const blocks = columnBlocks(
    column([
      line(0.05, '炼金之秘', { w: 0.14 }),
      full(0.12, '很显然，凯恩斯被他发现的资料迷惑了。不过，'),
      full(0.165, '对我们大家而言，这是件幸运的事，因为这是个'),
      line(0.21, '已然可以接受这类发现的时代。', { w: 0.6 }),
    ]),
    '炼金之秘',
  )
  assert.equal(blocks.length, 1)
  const joined = of(blocks[0], 'paragraph')
  assert.equal(
    joined.text,
    '很显然，凯恩斯被他发现的资料迷惑了。不过，对我们大家而言，这是件幸运的事，因为这是个已然可以接受这类发现的时代。',
  )
  assert.equal(joined.openEnd, false, 'the last line stopped short of the measure')
})

test('columnBlocks drops the running header WeRead paints into the page', () => {
  const blocks = columnBlocks(
    column([line(0.05, '炼金之秘', { w: 0.14 }), full(0.12, '很显然，凯恩斯被他发现的资料迷惑了。')]),
    '炼金之秘',
  )
  assert.equal(blocks.length, 1)
  assert.ok(!of(blocks[0], 'paragraph').text.includes('炼金之秘'))
})

test('columnBlocks starts a paragraph on a first-line indent', () => {
  const blocks = columnBlocks(
    column([
      full(0.12, '一'.repeat(21)),
      full(0.165, '二'.repeat(21), { l: CHAR * 1.2 }), // indented, next line is not
      full(0.21, '三'.repeat(21)),
    ]),
    null,
  )
  assert.equal(blocks.length, 2)
})

test('columnBlocks does not split a block that is inset on every line', () => {
  // A first-line indent indents ONE line. A block sitting further right on every
  // line is a continuation, and splitting it would break the stitch to the
  // previous column.
  const blocks = columnBlocks(
    column([
      full(0.12, '一'.repeat(21), { l: CHAR * 1.2 }),
      full(0.165, '二'.repeat(21), { l: CHAR * 1.2 }),
      full(0.21, '三'.repeat(21), { l: CHAR * 1.2 }),
    ]),
    null,
  )
  assert.equal(blocks.length, 1)
  assert.equal(of(blocks[0], 'paragraph').openStart, true, 'so it can continue the previous column')
})

test('columnBlocks splits on a blank line even when the measure is full', () => {
  const blocks = columnBlocks(
    column([full(0.12, '一'.repeat(21)), full(0.12 + LH + LH * 2, '二'.repeat(21))]),
    null,
  )
  assert.equal(blocks.length, 2)
})

test('columnBlocks recognises a heading by height, not by position', () => {
  const blocks = columnBlocks(
    column([line(0.05, '手记7 地球的血脉——水流', { w: 0.86, h: LH * 1.3 }), ...body(0.15, 5)]),
    null,
  )
  assert.deepEqual(blocks.map((b) => b.kind), ['heading', 'paragraph'])
  assert.equal(of(blocks[0], 'heading').text, '手记7 地球的血脉——水流')
})

test('columnBlocks starts a fresh paragraph after a heading', () => {
  // The line under a heading can look exactly like a continuation — full
  // measure, ordinary gap, no indent — but there is nothing to continue.
  const blocks = columnBlocks(
    column([
      line(0.05, '手记7 地球的血脉——水流', { w: 0.86, h: LH * 1.3 }),
      full(0.05 + LH + 0.008, '紧接在标题下面的一行既满行又没有缩进也没有空行'),
      ...body(0.15, 4),
    ]),
    null,
  )
  assert.deepEqual(blocks.map((b) => b.kind), ['heading', 'paragraph'])
})

test('columnBlocks starts a fresh paragraph after an illustration', () => {
  const blocks = columnBlocks(column([...body(0.55, 4)]), null, [
    { kind: 'image', top: 0.05, height: 0.45, id: 'img0001' },
  ])
  assert.deepEqual(blocks.map((b) => b.kind), ['image', 'paragraph'])
})

test('columnBlocks does not mistake a tall full-measure line for a heading', () => {
  // Vision's box height wobbles; a line running the whole measure is prose.
  const blocks = columnBlocks(
    column([full(0.12, '东西呢？第二，牛顿研究炼金术的过程，是否已', { h: LH * 1.25 })]),
    null,
  )
  assert.deepEqual(blocks.map((b) => b.kind), ['paragraph'])
})

test('columnBlocks places a confirmed illustration in reading order', () => {
  // Shaped like a real plate page from 达·芬奇手记: the running header, a full-page
  // picture, and a centred caption. The picture belongs between them, not after.
  const blocks = columnBlocks(
    column([
      line(0.048, '手记5 反方认为“月球上不存在水”的矛盾点', { w: 0.69, h: 0.0235, c: 0.5 }),
      line(0.639, '达•芬奇《自画像》局部', { l: 0.2557, w: 0.4829, h: 0.0264, c: 0.5 }),
    ]),
    '手记5 反方认为“月球上不存在水”的矛盾点',
    [{ kind: 'image', top: 0.08, height: 0.55, id: 'img0001' }],
  )
  assert.deepEqual(blocks.map((b) => b.kind), ['image', 'paragraph'])
  assert.equal(of(blocks[1], 'paragraph').text, '达•芬奇《自画像》局部')
})

test('columnBlocks ignores a region that was not confirmed as a picture', () => {
  // Every column ends in white space; without confirmation it stays white space.
  const blocks = columnBlocks(column([full(0.12, '一'.repeat(21))]), null)
  assert.deepEqual(blocks.map((b) => b.kind), ['paragraph'])
})

/* --------------------------------------------------------------- assembling */

const columnInput = (
  lines: OcrLine[],
  header: string | null,
  isUnitStart = false,
  images: Array<{ kind: 'image'; top: number; height: number; id: string }> = [],
): ColumnInput => ({ column: column(lines), header, isUnitStart, images })

test('assembleChapters stitches a paragraph across a column boundary', () => {
  const chapters = assembleChapters(
    [
      columnInput([full(0.8, '……他自行设下独居的藩篱，并订阅阿里乌教')], '为圣人立传', true),
      columnInput([line(0.12, '派（此教派的教义一贯反对三位一体论）的刊物。', { w: 0.9 })], '为圣人立传'),
    ],
    '测试书',
  )
  assert.equal(chapters.length, 1)
  assert.equal(chapters[0].blocks.length, 1)
  assert.match(of(chapters[0].blocks[0], 'paragraph').text, /阿里乌教派（此教派/, 'joined with no space at the wrap')
})

test('assembleChapters does not stitch across a chapter boundary', () => {
  // The running header lags the display by up to a page, so a boundary can fall
  // mid-paragraph. Joining across it would pull one chapter's opening into the
  // previous chapter's last paragraph.
  const chapters = assembleChapters(
    [
      columnInput([full(0.8, '上一章最后一行没有写完还在继续所以是满行的')], '第一章', true),
      columnInput([full(0.12, '下一章的第一行也是满行的并且没有首行缩进啊')], '第二章', true),
    ],
    '测试书',
  )
  assert.equal(chapters.length, 2)
  assert.equal(chapters[0].blocks.length, 1)
  assert.equal(chapters[1].blocks.length, 1)
})

test('assembleChapters does not stitch when the previous line ended short', () => {
  const chapters = assembleChapters(
    [
      columnInput([...body(0.12, 5), line(0.34, '上一段到这里就结束了。', { w: 0.5 })], '第一章', true),
      columnInput([full(0.12, '这是新的一段虽然没有缩进但上一行明显没写满啊'), ...body(0.17, 4)], '第一章'),
    ],
    '测试书',
  )
  assert.equal(chapters[0].blocks.length, 2)
})

test('assembleChapters drops the chapter title painted a second time in the page', () => {
  // WeRead paints the title twice on a chapter's opening page: small, as the
  // running header, and large, as the heading. The small one is dropped as a
  // repeat of the recorded header; the large one would otherwise become an <h2>
  // directly under the identical <h1>.
  const chapters = assembleChapters(
    [
      columnInput(
        [
          line(0.0516, '为圣人立传', { w: 0.18, h: 0.0186 }),
          line(0.1817, '为圣人立传', { w: 0.3441, h: 0.0354 }),
          ...body(0.2925, 5),
        ],
        '为圣人立传',
        true,
      ),
    ],
    '测试书',
  )
  assert.equal(chapters[0].title, '为圣人立传')
  assert.deepEqual(chapters[0].blocks.map((b) => b.kind), ['paragraph'], 'no duplicate <h2>')
})

test('assembleChapters keeps an in-prose heading that is not the chapter title', () => {
  const chapters = assembleChapters(
    [columnInput([line(0.18, '炼金之秘', { w: 0.28, h: LH * 1.3 }), ...body(0.29, 5)], '为圣人立传', true)],
    '测试书',
  )
  assert.deepEqual(chapters[0].blocks.map((b) => b.kind), ['heading', 'paragraph'])
  assert.equal(of(chapters[0].blocks[0], 'heading').text, '炼金之秘')
})

test('assembleChapters names the first chapter after the book when it has no header', () => {
  const chapters = assembleChapters([columnInput([full(0.12, '一'.repeat(21))], null, true)], '测试书')
  assert.equal(chapters[0].title, '测试书')
})

/* --------------------------------------------------------------------- epub */

function chaptersFixture(): EpubChapter[] {
  return [
    {
      title: '序言 真相出现',
      blocks: [
        { kind: 'paragraph', text: '牛顿排名第二，仅居于穆罕默德之后。', suspect: false, suspects: [] },
        { kind: 'image', id: 'img0055' },
        { kind: 'heading', text: '炼金之秘' },
        { kind: 'paragraph', text: '是使马基人注心悦诚服的最后一个神童。', suspect: true, suspects: ['是使马基人注心悦诚服的最后一个神童。'] },
      ],
    },
  ]
}

test('buildChapterXhtml emits well-formed XHTML with a heading and a plate', () => {
  const xml = buildChapterXhtml(chaptersFixture()[0], 0)
  assert.match(xml, /^<\?xml version="1\.0" encoding="utf-8"\?>/)
  assert.match(xml, /<h1>序言 真相出现<\/h1>/)
  assert.match(xml, /<h2>炼金之秘<\/h2>/)
  assert.match(xml, /<img src="images\/img0055\.jpg" alt=""\/>/)
  // Self-closing tags and no bare ampersands: EPUB is parsed as XML, so a
  // malformed chapter makes the whole book unopenable rather than ugly.
  assert.ok(!/<img [^>]*[^/]>/.test(xml))
})

test('buildChapterXhtml escapes text so a book cannot inject markup', () => {
  const xml = buildChapterXhtml(
    { title: '<script>x</script>', blocks: [{ kind: 'paragraph', text: 'a & b < c', suspect: false, suspects: [] }] },
    0,
  )
  assert.ok(!xml.includes('<script>x</script>'))
  assert.match(xml, /&lt;script&gt;/)
  assert.match(xml, /a &amp; b &lt; c/)
})

test('collectQa reports the recognised fragments, not a score', () => {
  const qa = collectQa(chaptersFixture())
  assert.equal(qa.length, 1)
  assert.equal(qa[0].chapter, '序言 真相出现')
  assert.deepEqual(qa[0].fragments, ['是使马基人注心悦诚服的最后一个神童。'])
})

test('collectQa is silent when nothing was doubtful', () => {
  assert.deepEqual(collectQa([{ title: 'a', blocks: [{ kind: 'paragraph', text: 'b', suspect: false, suspects: [] }] }]), [])
})

function epubMeta(): BookMeta {
  return { ...metaFixture(), title: '牛顿传', outcome: 'complete' }
}

test('buildQaXhtml states what OCR cannot recover and where to look', () => {
  const xml = buildQaXhtml(epubMeta(), chaptersFixture(), collectQa(chaptersFixture()))
  assert.match(xml, /脚注内容没有/)
  assert.match(xml, /会有错字，且无法自检/)
  assert.match(xml, /建议核对的地方（1 处）/)
  assert.match(xml, /是使马基人注心悦诚服的最后一个神童。/)
})

test('buildQaXhtml refuses to imply a clean OCR means correct text', () => {
  const clean: EpubChapter[] = [{ title: 'a', blocks: [{ kind: 'paragraph', text: 'b', suspect: false, suspects: [] }] }]
  const xml = buildQaXhtml(epubMeta(), clean, collectQa(clean))
  assert.match(xml, /这不等于没有错字/)
})

test('buildQaXhtml carries the truncation notice, like the PDF placeholder page', () => {
  const cut = buildQaXhtml({ ...epubMeta(), outcome: 'unauthorized', note: '试读结束' }, chaptersFixture(), [])
  assert.match(cut, /这本书没有抓完/)
  assert.match(cut, /未授权/)
  assert.match(cut, /试读结束/)

  assert.ok(!buildQaXhtml(epubMeta(), chaptersFixture(), []).includes('这本书没有抓完'))
})

test('buildOpf lists every document in the manifest and the spine', () => {
  const opf = buildOpf(epubMeta(), chaptersFixture(), ['img0055'], { author: '迈克尔·怀特' })
  assert.match(opf, /<dc:title>牛顿传<\/dc:title>/)
  assert.match(opf, /<dc:creator>迈克尔·怀特<\/dc:creator>/)
  assert.match(opf, /<dc:identifier id="bookid">urn:weread:a1<\/dc:identifier>/)
  // EPUB 3 requires dcterms:modified, with no sub-second part.
  assert.match(opf, /<meta property="dcterms:modified">2026-01-01T00:00:00Z<\/meta>/)
  assert.match(opf, /href="ch0001\.xhtml"/)
  assert.match(opf, /href="images\/img0055\.jpg" media-type="image\/jpeg"/)
  assert.match(opf, /<itemref idref="ch1"\/>/)
  assert.match(opf, /<itemref idref="qa"\/>/)
})

test('buildNavXhtml links every chapter', () => {
  const nav = buildNavXhtml(epubMeta(), chaptersFixture())
  assert.match(nav, /epub:type="toc"/)
  assert.match(nav, /<a href="ch0001\.xhtml">序言 真相出现<\/a>/)
  assert.match(nav, /<a href="qa\.xhtml">/)
})

/* ---------------------------------------------------------------------- zip */

test('crc32 matches the known value for a standard vector', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926)
})

test('zip puts mimetype first and uncompressed, as EPUB requires', () => {
  const archive = buildEpub(epubMeta(), chaptersFixture(), new Map([['img0055', Buffer.from('jpegbytes')]]))
  // A reader is entitled to find the media type at a fixed offset.
  assert.equal(archive.subarray(0, 4).readUInt32LE(0), 0x04034b50)
  assert.equal(archive.readUInt16LE(8), 0, 'stored, not deflated')
  assert.equal(archive.subarray(30, 38).toString(), 'mimetype')
  assert.equal(archive.subarray(38, 58).toString(), 'application/epub+zip')
})

test('zip round-trips its entries', () => {
  const body = Buffer.from('这是一段中文，需要 deflate 之后还能还原。'.repeat(20), 'utf8')
  const archive = zip([
    { path: 'mimetype', data: Buffer.from('application/epub+zip'), store: true },
    { path: 'OEBPS/第一章.xhtml', data: body },
  ])
  // Central directory is present and counts both entries.
  const eocd = archive.length - 22
  assert.equal(archive.readUInt32LE(eocd), 0x06054b50)
  assert.equal(archive.readUInt16LE(eocd + 10), 2)
  // The deflated entry inflates back to exactly what went in.
  const nameLen = archive.readUInt16LE(30 + 8 + 20 + 26)
  const start = 30 + 8 + 20 + 30 + nameLen
  const compressed = archive.readUInt32LE(30 + 8 + 20 + 18)
  assert.deepEqual(inflateRawSync(archive.subarray(start, start + compressed)), body)
})

test('buildEpub is a pure function of the cache, so the same book gives the same bytes', () => {
  // Entries carry a fixed timestamp on purpose: a reproducible archive is what
  // makes this testable at all.
  const once = buildEpub(epubMeta(), chaptersFixture(), new Map([['img0055', Buffer.from('x')]]))
  const twice = buildEpub(epubMeta(), chaptersFixture(), new Map([['img0055', Buffer.from('x')]]))
  assert.ok(once.equals(twice))
})
