/**
 * Typesetting captured columns into a PDF.
 *
 * Each captured canvas column becomes one A5 portrait page, which is the shape
 * the source column already has — so nothing is scaled awkwardly or cropped.
 *
 * Chromium does the typesetting via page.pdf(), so there is no separate PDF
 * library: the same Playwright dependency that captures also renders. Bookmarks
 * come from real <h2> elements plus `outline: true`.
 */
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { BrowserContext } from 'playwright-core'
import { bookDir, orderedPages, type BookMeta } from './cache.ts'

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export interface RenderOptions {
  /** Cover image URL, drawn as page 1 when present. */
  coverUrl?: string
  author?: string
  includeToc?: boolean
}

/**
 * Build the print document.
 *
 * A running header carries the chapter title on every page (書 convention), but
 * only a chapter's first page emits an <h2> — otherwise the PDF outline would
 * gain an entry per page instead of per chapter.
 */
export function buildHtml(meta: BookMeta, opts: RenderOptions = {}): string {
  const pages = orderedPages(meta)
  const chapters = meta.chapters

  const cover = opts.coverUrl
    ? `<section class="page cover"><img src="${escapeHtml(opts.coverUrl)}" alt=""></section>`
    : `<section class="page cover cover--text">
         <h1>${escapeHtml(meta.title)}</h1>
         ${opts.author ? `<p class="author">${escapeHtml(opts.author)}</p>` : ''}
       </section>`

  const toc =
    opts.includeToc === false
      ? ''
      : `<section class="page toc">
           <h2 class="toc-title">目录</h2>
           <ul>
             ${chapters
               .map((c) => `<li class="lvl${c.level}">${escapeHtml(c.title)}</li>`)
               .join('\n')}
           </ul>
         </section>`

  const body = pages
    .map(({ file, header, isUnitStart }) => {
      const src = escapeHtml(file)
      const title = escapeHtml(header ?? '')
      // Only a page where the running header changed emits <h2>, so the PDF
      // outline gains one entry per chapter rather than one per page.
      const heading = isUnitStart && title ? `<h2 class="chapter-mark">${title}</h2>` : ''
      return `<section class="page content">
                <div class="runhead">${title}</div>
                ${heading}
                <img class="column" src="${src}" alt="">
              </section>`
    })
    .join('\n')

  // One trailing page when the walk did not reach the end of the book, so an
  // incomplete export can never pass for a complete one.
  const incomplete =
    meta.outcome && meta.outcome !== 'complete'
      ? `<section class="page missing">
           <div class="missing-box">
             <p class="missing-title">⚠ 导出未完成</p>
             <p class="missing-why">${escapeHtml(
               meta.outcome === 'unauthorized'
                 ? '未授权：试读已结束或未购买，后续内容无法导出'
                 : meta.outcome === 'interrupted'
                   ? '抓取中断，本书未翻到最后一页'
                   : '抓取失败',
             )}</p>
             ${meta.note ? `<p class="missing-note">${escapeHtml(meta.note)}</p>` : ''}
             <p class="missing-note">已导出 ${pages.length} 页。重新运行同一命令会从缓存继续。</p>
           </div>
         </section>`
      : ''

  return `<meta charset="utf-8">
<title>${escapeHtml(meta.title)}</title>
<style>
  @page { size: A5 portrait; margin: 8mm 7mm 10mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: "Songti SC", "Source Han Serif SC", "Noto Serif CJK SC", "PingFang SC", serif;
    color: #1a1a1a;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  /*
   * A5 is 148x210mm; with these margins the printable box is 134x192mm.
   * Sizes below are absolute because percentage heights are unreliable in
   * paged media — using them made every section spill onto a second page.
   */
  .page { break-after: page; page-break-after: always; position: relative; overflow: hidden; }
  .page:last-child { break-after: auto; page-break-after: auto; }

  .cover { display: flex; align-items: center; justify-content: center; height: 190mm; }
  .cover img { max-width: 100%; max-height: 100%; object-fit: contain; }
  .cover--text { flex-direction: column; text-align: center; }
  .cover--text h1 { font-size: 24pt; margin: 0 0 8mm; letter-spacing: 0.05em; }
  .cover--text .author { font-size: 12pt; color: #555; margin: 0; }

  .toc-title { font-size: 16pt; text-align: center; margin: 0 0 6mm; letter-spacing: 0.3em; }
  .toc ul { list-style: none; padding: 0; margin: 0; font-size: 9.5pt; line-height: 1.9; }
  .toc .lvl2 { padding-left: 5mm; color: #444; }

  .runhead {
    font-size: 7.5pt; color: #888; letter-spacing: 0.05em;
    padding-bottom: 1.5mm; margin-bottom: 2mm; border-bottom: 0.3pt solid #ddd;
  }
  .chapter-mark { font-size: 11pt; margin: 0 0 3mm; font-weight: normal; }

  /*
   * One captured column per page. A column is roughly 1:2, so height is the
   * binding dimension: cap it below the printable height (leaving room for the
   * running header and any chapter mark) and let width follow the aspect ratio.
   */
  .content { display: flex; flex-direction: column; }
  img.column { display: block; max-height: 172mm; max-width: 100%; width: auto; height: auto; margin: 0 auto; }

  .missing-box { border: 0.5pt dashed #b00; padding: 6mm; margin-top: 20mm; text-align: center; }
  .missing-title { font-size: 12pt; margin: 0 0 3mm; color: #b00; }
  .missing-why { font-size: 10pt; margin: 0; color: #444; }
  .missing-note { font-size: 8pt; color: #777; margin: 2mm 0 0; }
</style>
${cover}
${toc}
${body}
${incomplete}
`
}

/**
 * Render the cached captures to a PDF.
 *
 * The HTML is written into the cache directory and loaded over file:// so the
 * captured PNGs resolve as relative siblings — Chromium blocks file://
 * subresources from a document with no file origin.
 */
export async function renderPdf(
  ctx: BrowserContext,
  meta: BookMeta,
  outPath: string,
  opts: RenderOptions = {},
): Promise<void> {
  const html = buildHtml(meta, opts)
  const dir = bookDir(meta.bookId)
  await mkdir(dir, { recursive: true })
  const htmlPath = join(dir, 'print.html')
  await writeFile(htmlPath, html)

  const page = await ctx.newPage()
  try {
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' })
    // Images are local, but give the layout a beat to settle before printing.
    await page.waitForLoadState('networkidle').catch(() => {})
    await page.pdf({
      path: outPath,
      format: 'A5',
      printBackground: true,
      outline: true,
      tagged: true,
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate:
        '<div style="width:100%;font-size:7pt;color:#999;text-align:center;font-family:serif;">' +
        '<span class="pageNumber"></span></div>',
      margin: { top: '8mm', bottom: '10mm', left: '7mm', right: '7mm' },
    })
  } finally {
    await page.close()
  }
}
