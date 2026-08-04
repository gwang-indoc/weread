#!/usr/bin/env node
/**
 * weread-export — 把微信读书的书导出成 PDF
 *
 * Bare invocation shows a checkbox picker over your 书架; passing titles skips
 * the prompt so the same code path stays scriptable.
 */
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { Command } from 'commander'
import { checkbox, confirm, Separator } from '@inquirer/prompts'
import { login, openAuthenticated, SessionExpiredError, SESSION_PATH, hasSession } from './session.ts'
import { listBooks, resolveBook } from './bookshelf.ts'
import { exportBook } from './export.ts'
import { readMeta, cacheSize, bookDir, listCachedBooks } from './cache.ts'
import { renderPdf } from './render.ts'
import { exportEpub } from './epub.ts'
import { OcrUnavailableError } from './ocr.ts'
import { collectStatus, writeStatusReport } from './status.ts'
import type { Book } from './types.ts'

// Resolves to the package root from both src/ and the built dist/, so the
// reported version can never drift from package.json.
const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

const program = new Command()

program
  .name('weread-export')
  .description('导出微信读书中你有权阅读的书籍为 PDF 或 EPUB（仅供个人使用）')
  .version(version)
  // Without this, the program's own `-o` swallows the flag before a subcommand
  // sees it, because commander lets program options appear anywhere by default.
  // `status -o x.html` and `render -o dir` both silently wrote to `out/`.
  .enablePositionalOptions()

program
  .command('login')
  .description('微信扫码登录，保存会话')
  .action(async () => {
    const vid = await login()
    console.log(`\n  ✓ 已登录 (wr_vid=${vid})`)
    console.log(`  会话保存在 ${SESSION_PATH}`)
  })

program
  .command('list')
  .description('列出书架上的书')
  .action(async () => {
    await withContext(async (ctx) => {
      const books = await listBooks(ctx)
      console.log(`\n  书架（${books.length} 本）\n`)
      for (const b of books) {
        const meta = await readMeta(b.id)
        const cached = meta ? `  · 已缓存 ${await cacheSize(b.id)} 页` : ''
        console.log(`  ${b.title}${cached}`)
      }
    })
  })

program
  .command('status')
  .description('生成一份本地缓存状况报告（HTML，不联网、不需登录）')
  .option('-o, --out <file>', '输出文件', 'out/status.html')
  .option('--open', '生成后直接打开', false)
  .action(async (opts: { out: string; open: boolean }) => {
    // Reads only the cache, so this deliberately skips withContext — no session
    // and no browser needed, and it works while an export is running.
    const view = collectStatus()
    const url = await writeStatusReport(opts.out, view)
    console.log(`\n  ${view.totals.books} 本 · ${view.totals.screens} 屏 · ${view.totals.pages} 张页图 · ${(view.totals.bytes / 1048576).toFixed(1)} MB`)
    for (const b of view.books) {
      const state = b.legacy ? '旧格式' : `${b.screenCount} 屏 · ${b.units.length}/${b.chapters} 单元 · ${b.outcome ?? '-'}`
      console.log(`    · ${b.title} — ${state}`)
    }
    console.log(`\n  ${url}\n`)
    if (opts.open) {
      const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
      spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref()
    }
  })

program
  .command('render <query>')
  .description('只用缓存重新排版 PDF，不联网抓取')
  .option('-o, --out <dir>', '输出目录', 'out')
  .action(async (query: string, opts: { out: string }) => {
    await withContext(async (ctx) => {
      const books = await listBooks(ctx)
      const book = resolveBook(books, query)
      const meta = await readMeta(book.id)
      if (!meta) throw new Error(`《${book.title}》还没有缓存，先运行一次导出`)
      const safe = book.title.replace(/[/\\:*?"<>|]/g, '_').slice(0, 80)
      const out = `${opts.out}/${safe}.pdf`
      await renderPdf(ctx, meta, out)
      console.log(`\n  ✓ ${out}`)
    })
  })

program
  .command('epub <query>')
  .description('把已缓存的书 OCR 成可重排的 EPUB，不联网、不需登录（仅 macOS）')
  .option('-o, --out <dir>', '输出目录', 'out')
  .option('--author <name>', '作者，写入 EPUB 元数据')
  .option('--force', '忽略已有 OCR 结果，重新识别', false)
  .action(async (query: string, opts: { out: string; author?: string; force: boolean }) => {
    // Reads only the cache, so no session and no browser — same as `status`.
    const book = resolveBook(listCachedBooks(), query)
    const meta = await readMeta(book.id)
    if (!meta) throw new Error(`《${book.title}》的缓存是旧格式，需要用 --force 重抓`)

    const safe = book.title.replace(/[/\\:*?"<>|]/g, '_').slice(0, 80)
    const result = await exportEpub(meta, `${opts.out}/${safe}.epub`, {
      force: opts.force,
      ...(opts.author ? { author: opts.author } : {}),
      onProgress: (m) => console.log(`   ${m}`),
    })

    const bytes = statSync(result.path).size
    console.log(`\n  ✓ ${result.path}`)
    console.log(
      `    ${result.chapters} 章 · ${result.paragraphs} 段 · ${result.characters.toLocaleString('zh')} 字 · ` +
        `${result.images} 张图 · ${(bytes / 1048576).toFixed(1)} MB`,
    )
    // Never presented as a quality score: it is the list of places to check.
    if (result.suspects) {
      console.log(`    ⚠ ${result.suspects} 处 OCR 置信度偏低，书末「关于这个文件」列出了它们`)
    }
    if (meta.outcome && meta.outcome !== 'complete') {
      console.log(`    ⚠ ${describeOutcome(meta.outcome)}；EPUB 末尾有说明`)
    }
  })

program
  .argument('[books...]', '书名（可传多个）；不传则进入交互选择')
  .option('-o, --out <dir>', '输出目录', 'out')
  .option('-f, --force', '忽略缓存，重新抓取（会先删掉已有缓存，需确认）', false)
  .option('--yes', '不询问，直接确认 --force 的删除', false)
  .option('--headed', '显示浏览器窗口', false)
  .option('--scale <n>', '抓取分辨率倍数（越大越清晰、文件越大）', '2')
  .option('--format <fmt>', '输出格式：epub、pdf 或 both', 'epub')
  .option('--retry-delay <min>', '抓取中断后休息几分钟再继续，0 表示不重试', '5')
  .option('--max-attempts <n>', '最多尝试几次', '20')
  .option('--max-screens <n>', '最多翻多少屏（调试用）')
  .action(async (queries: string[], opts: Options) => {
    const scale = Number(opts.scale) || 2
    if (!['pdf', 'epub', 'both'].includes(opts.format)) {
      throw new Error(`--format 只能是 epub、pdf 或 both，收到「${opts.format}」`)
    }
    const wantPdf = opts.format !== 'epub'
    const wantEpub = opts.format !== 'pdf'
    const retryMinutes = Number(opts.retryDelay)
    if (!Number.isFinite(retryMinutes) || retryMinutes < 0) {
      throw new Error(`--retry-delay 需要是不小于 0 的分钟数，收到「${opts.retryDelay}」`)
    }
    const maxAttempts = Number(opts.maxAttempts)
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new Error(`--max-attempts 需要是不小于 1 的整数，收到「${opts.maxAttempts}」`)
    }
    await withContext(
      async (ctx) => {
        const books = await listBooks(ctx)
        const chosen = queries.length ? queries.map((q) => resolveBook(books, q)) : await pick(books)
        if (!chosen.length) {
          console.log('  没有选择任何书')
          return
        }

        if (opts.force && !(await confirmForce(chosen, opts.yes))) return

        let failed = false

        for (const book of chosen) {
          console.log(`\n  ── ${book.title} ──`)
          const result = await exportBook(ctx, book, {
            outDir: opts.out,
            force: opts.force,
            scale,
            renderPdf: wantPdf,
            retryDelayMs: retryMinutes * 60_000,
            maxAttempts,
            ...(opts.maxScreens ? { maxScreens: Number(opts.maxScreens) } : {}),
            onProgress: (m) => console.log(`   ${m}`),
          })
          if (result.pdfPath) console.log(`\n  ✓ ${result.pdfPath}`)
          console.log(
            `    共 ${result.screensCaptured} 屏（${result.screensCaptured * 2} 页左右）` +
              (result.attempts > 1 ? ` · ${result.attempts} 次尝试` : ''),
          )

          if (wantEpub) {
            const meta = await readMeta(book.id)
            if (meta) {
              const safe = book.title.replace(/[/\\:*?"<>|]/g, '_').slice(0, 80)
              const epub = await exportEpub(meta, `${opts.out}/${safe}.epub`, {
                onProgress: (m) => console.log(`   ${m}`),
              })
              console.log(`  ✓ ${epub.path}`)
              console.log(
                `    ${epub.chapters} 章 · ${epub.paragraphs} 段 · ${epub.characters.toLocaleString('zh')} 字 · ${epub.images} 张图`,
              )
              if (epub.suspects) console.log(`    ⚠ ${epub.suspects} 处 OCR 置信度偏低，见书末说明`)
            }
          }

          if (result.outcome !== 'complete') {
            failed = true
            console.log(`    ⚠ ${describeOutcome(result.outcome)}${result.note ? `（${result.note}）` : ''}`)
            console.log(`    PDF 末尾有说明页；缓存在 ${bookDir(book.id)}，重跑同一命令会续抓`)
          }
        }
        // Nothing silently incomplete: a gap in the book is a non-zero exit.
        if (failed) process.exitCode = 1
      },
      { headed: opts.headed, deviceScaleFactor: scale },
    )
  })

interface Options {
  out: string
  force: boolean
  yes: boolean
  headed: boolean
  scale: string
  format: string
  retryDelay: string
  maxAttempts: string
  maxScreens?: string
}

function describeOutcome(outcome: string): string {
  if (outcome === 'unauthorized') return '未授权：试读已结束或未购买，后续内容无法导出'
  if (outcome === 'interrupted') return '抓取中断，未翻到最后一页'
  return '抓取失败'
}

/**
 * Confirm the deletion `--force` performs before any of it happens.
 *
 * `--force` is `clearBook()`, an `rm -rf` on the book's cache directory. What
 * makes it worth a prompt rather than a line of help text is the asymmetry of
 * the mistake: capture is deliberately serial with 1–3 s pauses, so a finished
 * book is hours of walking that cannot be re-fetched any faster, while the flag
 * that discards it is one character long and sits next to `-o`.
 *
 * Every book is listed and confirmed once, up front, rather than each being
 * asked about as its turn comes — a multi-book run should not stop for a
 * question twenty minutes in, when the answer is no and everything since the
 * first book was wasted.
 *
 * Note this is the *capture* --force. The one on `epub` discards ocr.json,
 * which is minutes of recognition over a cache that stays put, and is not worth
 * interrupting anyone over.
 */
async function confirmForce(books: Book[], assumeYes: boolean): Promise<boolean> {
  const atRisk = (
    await Promise.all(books.map(async (b) => ({ book: b, pages: await cacheSize(b.id) })))
  ).filter((b) => b.pages > 0)

  // On an empty cache --force deletes nothing, so it earns no ceremony. This is
  // the common case for a first run and must stay silent.
  if (!atRisk.length) return true

  console.log('\n  --force 会先删掉这些书已有的缓存，从头重新抓取：')
  for (const { book, pages } of atRisk) {
    console.log(`    ${book.title} — 已缓存 ${pages} 页`)
    console.log(`      ${bookDir(book.id)}`)
  }
  console.log('    抓取是串行的、每屏 1–3 秒，删掉的部分只能照原速再走一遍。')

  if (assumeYes) {
    console.log('  --yes：已确认\n')
    return true
  }

  // A pipe, a cron job or CI has nobody to answer, and prompting there would
  // hang forever. Proceeding unasked is the exact failure this guard exists to
  // prevent, so the answer is no — and it names the flag that means yes.
  if (!process.stdin.isTTY) {
    console.error('\n  没有终端可以确认（stdin 不是 TTY）。确定要删，请加 --yes。')
    process.exitCode = 1
    return false
  }

  const ok = await confirm({ message: '删掉上面的缓存，重新抓取？', default: false })
  if (!ok) console.log('  已取消，缓存没有改动')
  return ok
}

async function pick(books: Book[]): Promise<Book[]> {
  if (!books.length) return []
  const selected = await checkbox({
    message: `书架（${books.length} 本）— 空格选择，回车开始`,
    pageSize: 15,
    choices: [
      new Separator(' '),
      ...(await Promise.all(
        books.map(async (b) => {
          const cached = await cacheSize(b.id)
          return { name: cached ? `${b.title}  · 已缓存 ${cached} 页` : b.title, value: b }
        }),
      )),
    ],
  })
  return selected
}

async function withContext(
  fn: (ctx: import('playwright-core').BrowserContext) => Promise<void>,
  opts: { headed?: boolean; deviceScaleFactor?: number } = {},
): Promise<void> {
  if (!hasSession()) {
    console.error('  还没有登录，先运行：weread-export login')
    process.exitCode = 1
    return
  }
  const { browser, ctx } = await openAuthenticated(opts)
  try {
    await fn(ctx)
  } finally {
    await browser.close()
  }
}

program.parseAsync(process.argv).catch((e) => {
  if (e instanceof SessionExpiredError) {
    console.error(`\n  ✗ 会话已过期，请重新运行：weread-export login`)
  } else if (e instanceof OcrUnavailableError) {
    // Not a bug and not the user's mistake: EPUB needs Vision, PDF does not.
    console.error(`\n  ✗ ${e.message}`)
  } else if (e && typeof e === 'object' && 'name' in e && e.name === 'ExitPromptError') {
    console.error('\n  已取消')
  } else {
    console.error(`\n  ✗ ${(e as Error).message}`)
  }
  process.exitCode = 1
})
