# 0002 — Walk the book linearly, by screen, not chapter by chapter

Date: 2026-07-27
Status: Accepted
Supersedes the capture-unit model implied by [0001](0001-capture-canvas-pixels.md)

## Context

ADR 0001 established that book prose is painted to `<canvas>`, so pages must be
captured as images. The first implementation then organised capture around the
目录: navigate to a chapter, page forward until the chapter ends, cache it,
repeat. Chapter boundaries were detected from the running header.

That produced a book where **every chapter contained one or two pages**. Three
successive attempts to fix it each failed for a different reason, and together
they show the model itself was wrong:

1. **Header as boundary, level-1 entries only.** The running header names the
   current 节, not the 章, so it changes *inside* a chapter. Walking 第一章 离弃
   stopped at 牛顿的家族 after two screens, and the 节 were never walked at all
   because level-2 entries were treated as navigation targets rather than
   content. Most of the book was silently missing.

2. **URL key as boundary, every entry walked.** WeRead does give each entry its
   own key, but the key in the address bar lags the display and is sometimes
   absent entirely — right after a TOC navigation it still held the previous
   unit's value for 11+ seconds. Units were recorded under stale keys and then
   skipped as duplicates of one another.

3. **Verify the landing position by header, then walk.** Navigating to 牛顿的家族
   reported 第一章 离弃, and to 穿凿附会的故事 reported 艾萨克·牛顿出世 — always
   the preceding entry, reproducibly, with a retry making no difference. The
   cause is that **a 节 can begin partway down a page**: clicking it lands on the
   page where it starts, and that page is still headed by the 节 that occupied
   its top.

So pages do not partition cleanly per chapter. The mapping from chapter to pages
is inherently many-to-many at the boundaries, and every signal available for
detecting a boundary (header, URL key, TOC selection) is either lagged or
page-granular while the boundary itself is sub-page.

## Decision

Capture a book as **one linear pass over screens**. Open it at the first 目录
entry and click 下一页 to the end, storing every screen as it appears. Do not
navigate per chapter and do not attempt to partition pages by chapter.

- **A Screen is the unit of capture and of caching**, identified by the content
  hash of its columns. Hashes make the cache idempotent, so a resumed run may
  re-page over ground it already covered without storing it twice.
- **Chapter titles become labels, not identities.** Each screen records the
  running header it was captured under; the renderer starts a new PDF bookmark
  wherever that label changes. A bookmark may therefore be off by up to one page
  at a boundary — the same imprecision the reader itself displays.
- **Front matter is skipped, not failed.** 扉页 and 版权信息 are ordinary DOM
  rather than canvas, so they yield no columns. A run of more than six such
  pages means the reader is genuinely stuck; fewer is just front matter.
- **Resume aims at the entry matching the last header seen**, then relies on
  hash de-duplication for the overlap.

## Consequences

**What this buys.** Completeness is structural rather than something to verify:
a single forward pass cannot skip a page or capture one twice within a run. The
three failure modes above are all boundary-detection bugs, and there is no
longer a boundary to detect.

**Accepted costs.**

- The cache layout changed (per-chapter records → an ordered screen list), so
  `CACHE_VERSION` is 2 and v1 caches are discarded rather than migrated.
- Resume is coarser than per-chapter resume: it restarts from the nearest 目录
  entry and re-pages a little. Because de-duplication is by exact pixel hash, a
  page that re-renders even slightly differently can be stored twice, so a
  resumed export may repeat a page at the seam.
- `--chapters` is gone; a partial export is expressed as `--max-screens`.
- Exporting a long book means one long session. 牛顿传 has 196 目录 entries and
  roughly 2–3 screens each, so ~500 screens, ~1000 page images.

**Revisit if** WeRead exposes a per-chapter content boundary that is not
page-granular, or if resume seams become annoying enough to warrant perceptual
rather than exact image hashing.
