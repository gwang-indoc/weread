/**
 * Turning recognised lines back into paragraphs.
 *
 * The OCR helper gives us one box of text per line, in coordinates normalised to
 * the column it came from. A column is WeRead's pagination, not the book's
 * structure (ADR 0002), so paragraphs have to be rebuilt from geometry and then
 * stitched back across column and screen boundaries.
 *
 * Every rule here is expressed relative to metrics measured from the column
 * itself — its own median line height, left margin, full measure and character
 * width. Absolute thresholds would break the moment `--scale` changed, or the
 * reader's font size, or the book.
 *
 * Everything in this file is pure. The impure half (running Vision, cropping
 * illustrations out of the cached PNGs) lives in ocr.ts, so these decisions can
 * be tested offline against recorded fixtures.
 */

/** One line as recognised, in fractions of the column's width and height. */
export interface OcrLine {
  /** Top edge, as a fraction of column height. */
  t: number
  /** Left edge, as a fraction of column width. */
  l: number
  /** Width, as a fraction of column width. */
  w: number
  /** Height, as a fraction of column height. */
  h: number
  /** Vision's confidence. Quantised in practice to about {0.3, 0.5, 0.75, 1}. */
  c: number
  s: string
}

export interface OcrColumn {
  /** Pixel size of the source PNG, needed to crop illustrations out of it. */
  width: number
  height: number
  lines: OcrLine[]
}

/**
 * Below this, Vision is not reporting text so much as pattern-matching noise —
 * the transcribed scribble of a manuscript facsimile, for instance. The
 * threshold sits at 0.5 because Vision quantises confidence, so nothing real
 * lands between 0.3 and 0.5.
 */
export const CONFIDENT = 0.5

/** A vertical gap this many line heights wide separates paragraphs. */
const PARA_GAP = 1.6
/** A vertical gap this wide is a hole: an illustration, or missed text. */
const HOLE_GAP = 2.2
/** Taller than this multiple of the median line is heading-sized. */
const HEADING_HEIGHT = 1.2

function median(values: number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/**
 * Visual length in character widths: a CJK glyph occupies twice the advance of
 * an ASCII one, and mixing them is what makes a naive `s.length` misjudge how
 * full a line is.
 */
export function visualLength(s: string): number {
  let n = 0
  for (const ch of s) n += /[⺀-鿿豈-﫿＀-｠]/.test(ch) ? 1 : 0.5
  return n
}

export interface ColumnMetrics {
  /** Median height of a body line. */
  lineHeight: number
  /** Left edge shared by unindented lines. */
  margin: number
  /** Width of a line that runs the full measure. */
  measure: number
  /** Width of one CJK character, derived from the text rather than assumed. */
  charWidth: number
}

/**
 * Measure the column before interpreting it.
 *
 * Metrics come from confident lines only where any exist: on an illustrated page
 * the noise lines outnumber the real ones, and letting them set the median line
 * height would misclassify the prose that shares the page.
 */
export function columnMetrics(lines: OcrLine[]): ColumnMetrics {
  const confident = lines.filter((l) => l.c >= CONFIDENT)
  const basis = confident.length ? confident : lines
  if (!basis.length) return { lineHeight: 0.03, margin: 0, measure: 1, charWidth: 0.05 }

  const lineHeight = median(basis.map((l) => l.h)) || 0.03
  const measure = Math.max(...basis.map((l) => l.w))

  // The margin is the left edge most lines share, not the smallest one: a
  // single stray box with a negative left would otherwise define the margin and
  // make every real line look indented.
  const buckets = new Map<number, number>()
  for (const l of basis) {
    const key = Math.round(Math.max(0, l.l) * 100)
    buckets.set(key, (buckets.get(key) ?? 0) + 1)
  }
  let margin = 0
  let best = -1
  for (const [key, count] of buckets) {
    // Ties go to the left-most bucket, which is the true margin when a column
    // has as many indented lines as unindented ones.
    if (count > best || (count === best && key / 100 < margin)) {
      best = count
      margin = key / 100
    }
  }

  // Derive the character width from the widest line's own text, so it is right
  // for this book's font size at this --scale rather than assumed.
  const widest = basis.reduce((a, b) => (b.w > a.w ? b : a))
  const chars = visualLength(widest.s)
  const charWidth = chars > 0 ? widest.w / chars : measure / 20

  return { lineHeight, margin, measure, charWidth }
}

const overlap = (a: OcrLine, b: OcrLine) => {
  const left = Math.max(a.l, b.l)
  const right = Math.min(a.l + a.w, b.l + b.w)
  const shared = Math.max(0, right - left)
  return shared / Math.max(0.0001, Math.min(a.w, b.w))
}

/**
 * Collapse the duplicates that overlapping bands produce.
 *
 * Bands overlap by design, so most lines are recognised more than once and the
 * readings differ. Keeping the most confident reading is what makes the banded
 * pass more *accurate* than a single pass, not merely more complete: the same
 * line came back as 「那些近1万年前…我们…」 at 1.00 and 「那些近1万年…找们…」 at
 * 0.50, and the confident one is the correct one.
 *
 * Geometry is the *union* of the group, not the median or the winner's own box.
 * A band can cut a line horizontally, and Vision then recognises only the
 * characters it could see, so a clipped reading reports a box that is too small
 * — never too large. Taking the union is therefore the only measure that cannot
 * under-report, and under-reporting width is expensive: a full line measured
 * short reads as the end of a paragraph, which splits it mid-sentence. (Observed
 * on 牛顿传: a complete 21-character line whose median width came out at 60% of
 * the measure, because two of its three readings were clipped.)
 */
export function mergeLines(lines: OcrLine[], lineHeight: number): OcrLine[] {
  const sorted = [...lines].sort((a, b) => a.t - b.t || a.l - b.l)
  const groups: OcrLine[][] = []

  for (const line of sorted) {
    const centre = line.t + line.h / 2
    const group = groups.find((g) => {
      const other = g[0]!
      const otherCentre = other.t + other.h / 2
      return Math.abs(centre - otherCentre) < lineHeight * 0.45 && overlap(line, other) > 0.6
    })
    if (group) group.push(line)
    else groups.push([line])
  }

  return groups
    .map((group) => {
      const winner = [...group].sort((a, b) => b.c - a.c || visualLength(b.s) - visualLength(a.s))[0]!
      const top = Math.min(...group.map((g) => g.t))
      const left = Math.min(...group.map((g) => g.l))
      return {
        s: winner.s,
        c: Math.max(...group.map((g) => g.c)),
        t: top,
        l: left,
        w: Math.max(...group.map((g) => g.l + g.w)) - left,
        h: Math.max(...group.map((g) => g.t + g.h)) - top,
      }
    })
    .sort((a, b) => a.t - b.t)
}

/**
 * Rejoin one visual line that came back as two boxes side by side.
 *
 * Vision splits a line where something interrupts it — a painted footnote marker
 * mid-sentence is enough. The two halves then each look like a short line, which
 * reads as a paragraph ending mid-sentence *and* stops the next column from
 * being stitched on. Observed on 牛顿传: 「手资料为基础写成的，」 at l=0.00–0.45
 * and 「故而是十分重要的一部」 at l=0.46–1.00 are one line of a paragraph that
 * continues for another three.
 *
 * Only rightward continuations are joined. A box starting left of where the last
 * one ended is a duplicate reading, and `mergeLines` has already resolved those.
 *
 * Confidence of the join is the *lowest* of its parts: half a line read poorly
 * makes the whole line worth checking, which is what the QA report wants.
 */
export function joinBaselines(lines: OcrLine[], m: ColumnMetrics): OcrLine[] {
  const sorted = [...lines].sort((a, b) => a.t - b.t || a.l - b.l)
  const out: OcrLine[] = []

  for (const line of sorted) {
    const last = out[out.length - 1]
    const sameBaseline =
      last && Math.abs(line.t + line.h / 2 - (last.t + last.h / 2)) < m.lineHeight * 0.45
    const toTheRight = last && line.l >= last.l + last.w - m.charWidth * 0.5

    if (sameBaseline && toTheRight) {
      const bottom = Math.max(last.t + last.h, line.t + line.h)
      last.t = Math.min(last.t, line.t)
      last.h = bottom - last.t
      last.w = line.l + line.w - last.l
      last.c = Math.min(last.c, line.c)
      last.s = joinText(last.s, line.s)
    } else {
      out.push({ ...line })
    }
  }
  return out
}

/** Characters WeRead paints as a footnote marker, or Vision's guesses at one. */
const MARKER = /^[注註※*＊·°口回困®④⑤0-9①-⑳(){}[\]（）]{1,2}$/

/**
 * A speck: a footnote marker or a stray glyph, not a line of prose.
 *
 * WeRead paints its 「注」 markers into the canvas, and Vision reports them as
 * one- or two-character boxes floating to the right of the text. Two ways in:
 * low confidence, or a confident read that is literally just a marker glyph.
 * Both are gated on the box being only a few characters wide, which is what
 * keeps this from eating a genuinely short last line of a paragraph.
 */
export function isSpeck(line: OcrLine, m: ColumnMetrics): boolean {
  const text = line.s.trim()
  if (text.length > 2 || line.w >= m.charWidth * 3) return false
  return line.c < CONFIDENT || MARKER.test(text)
}

/**
 * Noise: recognised where there is no text to recognise.
 *
 * Two signals together, never confidence alone — a legitimate centred caption
 * also comes back at 0.5. Either the box is far shorter than a body line, or it
 * sits well inside the text area where prose never starts.
 */
export function isNoise(line: OcrLine, m: ColumnMetrics): boolean {
  if (line.c >= CONFIDENT) return false
  const short = line.h < m.lineHeight * 0.62
  const inset = line.l > m.margin + m.charWidth * 2.5
  return short || inset
}

/** A region of the column with nothing legible in it. */
export interface Hole {
  top: number
  height: number
}

/**
 * Find the vertical holes in a column, over *all* lines including noise.
 *
 * Two things use this. A hole may be an illustration — but it may equally be
 * text Vision silently declined to detect, which is the failure ADR 0003
 * describes, so ocr.ts re-recognises each hole on its own before concluding it
 * is a picture. Noise counts as occupancy here: the dense scribble of a
 * facsimile is *evidence* of a plate, so re-recognising it would be pointless,
 * whereas the empty strip below it may well hold a subheading.
 */
export function findHoles(lines: OcrLine[], lineHeight: number, minGap = HOLE_GAP): Hole[] {
  const spans = [...lines]
    .map((l) => ({ top: l.t, bottom: l.t + l.h }))
    .sort((a, b) => a.top - b.top)

  const holes: Hole[] = []
  let cursor = 0
  for (const span of spans) {
    if (span.top - cursor > lineHeight * minGap) holes.push({ top: cursor, height: span.top - cursor })
    cursor = Math.max(cursor, span.bottom)
  }
  if (1 - cursor > lineHeight * minGap) holes.push({ top: cursor, height: 1 - cursor })
  return holes
}

export interface HeadingBlock {
  kind: 'heading'
  text: string
}

export interface ParagraphBlock {
  kind: 'paragraph'
  text: string
  /** The last line ran the full measure, so the paragraph may continue. */
  openEnd: boolean
  /** The first line was neither indented nor preceded by a break. */
  openStart: boolean
  /** Some line in it was recognised at low confidence — for the QA report. */
  suspect: boolean
  /** The low-confidence lines themselves, so the report can name them. */
  suspects: string[]
}

export interface ImageBlock {
  kind: 'image'
  /** Region of the source column, as fractions of its height. */
  top: number
  height: number
  /** Name this crop has inside the EPUB. */
  id: string
}

export type Block = HeadingBlock | ParagraphBlock | ImageBlock

/** Join two line fragments. A CJK line wrap is not a word break. */
export function joinText(left: string, right: string): string {
  const a = left.replace(/\s+$/, '')
  const b = right.replace(/^\s+/, '')
  if (!a) return b
  if (!b) return a
  const needsSpace = /[0-9A-Za-z]$/.test(a) && /^[0-9A-Za-z]/.test(b)
  return needsSpace ? `${a} ${b}` : a + b
}

/**
 * The regions of a column that might hold an illustration.
 *
 * Candidates only. Whether a region is a picture or just the column's bottom
 * margin cannot be settled from the recognised text — every column ends with
 * white space — so it is settled by looking at the pixels, in ocr.ts. Doing that
 * *before* `columnBlocks` matters: an image block interrupts a paragraph, and a
 * bottom margin mistaken for a plate would break the stitch to the next column.
 */
export function columnHoles(column: OcrColumn): { lineHeight: number; holes: Hole[] } {
  const m = columnMetrics(column.lines)
  return { lineHeight: m.lineHeight, holes: findHoles(mergeLines(column.lines, m.lineHeight), m.lineHeight) }
}

/**
 * Interpret one column as an ordered list of blocks.
 *
 * `header` is the running header recorded at capture time. WeRead paints it into
 * the canvas as well, so the topmost line is dropped when it repeats the header
 * — otherwise every page would open with its own chapter title as prose.
 *
 * `images` are the regions already confirmed to hold a picture. Regions not in
 * this list are treated as ordinary white space, which is what they usually are.
 */
export function columnBlocks(column: OcrColumn, header: string | null, images: ImageBlock[] = []): Block[] {
  const m = columnMetrics(column.lines)
  const merged = mergeLines(column.lines, m.lineHeight)

  const normalise = (s: string) => s.replace(/\s+/g, '')
  // Specks go before baselines are joined, so a footnote marker floating beside a
  // line is discarded rather than concatenated into it.
  const kept = merged.filter((line, index) => {
    if (isSpeck(line, m)) return false
    if (isNoise(line, m)) return false
    // The painted running header, only ever the first thing on the page.
    if (index === 0 && header && normalise(line.s) === normalise(header)) return false
    return true
  })
  const usable = joinBaselines(kept, m)

  const pending = [...images].sort((a, b) => a.top - b.top)

  const isIndented = (line: OcrLine, next: OcrLine | undefined) => {
    const indent = line.l - m.margin
    if (indent < m.charWidth * 0.6) return false
    // A first-line indent indents *one* line. A block inset on every line is a
    // continuation that happens to sit further right, and treating it as a new
    // paragraph would break the stitch to the previous column.
    if (next && next.l - m.margin >= m.charWidth * 0.6) return false
    return true
  }

  const runsFullMeasure = (line: OcrLine) => line.w >= m.measure - m.charWidth * 1.4

  const isHeading = (line: OcrLine, gapAbove: number, isFirst: boolean) =>
    line.h > m.lineHeight * HEADING_HEIGHT &&
    (isFirst || gapAbove > m.lineHeight * 1.3) &&
    line.w < m.measure * 0.95

  const blocks: Block[] = []
  let current: { lines: OcrLine[]; openStart: boolean } | null = null

  const flush = () => {
    if (!current) return
    const text = current.lines.reduce((acc, l) => joinText(acc, l.s), '')
    if (text.trim()) {
      const suspects = current.lines.filter((l) => l.c < 1).map((l) => l.s.trim())
      blocks.push({
        kind: 'paragraph',
        text: text.trim(),
        openEnd: runsFullMeasure(current.lines[current.lines.length - 1]!),
        openStart: current.openStart,
        suspect: suspects.length > 0,
        suspects,
      })
    }
    current = null
  }

  // Blocks come out in reading order, so illustrations are interleaved by
  // position rather than appended at the end of the page.
  const emitImagesAbove = (limit: number) => {
    while (pending.length && pending[0]!.top < limit) {
      flush()
      blocks.push(pending.shift()!)
    }
  }

  for (const [index, line] of usable.entries()) {
    const previous = usable[index - 1]
    const gapAbove = previous ? line.t - (previous.t + previous.h) : line.t
    emitImagesAbove(line.t)

    if (isHeading(line, gapAbove, index === 0)) {
      flush()
      blocks.push({ kind: 'heading', text: line.s.trim() })
      continue
    }

    const breaks =
      !previous ||
      gapAbove > m.lineHeight * PARA_GAP ||
      !runsFullMeasure(previous) ||
      isIndented(line, usable[index + 1])

    // `!current` matters as much as `breaks`: a heading or an illustration closes
    // the paragraph before it, and the line after one may well look like a
    // continuation — same measure, ordinary gap — with nothing left to continue.
    if (breaks || !current) {
      flush()
      // Only a paragraph that opens the column with no break of its own can be
      // the continuation of the previous column.
      const openStart = index === 0 && !isIndented(line, usable[1]) && blocks.length === 0
      current = { lines: [line], openStart }
    } else {
      current.lines.push(line)
    }
  }
  flush()
  emitImagesAbove(Infinity)

  return blocks
}

export interface ColumnInput {
  column: OcrColumn
  header: string | null
  /** True where the running header changed, i.e. a new chapter starts here. */
  isUnitStart: boolean
  /** Regions of this column confirmed to hold a picture, already cropped. */
  images: ImageBlock[]
}

export type ChapterBlock =
  | HeadingBlock
  | { kind: 'paragraph'; text: string; suspect: boolean; suspects: string[] }
  | { kind: 'image'; id: string }

export interface EpubChapter {
  title: string
  blocks: ChapterBlock[]
}

/**
 * Assemble columns into chapters, stitching paragraphs across column and screen
 * boundaries.
 *
 * A paragraph is *not* stitched across a chapter boundary even when the geometry
 * says it continues: the running header lags the display by up to a page
 * (ADR 0002), so a boundary can fall mid-paragraph, and joining across it would
 * pull the opening of one chapter into the end of the previous one. Closing the
 * paragraph keeps the error to the page-level imprecision the reader itself has.
 */
export function assembleChapters(columns: ColumnInput[], fallbackTitle: string): EpubChapter[] {
  const chapters: EpubChapter[] = []
  let openEnd = false
  const normalise = (s: string) => s.replace(/\s+/g, '')

  for (const input of columns) {
    if (!chapters.length || input.isUnitStart) {
      chapters.push({ title: input.header ?? (chapters.length ? '（无标题）' : fallbackTitle), blocks: [] })
      openEnd = false
    }
    const chapter = chapters[chapters.length - 1]!

    for (const [index, block] of columnBlocks(input.column, input.header, input.images).entries()) {
      if (block.kind === 'image') {
        chapter.blocks.push({ kind: 'image', id: block.id })
        openEnd = false
        continue
      }
      if (block.kind === 'heading') {
        // WeRead paints the chapter title into the page as well as into the
        // running header, so the chapter would otherwise open with its own name
        // twice — once as the <h1> we derived from the header, once as this.
        const duplicate = !chapter.blocks.length && normalise(block.text) === normalise(chapter.title)
        if (!duplicate) chapter.blocks.push(block)
        openEnd = false
        continue
      }

      const previous = chapter.blocks[chapter.blocks.length - 1]
      const continues = index === 0 && block.openStart && openEnd && previous?.kind === 'paragraph'
      if (continues) {
        previous.text = joinText(previous.text, block.text)
        previous.suspect = previous.suspect || block.suspect
        previous.suspects = [...previous.suspects, ...block.suspects]
      } else {
        chapter.blocks.push({ kind: 'paragraph', text: block.text, suspect: block.suspect, suspects: block.suspects })
      }
      openEnd = block.openEnd
    }
  }

  return chapters.filter((c) => c.blocks.length > 0)
}
