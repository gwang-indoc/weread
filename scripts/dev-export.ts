/**
 * End-to-end check: capture a few screens of one chapter and typeset a PDF.
 *
 * Usage: node scripts/dev-export.ts "我的第一本算法书" 12 4
 *        (book query, TOC index, max screens)
 */
import { openAuthenticated } from '../src/session.ts'
import { listBooks, resolveBook } from '../src/bookshelf.ts'
import { exportBook } from '../src/export.ts'
import { cacheSize, bookDir } from '../src/cache.ts'

const query = process.argv[2] ?? ''
const chapterIndex = Number(process.argv[3] ?? '12')
const maxScreens = Number(process.argv[4] ?? '4')

async function main() {
  const { browser, ctx } = await openAuthenticated({ headed: true, deviceScaleFactor: 3 })
  try {
    const books = await listBooks(ctx)
    const book = query ? resolveBook(books, query) : books[0]
    console.log(`\n  book: ${book.title} (${book.id})`)
    console.log(`  cache: ${bookDir(book.id)}\n`)

    const result = await exportBook(ctx, book, {
      outDir: 'out',
      onlyChapters: [chapterIndex],
      force: true,
      maxScreensPerChapter: maxScreens,
      onProgress: (m) => console.log(`   ${m}`),
    })

    console.log(`\n  captured ${result.chaptersCaptured}, skipped ${result.chaptersSkipped}`)
    console.log(`  cached PNGs: ${await cacheSize(book.id)}`)
    for (const p of result.problems) console.log(`  ⚠ ${p.chapter.title}: ${p.status} ${p.note ?? ''}`)
    console.log(`  pdf: ${result.pdfPath}`)
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  console.error('\nDEV-EXPORT FAILED:', e)
  process.exitCode = 1
})
