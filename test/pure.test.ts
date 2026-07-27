/**
 * Offline tests for the pure parts.
 *
 * Nothing here touches the network or a browser: these are the decisions that
 * shape the export (which TOC entries to walk, how pages are named and ordered,
 * what the print document contains), so they must be checkable without logging
 * into WeRead. The browser-dependent halves are exercised by the dev harness in
 * scripts/ and by the live smoke test.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bookIdFromUrl, resolveBook } from '../src/bookshelf.ts'
import { isCaptureUnit } from '../src/export.ts'
import { screenFileName, orderedPages, isChapterDone, type BookMeta } from '../src/cache.ts'
import { buildHtml } from '../src/render.ts'
import type { Book, Chapter } from '../src/types.ts'

const books: Book[] = [
  { id: 'a1', title: '我的第一本算法书', readerUrl: 'https://weread.qq.com/web/reader/a1' },
  { id: 'b2', title: '马斯克：重回太空', readerUrl: 'https://weread.qq.com/web/reader/b2' },
  { id: 'c3', title: '望向星空深处（天际线）', readerUrl: 'https://weread.qq.com/web/reader/c3' },
]

test('bookIdFromUrl extracts the id, with or without a chapter suffix', () => {
  assert.equal(bookIdFromUrl('https://weread.qq.com/web/reader/a9c32f40717db77aa9c9171'), 'a9c32f40717db77aa9c9171')
  assert.equal(
    bookIdFromUrl('https://weread.qq.com/web/reader/c2d32b90813abb6a8g016c61kc9f326d018c9f0f895fb5e4'),
    'c2d32b90813abb6a8g016c61kc9f326d018c9f0f895fb5e4',
  )
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

test('only level-1 entries are capture units, so 节 are not captured twice', () => {
  // A level-1 chapter followed by its 节: walking the chapter covers both,
  // because the running header does not change across subsections.
  const chapters: Chapter[] = [
    { index: 0, level: 1, title: '扉页' },
    { index: 1, level: 1, title: '第1章 数据结构' },
    { index: 2, level: 2, title: '1-1 什么是数据结构' },
    { index: 3, level: 2, title: '1-2 链表' },
    { index: 4, level: 1, title: '第2章 排序' },
  ]
  assert.deepEqual(
    chapters.filter((c) => isCaptureUnit(chapters, c.index)).map((c) => c.index),
    [0, 1, 4],
  )
})

test('screen file names sort into reading order as plain strings', () => {
  const names = [
    screenFileName(12, 3, 1),
    screenFileName(2, 10, 0),
    screenFileName(12, 3, 0),
    screenFileName(2, 2, 0),
  ]
  assert.deepEqual([...names].sort(), [
    'ch0002-s0002-c0.png',
    'ch0002-s0010-c0.png',
    'ch0012-s0003-c0.png',
    'ch0012-s0003-c1.png',
  ])
})

function metaFixture(): BookMeta {
  return {
    bookId: 'a1',
    title: '测试书',
    chapters: [
      { index: 0, level: 1, title: '第一章' },
      { index: 1, level: 1, title: '第二章' },
      { index: 2, level: 1, title: '第三章' },
    ],
    captured: {
      '1': {
        index: 1,
        title: '第二章',
        level: 1,
        status: 'complete',
        screens: 2,
        files: ['ch0001-s0000-c0.png', 'ch0001-s0000-c1.png', 'ch0001-s0001-c0.png'],
      },
      '0': {
        index: 0,
        title: '第一章',
        level: 1,
        status: 'complete',
        screens: 1,
        files: ['ch0000-s0000-c0.png'],
      },
      '2': { index: 2, title: '第三章', level: 1, status: 'unauthorized', screens: 0, files: [], note: '试读结束' },
    },
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

test('orderedPages walks chapters in index order and flags chapter starts', () => {
  const pages = orderedPages(metaFixture())
  assert.deepEqual(
    pages.map((p) => [p.file, p.isChapterStart]),
    [
      ['ch0000-s0000-c0.png', true],
      ['ch0001-s0000-c0.png', true],
      ['ch0001-s0000-c1.png', false],
      ['ch0001-s0001-c0.png', false],
    ],
  )
})

test('a failed chapter is retried on the next run; settled ones are not', () => {
  const meta = metaFixture()
  assert.equal(isChapterDone(meta, 0), true)
  assert.equal(isChapterDone(meta, 2), true, 'unauthorized is settled, not worth refetching')
  assert.equal(isChapterDone(meta, 99), false, 'never captured')
  meta.captured['0'].status = 'failed'
  assert.equal(isChapterDone(meta, 0), false, 'failures are retried')
})

test('buildHtml emits one page per captured column, with a chapter mark only at chapter starts', () => {
  const html = buildHtml(metaFixture())
  assert.equal((html.match(/class="page content"/g) ?? []).length, 4)
  // Two captured chapters -> two outline entries, not one per page.
  assert.equal((html.match(/class="chapter-mark"/g) ?? []).length, 2)
  assert.match(html, /size: A5 portrait/)
})

test('buildHtml renders a visible placeholder for content it could not export', () => {
  const html = buildHtml(metaFixture())
  assert.match(html, /未授权（试读已结束）/)
  assert.match(html, /第三章/)
})

test('buildHtml escapes titles so a book name cannot inject markup', () => {
  const meta = metaFixture()
  meta.title = '<script>alert(1)</script>'
  const html = buildHtml(meta)
  assert.ok(!html.includes('<script>alert(1)</script>'))
  assert.match(html, /&lt;script&gt;/)
})
