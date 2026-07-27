/**
 * End-to-end check: page through the start of a book and typeset a PDF.
 *
 * Usage: node scripts/dev-export.ts "牛顿传" 8
 *        (book query, max screens)
 */
import { openAuthenticated } from '../src/session.ts'
import { listBooks, resolveBook } from '../src/bookshelf.ts'
import { exportBook } from '../src/export.ts'
import { cacheSize, bookDir, readMeta } from '../src/cache.ts'

const query = process.argv[2] ?? ''
const maxScreens = Number(process.argv[3] ?? '8')

async function main() {
  const { browser, ctx } = await openAuthenticated({ headed: true })
  try {
    const books = await listBooks(ctx)
    const book = query ? resolveBook(books, query) : books[0]
    console.log(`\n  book: ${book.title} (${book.id})`)
    console.log(`  cache: ${bookDir(book.id)}\n`)

    const result = await exportBook(ctx, book, {
      outDir: 'out',
      force: true,
      maxScreens,
      onProgress: (m) => console.log(`   ${m}`),
    })

    console.log(`\n  屏数 ${result.screensCaptured}，结果 ${result.outcome}${result.note ? ` (${result.note})` : ''}`)
    console.log(`  cached PNGs: ${await cacheSize(book.id)}`)
    console.log(`  pdf: ${result.pdfPath}`)

    // Header labels are what the PDF outline is built from; show them.
    const meta = await readMeta(book.id)
    for (const s of meta?.screens ?? []) console.log(`   s${s.seq} header="${s.header ?? ''}" files=${s.files.length}`)
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  console.error('\nDEV-EXPORT FAILED:', e)
  process.exitCode = 1
})
