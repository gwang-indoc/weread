/**
 * End-to-end check: page through the start of a book and typeset a PDF.
 *
 * Usage: node scripts/dev-export.ts "牛顿传" 8
 *        (book query, max screens — defaults to 8)
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

    /**
     * `force` below is `clearBook()`, which is `rm -rf` on the directory printed
     * above. It is here because this check has to walk the *start* of a book —
     * without it the walk resumes wherever the cache left off, and a finished
     * book would capture nothing at all.
     *
     * The thing worth noticing is that on the scratch HOME this script is meant
     * to be run under, the cache is empty and force deletes nothing. So force
     * only ever destroys something in exactly the situation that must not
     * happen: pointed at the real cache, where a book can be hundreds of
     * megabytes and hours of serial capture that cannot be re-fetched quickly.
     *
     * With no book argument the target is books[0] — whatever happens to be
     * first on the shelf, which is not a stable choice and not necessarily the
     * one you had in mind. Refusing is therefore the default, and the recipe in
     * CLAUDE.md is the way through.
     */
    const cached = await cacheSize(book.id)
    if (cached > 0 && !process.env.WEREAD_DEV_FORCE) {
      console.error(
        `\n  拒绝执行：《${book.title}》已有 ${cached} 个缓存页面，本脚本会先删掉整个目录重抓。\n` +
          `  ${bookDir(book.id)}\n\n` +
          `  改用临时 HOME（CLAUDE.md 的做法），缓存是空的，不会碰到真实缓存：\n` +
          `    export SCRATCH=$(mktemp -d)\n` +
          `    mkdir -p "$SCRATCH/.config/weread-export"\n` +
          `    cp ~/.config/weread-export/session.json "$SCRATCH/.config/weread-export/"\n` +
          // The book query is argv[2], so it is spelled out even when this run
          // had none: printing just the number would put it in the query slot
          // and send the next run looking for a book called "8".
          `    HOME=$SCRATCH node scripts/dev-export.ts "${query || book.title}" ${maxScreens}\n\n` +
          `  确实要删掉这本书的缓存重抓，请显式声明：WEREAD_DEV_FORCE=1\n`,
      )
      process.exitCode = 1
      return
    }

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
