# 0003 — OCR the cache into reflowable text for EPUB

Date: 2026-08-03
Status: Accepted
Builds on [0001](0001-capture-canvas-pixels.md) and [0002](0002-walk-the-book-linearly.md)

## Context

ADR 0001 established that book prose is painted to `<canvas>`, so what we can
obtain is pixels, and it deliberately cached page images rather than a finished
PDF so that "searchability remains reachable later via OCR over the cache,
without re-scraping". This is that pass.

A PDF of page images is the wrong shape for reading on a phone or an e-reader: it
cannot reflow, cannot be resized, cannot be searched, and a 300-screen book is
360 MB. An EPUB of the same images would be a PDF in EPUB clothing — the format
only earns its keep if the output is *text*.

So the question is not whether we can package an EPUB (trivial) but whether OCR
over the cache yields text good enough to read, and whether page images can be
turned back into paragraphs.

Measured on the existing caches (牛顿传, 达·芬奇手记, `--scale 2`, 1179×2310
columns), using macOS's Vision framework:

- **Recognition quality is high.** On prose pages nearly every line comes back at
  confidence 1.00 and proofreads clean against the source image.
- **Throughput is ~0.2 s per page** for a single full-page pass — about two
  minutes for a 600-page book, entirely local, no API cost.
- **Vision quantises confidence** to roughly {0.30, 0.50, 0.75, 1.00}, which
  turns out to separate signal from noise unusually cleanly (see below).
- **Geometry comes back with the text**, and it is what makes paragraph
  reconstruction possible: line top, left, width and height per line.

Two findings changed the design, and neither was predictable from the outside.

### Vision's detection scale is captured by dense small text

On `达·芬奇手记` page `s00028-c1`, a full-page pass returned 13 lines — *all* of
them gibberish transcribed from a Leonardo manuscript facsimile, and **none** of
the large, perfectly legible Chinese on the same page: not the chapter heading
「手记7 地球的血脉——水流」, not the subheading 「二十五项议题」, not the two
prose lines below it. Reproduced across every combination of
`recognitionLanguages` and `usesLanguageCorrection`.

Cropping the same image into six horizontal bands and recognising each band
separately returns all of it. The hundreds of tiny manuscript strokes appear to
fix the detector's scale and suppress text an order of magnitude larger.

This is not a rare edge case in an illustrated book, and a full-page pass fails
*silently* — it returns plausible-looking output with the prose missing, which is
the worst possible failure mode for an export tool.

### Overlapping bands make the text more accurate, not just more complete

Because bands overlap, most lines are recognised more than once, and the readings
differ. On 牛顿传 `s00005-c0` the same line came back as

- `那些近1万年前就开始构建我们知识遗产的人一` at confidence 1.00, and
- `那些近1万年就开始构建找们知识遗产的人一` at confidence 0.50

— the higher-confidence reading being the correct one. Keeping the
best-confidence reading among duplicates is therefore strictly better than a
single pass, not merely a way to reconcile them.

## Decision

Add EPUB as a second output format, produced by OCR over the existing capture
cache. Four decisions follow.

**1. Recognise in overlapping horizontal bands, always.**

Six bands per column with 25% overlap. Not "full page, and band only when the
result looks suspicious": every suspicion signal we could think of is a
heuristic over the very output we would be doubting, and the failure it guards
against is silent. Banding unconditionally costs ~1.3 s per page instead of
~0.2 s — around 13 minutes for a 600-page book, paid once because the result is
cached — and removes a class of silent omission entirely.

**2. Vision, and therefore macOS only, for EPUB.**

Zero configuration, no model downloads, no API cost, and the quality above.
Capture and PDF export remain cross-platform; `epub` is the one macOS-only
command, and it says so when run elsewhere rather than failing obscurely. The
OCR boundary is a single narrow interface (`ocrColumns`), so a Tesseract backend
can be added later without touching paragraph reconstruction.

**3. Swift does pixels-to-lines; TypeScript does everything else.**

The helper binary is deliberately dumb: it reads image paths, runs Vision per
band, and emits one JSON line per recognised line in *page-global* coordinates.
Merging duplicates, dropping noise, rebuilding paragraphs, finding illustrations
and packaging the EPUB are all pure TypeScript over that data — so they are
testable offline against recorded fixtures, which is this project's rule for
anything that shapes an export.

**4. Rebuild paragraphs from geometry, calibrated per column.**

No absolute thresholds. Each column's own line metrics are measured first — the
median line height, the left margin (the modal line left), the full measure (the
widest line) — and every rule is expressed relative to them, because font size
varies with `--scale`, with the reader's own settings and between books.

- A new paragraph starts on a first-line indent, on a vertical gap wider than
  ~1.6 line heights, or after a line that ended short of the measure.
- Lines within a paragraph are joined **without a space** for CJK, with one
  between Latin/digit boundaries. A CJK line wrap is not a word break, so
  inserting a space there would corrupt every paragraph in the book.
- A paragraph continues across a column, and across a screen, when the previous
  column's last line ran to the full measure and the next column's first line is
  neither indented nor preceded by a gap. Columns are WeRead's pagination, not
  the book's structure, so paragraphs must be stitched back across them.
- A line much taller than the median, isolated by gaps, is a **heading**.
- A vertical run with no usable text, wider than ~2.5 line heights, is an
  **illustration**: that region is cropped out of the cached PNG and embedded.
  This is why illustrated pages keep both their plates and their prose rather
  than becoming one flat image.
- Noise is confidence < 0.50 combined with geometry unlike the body text.
  Footnote *markers* — narrow, low-confidence, one or two characters — are
  dropped as specks.

## Consequences

**What this buys.** A real EPUB: reflowable, searchable, selectable, a few MB
instead of hundreds. Illustrations survive as images in reading order. It is
produced from the cache with no further requests to WeRead, so both books
already captured can be converted offline, and re-running costs nothing because
OCR results are cached per column hash alongside the images.

**Accepted losses, all of them stated in the export rather than hidden.**

- **Footnote content is gone.** Not degraded — absent. The marker is painted into
  the canvas but the note itself lives in a popup the Walk never opens. Markers
  are stripped where they are detectable and may otherwise survive as a stray
  「注」 mid-sentence.
- **Emphasis, weight and colour are lost.** OCR returns plain strings.
- **OCR errors exist and cannot be self-checked.** There is no source text to
  diff against, so the export ships a QA report listing every low-confidence
  line with its page, for spot-checking. The tool must never claim the text is
  correct — only that these are the places to look.

- **Some facsimile gibberish survives into the text, and is left there.** On
  达·芬奇手记 — the most plate-dense book available to test — 61 paragraphs
  totalling 2,482 characters (1.9% of 130k) contain no CJK at all. They are not
  all noise: the list holds `ISBN: 9787553492254` alongside `SYSTEMATIS` and
  `MVNDANI`, which are the Latin inscriptions on a plate of Ptolemy's cosmology,
  and only then the actual gibberish. Dropping non-CJK paragraphs would delete
  the first two, and telling real Latin from letter salad is the same judgement
  Vision already failed at. So they stay, flagged in the QA report. Keeping
  flagged noise is the lesser error: this project does not silently drop content.
- **Chapter splits inherit ADR 0002's imprecision.** Chapters come from the
  running header, which lags the display by up to a page, so a chapter boundary
  in the EPUB can be off by one page — the same error the PDF outline has, and
  the same one the reader itself shows.
- **In-prose headings are recovered by height, so a heading set in bold at body
  size is lost** — it stays a short paragraph. OCR does not report weight, and
  the obvious alternative signal was measured and rejected: on 达·芬奇手记 the
  missed subheadings (「延伸阅读」, 「二十五项议题」, 「四元素说」) are one-line,
  flush-left, ~0.2–0.4 of the measure and end without punctuation — and so are
  plate captions like 「正八面体（风）」. Centring separates only some captions
  (「正四面体（火）」 is centred, 「正八面体（风）」 is not), so promoting these
  would turn captions into headings. Losing the markup keeps the text and its
  order; guessing would corrupt the structure. The running header remains the
  authoritative chapter title; detected headings are additive.

**Revisit if** WeRead ships a DOM-rendered reader (ADR 0001's text path would
then beat OCR outright), or if the banded pass proves too slow on much longer
books, in which case the escape hatch is to band adaptively — but only with a
signal more trustworthy than the output being doubted.
