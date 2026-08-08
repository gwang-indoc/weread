# Handoff — weread-export

For someone picking this up cold. Written **2026-07-27**, revised **2026-08-08**
against `main` @ `e01ecfc` (77 unit tests and 24 end-to-end tests passing,
typecheck clean, CI green). The EPUB work it was previously waiting on is
committed (`960bd83`). The cache figures below were measured on 2026-08-05 and
re-checked unchanged on 2026-08-08.

> This is a point-in-time snapshot and will drift. `git log` and the files it
> points at are the current truth; the parts worth keeping are the traps, the
> open decisions, and the conduct notes — those age slowly. If you finish an open
> decision below, strike it here.

## What it is

A CLI that exports books the logged-in WeRead (微信读书) account can already read,
for personal offline use: an A5 PDF of the page images, or a reflowable EPUB of
text recovered from them by OCR. Node 25 + TypeScript, driven by
`playwright-core`, plus macOS's Vision framework for the EPUB path only.

Don't re-derive the design from the code — it is written down:

| Read this | For |
|---|---|
| [`README.md`](../README.md) | install, usage, all commands and flags, known trade-offs |
| [`CLAUDE.md`](../CLAUDE.md) | if you are an agent: it points at everything below and records the house style. Claude Code loads it automatically |
| [`CONTEXT.md`](../CONTEXT.md) | glossary (Book, Export, Screen, Column, Walk, Running Header, …) |
| [`docs/adr/0001-capture-canvas-pixels.md`](adr/0001-capture-canvas-pixels.md) | **why the PDF is images, not text** |
| [`docs/adr/0002-walk-the-book-linearly.md`](adr/0002-walk-the-book-linearly.md) | **why capture is one linear pass, not per chapter** |
| [`docs/adr/0003-ocr-the-cache-into-reflowable-text.md`](adr/0003-ocr-the-cache-into-reflowable-text.md) | **why EPUB is OCR in overlapping bands, and what it cannot recover** |

All three ADRs record the evidence and the rejected alternatives. Read them
before proposing any change to how content is obtained — each documents a design
that was tried and failed for a non-obvious reason.

## Getting it running

```bash
git clone git@github.com:gwang-indoc/weread.git && cd weread
pnpm install && pnpm build      # build explicitly; see README on npm allow-scripts
npm i -g .                      # symlinks the global command at this directory
weread-export login             # QR scan with YOUR OWN WeChat
```

Needs Chrome or Edge installed (no browser is downloaded). `weread-export login`
writes credentials to `~/.config/weread-export/session.json` (mode 0600) — that
file is a live session token; **never commit or share it**. Sessions expire in
days, which is normal; commands detect it and tell you to log in again.

`weread-export status` is the only command that needs neither a session nor a
browser, so it is the safe first thing to run.

## Branches

- `main` — the product.
- `prototype/dashboard-variants` @ `5b168fa` — throwaway: four dashboard designs
  plus the variant switcher, kept as the primary source behind the `status`
  layout. Don't merge it; read it if you want to know what was rejected. Its
  commit message records the verdict.

## Traps that cost real time here

All of these are already handled in the code — this list exists so you don't
"fix" them back. Details are in the commits named.

- **Book prose is canvas pixels, never DOM text.** A sentence visible on screen
  has zero holders in the document. ADR 0001.
- **Chapter boundaries are sub-page.** A 节 can start mid-page, so the running
  header lags by up to a page and clicking a 节 in the 目录 lands on a page still
  headed by the previous one. ADR 0002 — three fixes failed before the linear
  walk.
- **"The book ended" and "the page turn failed" are the same observation.** Both
  are: 下一页 stopped advancing. Taking that at face value records a stalled reader
  as a *complete* export — and the auto-resume, which waits for `interrupted`,
  would never fire. `looksTruncated()` breaks the tie on 目录 position, since we
  already know how long the book is. Its tolerance is capped as a fraction of the
  目录 as well as absolutely: three entries is under 4% of a 196-entry book but half
  of a six-entry one, and being generous is what passes a truncated book off as
  finished. A header *absent* from the 目录 deliberately reads as the end, because
  an unknown header collapses to "still at the beginning" and would retry forever.
- **A page turn dies in three ways, and all three are also how a book ends.**
  `end of book (screen repeated)`, `下一页 not clickable` and `no 下一页 control`.
  Only the first was arbitrated by the 目录 until ADR 0004; the other two were
  treated as failures, so an 860-screen book that finished on its last 目录 entry
  was recorded as `interrupted`, rested twice for five minutes, and shipped an
  EPUB carrying a false 未翻到最后一页 notice. Use `pageTurnExhausted()`; do not
  match those strings anywhere else.
- **A 目录 title is not a unique key, so "where are we" needs the whole trail.**
  《于是一片光明》 lists each chapter title twice — prose, then again under 参考文献 —
  so `findIndex` on the last header put a walk one entry from the end back at
  `#8` of 17. `reachedIndex()` walks the trail forward instead. Two things there
  look wrong and are not: a header matching an entry *just behind* the position is
  ignored (that is the lag, and scanning forward past it takes the duplicate and
  jumps into the back matter), and the position never moves backwards. ADR 0004.
- **Reaching the last 目录 entry once is not the same as being there.** That book
  shows a 致谢 header at screen 645 as well as at 859, its real position — a 目录
  is not always in physical order — so a forward-only position latches 200 screens
  early. `looksTruncated` additionally requires the *last* header to resolve at or
  after the reached entry. The residual limit is real and unfixable from this
  signal: the final three entries of that book cover its last ~200 screens, so a
  stall inside the references still reads as complete.
- **The 目录 panel's backdrop is a full-viewport `.wr_mask` with
  `pointer-events:auto`.** Leaving the panel open makes every later click time
  out. `closeToc()` exists for this; call it after navigating.
- **The panel auto-scrolls when opened**; clicking a row mid-animation hits the
  wrong one. `gotoChapter` waits for the row to stop moving.
- **`innerText` falls back to `textContent` for `display:none` nodes**, so hidden
  pages look populated. Use `Range.getBoundingClientRect()` per text node if you
  ever need to know what is actually painted (`readHeader` does).
- **`.page_show` is also on non-displayed pages** holding back-cover text.
- **An element screenshot includes anything painted over that element** — the
  pager buttons, the 会员卡 banner, other readers' 划线. Hidden during capture
  with `visibility:hidden`, never `display:none`, because removing them from
  layout would reflow the columns and change where pages break mid-walk.
- **A dark reader produces a dark PDF.** The canvas is transparent — only glyphs
  are painted — so the theme must be switched in the reader itself. Restored
  afterwards.
- **`tsc` emits `dist/cli.js` as 644** and `npm i -g .` symlinks rather than
  copies, so nothing chmods it → "permission denied". `scripts/chmod-bin.mjs`
  runs in both `build` and `prepare` (commit `c01bfae`).
- **npm rewrites a `git+ssh` GitHub spec into a codeload HTTPS tarball**, which
  needs credentials for a private repo and triggers the macOS keychain dialog.
  README documents the SSH host alias workaround; local install avoids it
  entirely (commits `7e8ba83`, `b847852`).
- **Commander lets program-level options appear anywhere**, so the root `-o`
  swallowed the flag before a subcommand could see it — `status -o x.html` and
  `render -o dir` both silently wrote to `out/`. Fixed with
  `enablePositionalOptions()`. Options after positional args still work on the
  default path (`weread-export 算法 -o dir` was checked).

### OCR / EPUB traps (ADR 0003)

- **Vision's detection scale gets captured by dense small text, and it fails
  silently.** A full-page pass over an illustrated page returned 13 lines, all of
  them gibberish transcribed from a manuscript facsimile, and **none** of the
  large legible Chinese on the same page — not the heading, not the prose.
  Reproduced across every `recognitionLanguages` / `usesLanguageCorrection`
  combination. This is why recognition runs in overlapping bands
  *unconditionally*: any "band only when the output looks suspicious" test is a
  heuristic over the very output being doubted.
- **Banding alone is not enough.** A band that still contains the facsimile can
  swallow a heading beside it. Every vertical hole is therefore re-recognised on
  its own before it is called a picture.
- **Merged line geometry must be the union of the readings, never the median.** A
  band cuts a line, Vision reads only the characters it can see, and reports a
  box to match — clipped readings under-report and never over-report. A median
  gave a complete 21-character line a width of 60% of the measure, which read as
  a paragraph ending and split it mid-sentence.
- **Vision sometimes returns one visual line as two boxes side by side** (a
  painted footnote marker mid-sentence is enough). Both halves then look short,
  which both splits the paragraph and stops the next column being stitched on.
  `joinBaselines` rejoins them; it must run *after* specks are dropped, or the
  marker gets concatenated into the prose.
- **"Is this region a picture?" cannot be answered from the recognised text.**
  Every column ends in white space, so a bottom margin and a plate look identical.
  It is decided from the pixels, and it must be decided *before* chapters are
  assembled — an image block interrupts a paragraph, so a margin mistaken for a
  plate breaks the stitch to the next column. Getting the order wrong turned 77
  margins into "illustrations" and broke sentences all over the book.
- **Ink fraction alone cannot tell a plate from a rule.** A hairline separator in
  a short region scores *higher* (0.21) than a quotation box outline (0.02), and
  neither is an illustration, while a real plate scores 0.57. The discriminator is
  shape: count rows with substantial ink. Also inset the region before probing —
  Vision's line boxes sit below the actual tops of CJK glyphs, so a region bounded
  by text includes a sliver of that text's ink and reads as a picture.
- **Test fixtures need enough lines to be meaningful.** Every rule in `text.ts` is
  calibrated against the column's own median line height and widest line, so a
  two-line fixture lets the heading under test define what "normal" is. Four of
  the first tests written failed for exactly this reason, not because the code was
  wrong. Use the `body()` helper.
- **Backticks inside the embedded Swift terminate the TypeScript template
  literal.** `VISION_SWIFT` is a `String.raw` template; a Markdown-style
  `` `word` `` in a Swift doc comment produces a baffling parse error tens of
  lines away.

## State of the work

Verified working end to end: login and session reuse, shelf listing, nested 目录,
linear capture with hash-deduped resume, A5 PDF with bookmarks and page numbers,
the `status` report, and the `epub` path (OCR over the cache → reflowable EPUB).

**Three books have now been captured to the end**, which is the claim this
section previously denied. All at `--scale 2`:

| Book | 目录 | Screens | Page images | Cache | Outcome |
|---|---|---|---|---|---|
| 牛顿传（修订版） | 196 | 474 | 948 | 198 MB | `complete` |
| 于是一片光明 | 17 | 860 | 1,720 | 388 MB | `complete` |
| 达·芬奇手记：珍藏版 | 86 | 309 | 618 | 368 MB | `complete` |

953 MB and 1,643 screens in total. Each satisfies ADR 0004's condition — the last
running header resolves to the last 目录 entry — so they are complete by this
project's own definition. Note what that definition cannot see: ADR 0004 records
that the final three entries of 《于是一片光明》 cover roughly its last 200
screens, so a stall inside the back matter would still read as complete. The
`status` unit coverage does not close that gap either, and is not a completeness
measure: it reports 195/196 for 牛顿传, 77/86 for 达·芬奇手记, and **26/17** for
《于是一片光明》 — over 100%, because `unitsOf` opens a new unit whenever a header
recurs after a different one. Don't read a shortfall there as missing content
without checking.

EPUB re-exported from all three finished caches on 2026-08-05, offline via the
built CLI:

| Book | Pages | Chapters | Paragraphs | Characters | Plates | Size | Flagged |
|---|---|---|---|---|---|---|---|
| 牛顿传 | 948 | 195 | 1,995 | 253,671 | 27 | 2.8 MB | 821 |
| 达·芬奇手记 | 618 | 77 | 1,636 | 134,362 | 218 | 26.9 MB | 415 |
| 于是一片光明 | 1,720 | 26 | 4,733 | 524,707 | 64 | 5.4 MB | 1,883 |

"Flagged" is the low-confidence line count in 关于这个文件 — a list of places to
check, never an error rate. Each file was verified with the checkers in
`test/e2e/support/archive.ts`: `mimetype` first and stored, every CRC, XML
structure, manifest matching the archive, no dangling image references. All three
pass, so the end-to-end gate's assertions hold on real books and not only on its
own fixture.

**Correction to a number that was in this section: re-runs are not 1–2 seconds.**
They are 15–23 s per book. Only *recognition* is cached, in `ocr.json`; the
illustration crops are not, and `cropIllustrations` re-runs Vision over every hole
on every export. First OCR of a long book is still the ~7-minute step.

Still untested, and each for a different reason:

- **The 未授权 (trial-expired) path has never once triggered** against a real
  book. It is the only outcome branch with no live evidence at all.
- **Total wall-clock per book is unrecorded.** `meta.json` stores no timing, so
  the finished books above cannot answer how long they took.
- **`--format epub` and `--format both` on the capture path.** The cache holds no
  evidence either way — the EPUBs above came from the from-cache `epub` command.
- **The "400-screens-per-walk guard" this section used to list is not on the
  export path at all.** It is `walkChapter`'s default, and `walkChapter` is
  exported from `src/capture.ts` and called from nowhere — left over from the
  per-chapter design ADR 0002 rejected. The linear walk uses `walkBook`, whose
  `maxScreens` defaults to 3000; an 860-screen book comes nowhere near it.

**The auto-resume loop has run live, and got the verdict wrong once.** An
860-screen walk of 《于是一片光明》 finished on its last 目录 entry, called it
`interrupted`, and rested twice before giving up — the two bugs in ADR 0004. The
arbitration is fixed and replayed against that real cache, which now reads
`complete`. The *resting* half remains unproven, and note that **the cache cannot
settle it**: `meta.json` records `outcome` and `note` but not attempts, so a book
reading `complete` says nothing about whether it rested and resumed along the way.
No stalled reader has been observed recovering after a reload. That reload is the
assumed fix; if resuming turns out not to help, that assumption is still the first
thing to question.

The cache also holds **我的第一本算法书** — v1 legacy, 59 目录 entries, no
`version` field, 0 screens recorded and 2 stray PNGs. `readMeta` refuses it by
design; re-capturing needs `--force` and hours. That is expected, not a bug.
Alongside the book directories there is a `bin/` directory holding the compiled
Vision helper; it has no `meta.json`, so `listCachedBooks` and `collectStatus`
both skip it.

This section is the one that drifts fastest. The `book-export` loop
(`domains/book-export/README.md`) owns keeping it true.

## Open decisions — ask the owner, don't just pick

1. ~~**`--scale` default: keep 3 or drop to 2?**~~ **Settled 2026-07-27: 2.**
   Measured at ~33% smaller and indistinguishable up to 2× zoom. Books whose
   detail you zoom into still want an explicit `--scale 3`. Changing scale on an
   existing cache now warns rather than silently mixing resolutions.
2. **Screenshots in the README?** Would mean committing PNGs; `out/` is
   gitignored. Not done.
3. **Cover image and PDF author metadata** are not wired up — the cover is a
   generated title page. The 目录 page also has no page numbers (Chromium can't
   cross-reference). Both were accepted deviations, both still open.
4. ~~**OCR text layer** deliberately deferred.~~ **Settled 2026-08-03:** built,
   but as a *separate reflowable EPUB* rather than a text layer over the PDF —
   ADR 0003. The PDF still has no text layer and that stays deferred; anyone
   wanting searchable text uses `epub`.
5. **Resume seams may duplicate a page.** De-duplication is by exact pixel hash,
   so a page that re-renders one pixel differently is stored twice. Cosmetic;
   perceptual hashing would fix it.
6. **EPUB is macOS-only** (Vision). The OCR boundary is one narrow interface
   (`recogniseColumns`), so a Tesseract backend is addable without touching
   paragraph reconstruction — but nobody has measured Tesseract's Chinese quality
   against Vision's, so don't promise it works.
7. **Bold-but-not-larger subheadings are lost**, staying short paragraphs.
   Measured and left alone deliberately: the isolation signal that would catch
   「延伸阅读」 and 「二十五项议题」 also catches plate captions like
   「正八面体（风）」, which is flush-left and unpunctuated too. If you want these,
   you need a signal OCR doesn't give — weight. Don't re-litigate with geometry.
8. **~2% of an illustration-dense book's text is surviving facsimile gibberish**
   (61 paragraphs on 达·芬奇手记). Not filtered, because the same set holds
   `ISBN: 9787553492254` and the Latin inscriptions on a Ptolemy plate. Keeping
   flagged noise beats silently deleting real content.
9. **Footnote content is unreachable** without opening the popup during the walk,
   which the capture path never does. Markers are stripped where detectable. Doing
   better means a new interaction in `capture.ts`, not a change to OCR.

## Verifying a change

```bash
pnpm verify                        # typecheck + 77 unit + 24 e2e. No login needed
node scripts/dev-export.ts "书名" 8 # live: capture 8 screens end-to-end, headed
weread-export status --open        # eyeball what landed
weread-export epub "书名"           # offline: OCR the cache into an EPUB
```

`pnpm test` covers the pure halves (unit grouping, resume targeting, cache
ordering, HTML and EPUB generation, escaping, and the whole OCR-to-paragraph
chain against fixtures shaped like real Vision output).

`pnpm test:e2e` covers the seam those cannot: it builds the CLI and runs `epub`
and `status` against a generated fixture book under a scratch `HOME`. Added
2026-08-05. It is offline and platform-independent, which takes some arranging —
`exportEpub` reaches for Vision unless every column hash is already in `ocr.json`
*and* no column has a hole in it, so the fixture pre-populates the one and is
laid out to avoid the other. The generator checks both against the real rules in
`text.ts` and refuses to write a fixture that does not hold, rather than letting
the gate quietly turn into a macOS-only test. Read `test/e2e/support/fixture.ts`
before changing it.

Its assertions were each confirmed to fail by mutating the source: breaking
`escapeXml` fails three, inverting the stitch condition in `assembleChapters`
fails the two stitching tests, and dropping an item from the OPF manifest fails
the manifest test.

Anything touching the browser has no automated coverage by design — the live
harness above is the check. **Render and look at the output**; a class-name
collision that blanked every KPI number in the dashboard was invisible to tests
and obvious in a screenshot.

For an EPUB change, unzip it and read it — the failures that mattered were all
visible in the prose and invisible to types: paragraphs split mid-sentence, a
chapter title appearing twice, mystery images that were page margins. Useful
checks: XML well-formedness of every `.xhtml`, every `src="images/…"` resolving,
manifest and on-disk files agreeing, and the `关于这个文件` section reading
honestly. `buildEpub` is deterministic (fixed ZIP timestamps), so identical input
gives identical bytes and a diff means something really changed.

## Conduct

This drives a real WeRead account against a live site.

- Scope is **books that account can already read, for personal offline use**.
  Don't widen it. One publisher's own 数字版权声明 inside a captured book states
  「仅供您个人使用，未经授权，不得进行传播」.
- Capture is deliberately **serial with 1–3 s randomised pauses**. Don't
  parallelise it to go faster; the cost of being flagged lands on the account
  owner, not the tool.
- **Exporting advances real reading progress** (已读时长 and 进度). Say so before
  running long jobs on someone else's account.
- **Never `--force` a large existing cache** to test something. Point a scratch
  `HOME` at a temp dir and copy the session into it — that is how the `--scale`
  comparison was done without touching 358 MB of prior work.

## Suggested skills

- `mattpocock-skills:diagnosing-bugs` — for anything reader-related. Every bug
  here looked like one thing and was another; the instinct to instrument rather
  than guess is what eventually worked.
- `mattpocock-skills:grilling` — before building on top of the capture design.
  The original plan was settled this way and it caught real problems early.
- `mattpocock-skills:domain-modeling` — if you add or rename a concept; keep
  `CONTEXT.md` truthful, and note that ADR 0002 already had to correct it once.
- `dataviz` — required before touching `src/status.ts`. The palette rules,
  status-colour reservations and the "render it and look at it" step all come
  from it.
- `mattpocock-skills:prototype` — for UI questions; that is how the `status`
  layout was chosen.
- `git-commit` — commit messages in this repo explain *why*, at length, and
  several are the only record of a subtle finding. Match that.
