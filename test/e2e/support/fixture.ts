/**
 * A synthetic book, written into a scratch cache for the offline end-to-end gate.
 *
 * Why synthetic rather than a slice of a real capture: a cached page is a
 * publisher's page. This project quotes one book's own 数字版权声明 back at itself
 * — 「仅供您个人使用，未经授权，不得进行传播」 — and a fixture committed to a public
 * repository is distribution. So the prose here is invented, and the page images
 * are drawn from the fixture's own geometry rather than captured (see `png.ts`).
 *
 * Why generated at test time rather than committed: the OCR cache is keyed by the
 * content hash of each page image, so a committed fixture would pin those hashes
 * to whatever zlib produced on the machine that made it. Generating both halves
 * in one pass keeps them consistent by construction, and keeps binaries out of
 * git.
 *
 * ## The one thing that makes this run without macOS
 *
 * `exportEpub` calls Vision twice: once to recognise columns, once to decide
 * whether a hole in a column is an illustration or a page margin. The first is
 * skipped when every column hash is already in `ocr.json`, which this fixture
 * pre-populates. The second is skipped only when there are *no* holes at all —
 * `cropIllustrations` returns before starting Vision on an empty request list.
 *
 * So every column here is laid out to have no hole in it, and `buildColumn`
 * asserts that against `columnHoles`, the real rule. If HOLE_GAP is ever
 * retuned, this fixture fails loudly at generation instead of the gate quietly
 * turning into a macOS-only test that hangs looking for a Swift helper.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { columnHoles, visualLength, type OcrColumn, type OcrLine } from '../../../src/text.ts'
import type { BookMeta, ScreenRecord } from '../../../src/cache.ts'
import { drawPng, type Bar } from './png.ts'

export const BOOK_ID = 'e2efixture'
export const BOOK_TITLE = '夹具之书：一次虚构的远行'

/**
 * A chapter title carrying the three characters XML has to escape. It reaches
 * the EPUB through four separate paths — the OPF, the nav, the chapter's own
 * <h1> and the QA list — and a miss in any one of them is a file no reader can
 * open, which is precisely the failure a structural check should catch.
 */
export const TRICKY_TITLE = '第二章 「山」 & <海> 之间'

/** Fixed, because the OPF stamps dcterms:modified from it and the gate diffs bytes. */
const UPDATED_AT = '2026-02-02T02:02:02.000Z'

// ── Page geometry ────────────────────────────────────────────────────────────
// Horizontal positions are fractions of the column's width, which is the
// coordinate space Vision reports in and `text.ts` reasons in.

/** Visual character widths in one full line. Sets `measure` and `charWidth`. */
const CHARS_PER_LINE = 24
const LEFT = 0.02
const MEASURE = 0.96
const CHAR_W = MEASURE / CHARS_PER_LINE
/**
 * A first-line indent, in character widths.
 *
 * Modelled the way `test/pure.test.ts` models it — the indent moves the box's
 * left edge while the line still runs the full measure — because those fixtures
 * are the ones shaped from real Vision output. It matters that it stays under
 * the 1.4 character widths `runsFullMeasure` tolerates: an indented line that
 * fell short of the measure would read as the *end* of a paragraph, and the line
 * beneath it would start a new one, splitting every indented paragraph after its
 * first line.
 *
 * Note this is a signal, not the mechanism. Paragraphs here are separated
 * primarily by BLOCK_GAP, which is what actually exceeds PARA_GAP.
 */
const INDENT_CHARS = 1.2

/**
 * A line at or above this many characters counts as running the full measure,
 * i.e. its paragraph continues. Mirrors `runsFullMeasure`, which allows a
 * shortfall of 1.4 character widths.
 */
const FULL_MEASURE_CHARS = CHARS_PER_LINE - 1.4

// Vertical positions are laid out in units of one line height and normalised at
// the end, so every gap stays a fixed multiple of the median line — which is
// what all of `text.ts` measures against.

/** Blank above the first line and below the last, in line heights. Under HOLE_GAP. */
const PAGE_MARGIN = 1.0
/** Gap between consecutive lines of one paragraph. Under PARA_GAP. */
const LEADING = 0.25
/** Gap between blocks. Over PARA_GAP (1.6), under HOLE_GAP (2.2). */
const BLOCK_GAP = 1.85
/** Heading line height. Over HEADING_HEIGHT (1.2) times the median. */
const HEADING_H = 1.45

/** Pixel size of a fixture page image. A5-ish, and small enough to stay cheap. */
const PX_W = 640
const PX_H = 900

/**
 * Vision's confidence for a line the fixture wants flagged. Above CONFIDENT
 * (0.5) so it is kept as prose, below 1 so it lands in the QA list — the two
 * conditions together are what "worth checking" means here.
 */
const DOUBTFUL = 0.75

export type Item =
  | { kind: 'heading'; text: string }
  | {
      kind: 'para'
      text: string
      /** First line indented, i.e. this paragraph starts here rather than continuing. */
      indent?: boolean
      /**
       * Whether the last line runs the full measure. Declared rather than
       * inferred, so that editing the prose and silently breaking a stitch the
       * gate is meant to be testing fails at generation instead.
       */
      endsOpen: boolean
      /** Index of the line to report at low confidence. */
      doubtful?: number
    }

/** Greedy wrap by visual width, since a CJK glyph is twice an ASCII one. */
function wrap(text: string, firstLineChars: number): string[] {
  const lines: string[] = []
  let line = ''
  let budget = firstLineChars
  for (const ch of text) {
    const width = visualLength(ch)
    if (visualLength(line) + width > budget && line) {
      lines.push(line)
      line = ''
      budget = CHARS_PER_LINE
    }
    line += ch
  }
  if (line) lines.push(line)
  return lines
}

class FixtureError extends Error {}

/**
 * Lay one column out and check it means what the author said it means.
 *
 * The checks are the point. Each rule in `text.ts` calibrates against the
 * column's own median line and widest line, so a fixture that is merely
 * plausible can exercise a completely different branch than intended — four of
 * this repo's first unit tests failed exactly that way. Here the failure mode is
 * worse, because the gate would still pass: a paragraph that quietly splits
 * still produces a valid EPUB.
 */
export function buildColumn(items: Item[], label: string, problems: string[] = []): OcrColumn {
  const raw: Array<{ t: number; h: number; l: number; w: number; c: number; s: string }> = []
  const complain = (message: string) => problems.push(`${label}: ${message}`)
  let cursor = 0

  for (const [n, item] of items.entries()) {
    if (n > 0) cursor += BLOCK_GAP

    if (item.kind === 'heading') {
      const width = visualLength(item.text)
      if (width >= CHARS_PER_LINE * 0.95) {
        complain(
          `heading 「${item.text}」 is ${width} chars wide; a heading must stay under ` +
            `${CHARS_PER_LINE * 0.95} or isHeading() reads it as a full-measure body line.`,
        )
      }
      raw.push({ t: cursor, h: HEADING_H, l: LEFT, w: width * CHAR_W, c: 1, s: item.text })
      cursor += HEADING_H
      continue
    }

    // The indent shifts the box right without shortening it, so capacity is the
    // same on every line. See INDENT_CHARS.
    const lines = wrap(item.text, CHARS_PER_LINE)

    for (const [i, text] of lines.entries()) {
      const width = visualLength(text)
      const last = i === lines.length - 1

      // Every line but the last has to run the full measure, or `columnBlocks`
      // treats the one after it as a new paragraph and splits this one in half.
      if (!last && width < FULL_MEASURE_CHARS) {
        complain(
          `line ${i + 1} of ${lines.length} is ${width} chars 「${text}」, under the ` +
            `${FULL_MEASURE_CHARS} needed to read as a continuing line. Rewrite the paragraph so ` +
            `it wraps evenly.`,
        )
      }
      if (last && item.endsOpen && width < FULL_MEASURE_CHARS) {
        complain(
          `declared endsOpen, but its last line is ${width}/${CHARS_PER_LINE} chars 「${text}」. ` +
            `Add ${Math.ceil(FULL_MEASURE_CHARS - width)} more characters, or set endsOpen: false.`,
        )
      }
      if (last && !item.endsOpen && width >= FULL_MEASURE_CHARS) {
        complain(
          `declared endsOpen: false, but its last line is ${width}/${CHARS_PER_LINE} chars ` +
            `「${text}」, which reads as a paragraph that continues. Drop ` +
            `${Math.ceil(width - FULL_MEASURE_CHARS) + 1} characters.`,
        )
      }

      if (i > 0) cursor += LEADING
      const indented = i === 0 && item.indent
      raw.push({
        t: cursor,
        h: 1,
        l: indented ? LEFT + INDENT_CHARS * CHAR_W : LEFT,
        w: width * CHAR_W,
        c: item.doubtful === i ? DOUBTFUL : 1,
        s: text,
      })
      cursor += 1
    }
  }

  if (!raw.length) complain('a column needs at least one line')

  // Normalise into [0, 1] with a page margin above and below. Scaling every
  // vertical measure by the same factor leaves each gap the same multiple of the
  // line height, so all of text.ts's relative thresholds hold whatever the
  // column ended up containing.
  const k = 1 / (cursor + PAGE_MARGIN * 2)
  const lines: OcrLine[] = raw.map((l) => ({
    t: (l.t + PAGE_MARGIN) * k,
    h: l.h * k,
    l: l.l,
    w: l.w,
    c: l.c,
    s: l.s,
  }))

  const column: OcrColumn = { width: PX_W, height: PX_H, lines }

  // The load-bearing check: a hole would send `exportEpub` to Vision, and the
  // gate would stop being offline. See the header comment.
  const { holes } = columnHoles(column)
  if (holes.length) {
    complain(
      `${holes.length} hole(s) — ${holes
        .map((h) => `${h.top.toFixed(3)}+${h.height.toFixed(3)}`)
        .join(', ')}. A hole makes exportEpub call Vision to test it for an illustration, ` +
        `which makes this gate macOS-only. Tighten PAGE_MARGIN or BLOCK_GAP.`,
    )
  }

  return column
}

/** Where a column's lines land on its page image, so the PNG shows the same book. */
function barsFor(column: OcrColumn): Bar[] {
  return column.lines.map((line) => ({
    x: line.l * PX_W,
    y: line.t * PX_H,
    width: line.w * PX_W,
    height: line.h * PX_H * 0.72,
    grey: line.c < 1 ? 0x99 : 0x22,
  }))
}

/** One screen: WeRead shows two columns side by side, and both are captured. */
interface ScreenSpec {
  header: string
  columns: Item[][]
}

/**
 * The book.
 *
 * Laid out to exercise the things that have actually gone wrong in this repo,
 * each noted where it happens. Screens 0 and 1 share a running header, so they
 * are one chapter; screens 2 and 3 each start a new one.
 */
const SCREENS: ScreenSpec[] = [
  {
    header: '第一章 出发',
    columns: [
      [
        // WeRead paints the chapter title into the page as well as into the
        // running header, so this must be dropped rather than appearing under
        // the <h1> derived from the same string.
        { kind: 'heading', text: '第一章 出发' },
        {
          kind: 'para',
          indent: true,
          endsOpen: true,
          text: '这本书并不存在，它是为了检验导出流程而写下的一段文字。它需要占满一整栏的版面，好让每一行都跑满行宽，也让最后一行在换栏的地方停下来而不收尾，这样拼接的规则才有东西可以拼。读到这里请放心，后面并没有真正的情节在等着你，只有一段接着一段的空话。',
        },
      ],
      [
        // Continues the paragraph above, across a column boundary: no indent,
        // first thing in the column, nothing before it.
        {
          kind: 'para',
          endsOpen: false,
          text: '这一段是上一栏的下半截，它没有首行缩进，也不是这一栏里的第二个块，所以拼接的规则应当把它接回去而不是另起一段。如果两栏之间断开了，导出的正文里就会出现一句被劈成两半的话。',
        },
        {
          kind: 'para',
          indent: true,
          endsOpen: false,
          text: '这是第二段，它有首行缩进，因此无论上一段有没有收尾，它都必须独立成段。缩进是段落开始的信号，而不是排版的装饰，这一点在竖排和横排里都一样。',
        },
      ],
    ],
  },
  {
    header: '第一章 出发',
    columns: [
      [
        {
          kind: 'para',
          indent: true,
          endsOpen: false,
          // One line comes back at low confidence, so it survives as prose but
          // is listed in 关于这个文件 — the report that must never be presented
          // as an accuracy score.
          doubtful: 1,
          text: '有些行识别得并不好，它们仍然是正文的一部分，不应该被悄悄删掉。正确的做法是把它们照原样留在书里，同时在文件末尾列出来，让读者知道哪几处值得自己去对一眼原文。',
        },
      ],
      [
        {
          kind: 'para',
          indent: true,
          endsOpen: false,
          text: '这一栏先有一段正文，然后是一个真正的小标题。它和章节名不同，不会被当作重复的标题丢掉，所以导出的结果里应该看得见它。',
        },
        { kind: 'heading', text: '一 关于这次远行' },
        {
          kind: 'para',
          indent: true,
          endsOpen: false,
          text: '小标题后面的第一段不能被接到标题前面那一段上去。标题会关掉上一段，即使这一段看起来还在同一个版心里继续。',
        },
      ],
    ],
  },
  {
    header: TRICKY_TITLE,
    columns: [
      [
        { kind: 'heading', text: TRICKY_TITLE },
        {
          kind: 'para',
          indent: true,
          endsOpen: false,
          // The characters XML cannot carry raw, inside prose this time.
          text: '书里本来就会出现 < 和 > 和 & 这样的字符，比如讲到标记语言的时候。它们必须被转义，否则生成的文件根本打不开，而这种错误类型检查看不见。',
        },
      ],
      [
        {
          kind: 'para',
          indent: true,
          endsOpen: false,
          text: '这一栏属于第二章，它和上一栏之间没有跨章拼接的问题，因为两栏的页眉是一样的，都在同一章里面。',
        },
      ],
    ],
  },
  {
    header: '第三章 归程',
    columns: [
      [
        {
          kind: 'para',
          indent: true,
          endsOpen: true,
          text: '第三章从这里开始。上一栏的最后一段并没有跑满行宽，所以就算页眉没有换，拼接也不会把两章的文字连到一起去。这一段自己是跑满了的，它要接到下一栏里。',
        },
      ],
      [
        {
          kind: 'para',
          endsOpen: false,
          text: '而这一段是它的下半截，跨的是屏与屏之间的边界而不是栏与栏之间的。两者在缓存里是一样的东西，都只是按阅读顺序排好的一列页图而已。',
        },
      ],
    ],
  },
]

export interface Fixture {
  cacheRoot: string
  bookDir: string
  meta: BookMeta
}

/**
 * Write the fixture book into `cacheRoot`, which must be a scratch directory.
 *
 * Returns the meta it wrote, so a test can assert against the same numbers the
 * fixture declares rather than hard-coding them twice.
 */
export async function writeFixture(cacheRoot: string): Promise<Fixture> {
  const dir = join(cacheRoot, BOOK_ID)
  await mkdir(dir, { recursive: true })

  const screens: ScreenRecord[] = []
  const columns: Record<string, OcrColumn> = {}
  // Every complaint at once: fixing one wrap usually shifts another, and fixing
  // them one exception at a time is a long afternoon.
  const problems: string[] = []

  for (const [seq, spec] of SCREENS.entries()) {
    const files: string[] = []
    const hashes: string[] = []
    for (const [n, items] of spec.columns.entries()) {
      const column = buildColumn(items, `screen ${seq} column ${n}`, problems)
      const png = drawPng(PX_W, PX_H, barsFor(column))
      // Hashed the way `capture.ts` hashes a real column, so the cache's own
      // identity rule is the one under test rather than a fixture invention.
      const hash = createHash('sha256').update(png).digest('hex').slice(0, 16)
      const name = `s${String(seq).padStart(5, '0')}-c${n}.png`
      await writeFile(join(dir, name), png)
      files.push(name)
      hashes.push(hash)
      columns[hash] = column
    }
    screens.push({ seq, files, hashes, header: spec.header })
  }

  if (problems.length) {
    throw new FixtureError(
      `the fixture book does not say what it claims to say:\n  - ${problems.join('\n  - ')}`,
    )
  }

  const meta: BookMeta = {
    version: 2,
    bookId: BOOK_ID,
    title: BOOK_TITLE,
    chapters: [
      { index: 0, level: 1, title: '第一章 出发' },
      { index: 1, level: 1, title: TRICKY_TITLE },
      { index: 2, level: 1, title: '第三章 归程' },
      // A fourth 目录 entry the walk never reached — which is what makes the
      // outcome below `interrupted` rather than an arbitrary label.
      { index: 3, level: 1, title: '第四章 未抓到的一章' },
    ],
    screens,
    scale: 2,
    outcome: 'interrupted',
    note: '夹具刻意停在第 4 屏',
    updatedAt: UPDATED_AT,
  }

  await writeFile(join(dir, 'meta.json'), JSON.stringify(meta, null, 2))
  await writeFile(join(dir, 'ocr.json'), JSON.stringify({ version: 1, columns }))

  return { cacheRoot, bookDir: dir, meta }
}
