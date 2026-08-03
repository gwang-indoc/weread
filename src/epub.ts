/**
 * Packaging recognised text as an EPUB.
 *
 * Everything that decides *what* goes in the file is pure and takes the
 * assembled chapters, so the document can be checked offline; only `writeEpub`
 * touches the disk.
 *
 * The book carries its own quality report as a final section. That is
 * deliberate: the text came from OCR and there is no source to diff it against,
 * so the export cannot claim to be correct — it can only say where to look. A
 * report shipped inside the book travels with it; one printed to a terminal is
 * gone by the time anyone reads the book.
 */
import { writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { zip, type ZipEntry } from './zip.ts'
import { orderedPages, type BookMeta } from './cache.ts'
import { assembleChapters, columnHoles, type ColumnInput, type EpubChapter, type Hole, type ImageBlock } from './text.ts'
import { cropIllustrations, recogniseColumns } from './ocr.ts'

const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

export interface EpubOptions {
  author?: string
  language?: string
}

const chapterFile = (index: number) => `ch${String(index + 1).padStart(4, '0')}.xhtml`

const STYLESHEET = `/* Deliberately minimal: the point of a reflowable book is that the
   reading system decides the type size, margins and theme. */
html { font-size: 100%; }
body {
  margin: 0 1em;
  line-height: 1.75;
  font-family: serif;
  text-align: justify;
  hyphens: auto;
}
h1 { font-size: 1.5em; line-height: 1.4; margin: 1.5em 0 1em; font-weight: normal; }
h2 { font-size: 1.15em; line-height: 1.5; margin: 1.6em 0 0.8em; font-weight: bold; }
p { margin: 0; text-indent: 1.2em; }
/* A paragraph after a heading or a plate starts a new thought, so it is not
   indented — the indent exists to separate consecutive paragraphs. */
h1 + p, h2 + p, .plate + p { text-indent: 0; }
.plate { margin: 1.4em 0; text-align: center; page-break-inside: avoid; }
.plate img { max-width: 100%; height: auto; }
.title-page { margin-top: 25%; text-align: center; }
.title-page h1 { font-size: 1.9em; }
.title-page .author { color: #555; margin-top: 1.5em; text-indent: 0; }
.notice { border: 1px solid #b00; padding: 1em; margin: 2em 0; }
.notice p { text-indent: 0; }
.notice .head { color: #b00; font-weight: bold; }
.qa { font-size: 0.9em; }
.qa li { margin-bottom: 0.6em; }
.qa .where { color: #666; }
`

function xhtml(title: string, body: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh-CN" xml:lang="zh-CN">
<head>
  <meta charset="utf-8"/>
  <title>${escapeXml(title)}</title>
  <link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
${body}
</body>
</html>
`
}

/** One chapter document. Suspect paragraphs are marked so the QA list can link. */
export function buildChapterXhtml(chapter: EpubChapter, index: number): string {
  let suspectSeq = 0
  const parts = [`  <h1>${escapeXml(chapter.title)}</h1>`]

  for (const block of chapter.blocks) {
    if (block.kind === 'heading') {
      parts.push(`  <h2>${escapeXml(block.text)}</h2>`)
    } else if (block.kind === 'image') {
      parts.push(`  <div class="plate"><img src="images/${block.id}.jpg" alt=""/></div>`)
    } else if (block.suspect) {
      const id = `s${index + 1}-${++suspectSeq}`
      parts.push(`  <p id="${id}">${escapeXml(block.text)}</p>`)
    } else {
      parts.push(`  <p>${escapeXml(block.text)}</p>`)
    }
  }

  return xhtml(chapter.title, parts.join('\n'))
}

export function buildTitlePage(meta: BookMeta, opts: EpubOptions): string {
  const author = opts.author ? `  <p class="author">${escapeXml(opts.author)}</p>\n` : ''
  return xhtml(
    meta.title,
    `  <div class="title-page">\n    <h1>${escapeXml(meta.title)}</h1>\n${author}  </div>`,
  )
}

export interface QaEntry {
  chapter: string
  href: string
  fragments: string[]
}

/**
 * Collect the places OCR was unsure of.
 *
 * Reported as fragments with their chapter rather than as a confidence score,
 * because a score invites the reader to trust the rest — and the honest claim is
 * narrower than that: these are the lines worth checking against the app.
 */
export function collectQa(chapters: EpubChapter[]): QaEntry[] {
  const entries: QaEntry[] = []
  for (const [index, chapter] of chapters.entries()) {
    let seq = 0
    const fragments: string[] = []
    for (const block of chapter.blocks) {
      if (block.kind !== 'paragraph' || !block.suspect) continue
      seq++
      fragments.push(...(block.suspects.length ? block.suspects : [block.text.slice(0, 40)]))
    }
    if (fragments.length) {
      entries.push({ chapter: chapter.title, href: chapterFile(index), fragments })
    }
  }
  return entries
}

/**
 * The closing section: how this file was made, what it cannot contain, and the
 * list of lines to spot-check.
 *
 * A truncated capture is stated here as well, mirroring the PDF's placeholder
 * page — the rule across this project is that nothing uneven about an export is
 * left for the reader to discover.
 */
export function buildQaXhtml(meta: BookMeta, chapters: EpubChapter[], entries: QaEntry[]): string {
  const paragraphs = chapters.reduce((n, c) => n + c.blocks.filter((b) => b.kind === 'paragraph').length, 0)
  const plates = chapters.reduce((n, c) => n + c.blocks.filter((b) => b.kind === 'image').length, 0)
  const suspectCount = entries.reduce((n, e) => n + e.fragments.length, 0)

  const incomplete =
    meta.outcome && meta.outcome !== 'complete'
      ? `  <div class="notice">
    <p class="head">⚠ 这本书没有抓完</p>
    <p>${escapeXml(
      meta.outcome === 'unauthorized'
        ? '未授权：试读已结束或未购买，后续内容不在本文件中。'
        : meta.outcome === 'interrupted'
          ? '抓取中断，没有翻到最后一页。'
          : '抓取失败。',
    )}</p>
${meta.note ? `    <p>${escapeXml(meta.note)}</p>\n` : ''}  </div>`
      : ''

  const list = entries.length
    ? `  <h2>建议核对的地方（${suspectCount} 处）</h2>
  <ul class="qa">
${entries
  .map(
    (e) =>
      `    <li><span class="where">${escapeXml(e.chapter)}</span><br/>${e.fragments
        .map((f) => escapeXml(f))
        .join('<br/>')}</li>`,
  )
  .join('\n')}
  </ul>`
    : '  <p>没有低置信度的行。这不等于没有错字，只说明 OCR 没有自己报告疑问。</p>'

  return xhtml(
    '关于这个文件',
    `  <h1>关于这个文件</h1>
${incomplete}
  <p>正文是对微信读书页面截图做 OCR 得到的 —— 微信读书把正文画在 canvas 上，页面里没有文字，所以没有第二条路。共 ${meta.screens.length} 屏、${paragraphs} 段、${plates} 张图。</p>
  <h2>已知会丢的东西</h2>
  <ul>
    <li><strong>脚注内容没有。</strong>标记画在页面上，但注释本身在弹层里，抓取过程从未打开过它。</li>
    <li><strong>斜体、加粗、字色没有。</strong>OCR 只返回纯文本。</li>
    <li><strong>会有错字，且无法自检。</strong>没有原文可以比对，所以下面这份清单只指出「值得看一眼的地方」，不代表其余部分都对。</li>
    <li><strong>章节边界可能差一页。</strong>章节名取自页眉，而页眉比正文滞后最多一页。</li>
  </ul>
${list}
`,
  )
}

export function buildNavXhtml(meta: BookMeta, chapters: EpubChapter[]): string {
  const items = chapters
    .map((c, i) => `      <li><a href="${chapterFile(i)}">${escapeXml(c.title)}</a></li>`)
    .join('\n')
  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh-CN" xml:lang="zh-CN">
<head><meta charset="utf-8"/><title>目录</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>目录</h1>
    <ol>
      <li><a href="title.xhtml">${escapeXml(meta.title)}</a></li>
${items}
      <li><a href="qa.xhtml">关于这个文件</a></li>
    </ol>
  </nav>
</body>
</html>
`
}

export function buildOpf(meta: BookMeta, chapters: EpubChapter[], imageIds: string[], opts: EpubOptions): string {
  const modified = `${new Date(meta.updatedAt).toISOString().replace(/\.\d{3}Z$/, 'Z')}`
  const manifest = [
    '    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '    <item id="style" href="style.css" media-type="text/css"/>',
    '    <item id="title" href="title.xhtml" media-type="application/xhtml+xml"/>',
    ...chapters.map(
      (_, i) => `    <item id="ch${i + 1}" href="${chapterFile(i)}" media-type="application/xhtml+xml"/>`,
    ),
    '    <item id="qa" href="qa.xhtml" media-type="application/xhtml+xml"/>',
    ...imageIds.map((id) => `    <item id="${id}" href="images/${id}.jpg" media-type="image/jpeg"/>`),
  ].join('\n')

  const spine = [
    '    <itemref idref="title"/>',
    '    <itemref idref="nav"/>',
    ...chapters.map((_, i) => `    <itemref idref="ch${i + 1}"/>`),
    '    <itemref idref="qa"/>',
  ].join('\n')

  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="zh-CN">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:weread:${escapeXml(meta.bookId)}</dc:identifier>
    <dc:title>${escapeXml(meta.title)}</dc:title>
    <dc:language>${escapeXml(opts.language ?? 'zh-CN')}</dc:language>
${opts.author ? `    <dc:creator>${escapeXml(opts.author)}</dc:creator>\n` : ''}    <meta property="dcterms:modified">${modified}</meta>
  </metadata>
  <manifest>
${manifest}
  </manifest>
  <spine>
${spine}
  </spine>
</package>
`
}

const CONTAINER = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`

/**
 * Assemble the archive.
 *
 * `mimetype` first and uncompressed is not a style preference — the format
 * requires it so that a reader can identify the file without inflating anything.
 */
export function buildEpub(
  meta: BookMeta,
  chapters: EpubChapter[],
  images: Map<string, Buffer>,
  opts: EpubOptions = {},
): Buffer {
  const utf8 = (s: string) => Buffer.from(s, 'utf8')
  const qa = collectQa(chapters)
  const imageIds = [...images.keys()]

  const entries: ZipEntry[] = [
    { path: 'mimetype', data: utf8('application/epub+zip'), store: true },
    { path: 'META-INF/container.xml', data: utf8(CONTAINER) },
    { path: 'OEBPS/content.opf', data: utf8(buildOpf(meta, chapters, imageIds, opts)) },
    { path: 'OEBPS/nav.xhtml', data: utf8(buildNavXhtml(meta, chapters)) },
    { path: 'OEBPS/style.css', data: utf8(STYLESHEET) },
    { path: 'OEBPS/title.xhtml', data: utf8(buildTitlePage(meta, opts)) },
    ...chapters.map((chapter, index) => ({
      path: `OEBPS/${chapterFile(index)}`,
      data: utf8(buildChapterXhtml(chapter, index)),
    })),
    { path: 'OEBPS/qa.xhtml', data: utf8(buildQaXhtml(meta, chapters, qa)) },
    ...imageIds.map((id) => ({ path: `OEBPS/images/${id}.jpg`, data: images.get(id)!, store: true })),
  ]

  return zip(entries)
}

export async function writeEpub(
  path: string,
  meta: BookMeta,
  chapters: EpubChapter[],
  images: Map<string, Buffer>,
  opts: EpubOptions = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, buildEpub(meta, chapters, images, opts))
}

export interface EpubExportOptions extends EpubOptions {
  /** Re-run OCR even for columns already recognised. */
  force?: boolean
  onProgress?: (msg: string) => void
}

export interface EpubExportResult {
  path: string
  chapters: number
  paragraphs: number
  images: number
  suspects: number
  characters: number
}

/**
 * Produce an EPUB from a book's cache. Never touches the network.
 *
 * The order matters: recognise first, because that is the slow part and it is
 * cached; assemble chapters second, which is pure and therefore free to redo;
 * crop illustrations last, because which regions are illustrations is a
 * conclusion of the assembly, not an input to it.
 */
export async function exportEpub(
  meta: BookMeta,
  outPath: string,
  opts: EpubExportOptions = {},
): Promise<EpubExportResult> {
  const { onProgress = () => {}, force = false, ...epubOpts } = opts
  const pages = orderedPages(meta)
  if (!pages.length) throw new Error(`《${meta.title}》缓存里没有页面，先抓取一次`)

  onProgress(`OCR ${pages.length} 页（结果会缓存，重跑不再识别）…`)
  const recognised = await recogniseColumns(
    meta.bookId,
    pages.map((p) => ({ file: p.file, hash: p.hash })),
    {
      force,
      onProgress: (done, total) => {
        if (done % 20 === 0 || done === total) onProgress(`  已识别 ${done}/${total} 页`)
      },
    },
  )

  // Which regions actually hold a picture is decided from the pixels, and it has
  // to be decided *before* chapters are assembled: an image block interrupts a
  // paragraph, so a column's bottom margin mistaken for a plate would break the
  // stitch to the next column. Every column ends in white space, so geometry
  // alone can never tell the two apart.
  const candidates: Array<{ page: (typeof pages)[number]; hole: Hole; id: string; lineHeight: number }> = []
  for (const page of pages) {
    const column = recognised.get(page.file)
    if (!column) continue
    const { lineHeight, holes } = columnHoles(column)
    for (const hole of holes) {
      candidates.push({ page, hole, lineHeight, id: `img${String(candidates.length).padStart(4, '0')}` })
    }
  }

  onProgress(`检查 ${candidates.length} 处空白区域是否是插图…`)
  const images = await cropIllustrations(
    meta.bookId,
    candidates.map((c) => ({
      file: c.page.file,
      top: c.hole.top,
      height: c.hole.height,
      id: c.id,
      probeInset: c.lineHeight,
      cropInset: c.lineHeight * 0.35,
    })),
  )
  onProgress(`其中 ${images.size} 处是插图，其余是页边距`)

  const confirmed = new Map<string, ImageBlock[]>()
  for (const candidate of candidates) {
    if (!images.has(candidate.id)) continue
    const list = confirmed.get(candidate.page.file) ?? []
    list.push({ kind: 'image', top: candidate.hole.top, height: candidate.hole.height, id: candidate.id })
    confirmed.set(candidate.page.file, list)
  }

  const columns: ColumnInput[] = []
  for (const page of pages) {
    const column = recognised.get(page.file)
    if (!column) continue
    columns.push({
      column,
      header: page.header,
      isUnitStart: page.isUnitStart,
      images: confirmed.get(page.file) ?? [],
    })
  }

  const kept = assembleChapters(columns, meta.title)

  await writeEpub(outPath, meta, kept, images, epubOpts)

  const paragraphs = kept.flatMap((c) => c.blocks).filter((b) => b.kind === 'paragraph')
  return {
    path: outPath,
    chapters: kept.length,
    paragraphs: paragraphs.length,
    images: images.size,
    suspects: collectQa(kept).reduce((n, e) => n + e.fragments.length, 0),
    characters: paragraphs.reduce((n, b) => n + (b.kind === 'paragraph' ? b.text.length : 0), 0),
  }
}
