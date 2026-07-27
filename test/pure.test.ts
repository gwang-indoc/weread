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
import { bookIdFromUrl, resolveBook } from '../src/bookshelf.ts'
import { sameTitle, resumeIndex } from '../src/export.ts'
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
