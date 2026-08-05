# CLAUDE.md

Guidance for Claude Code working in this repo. This file points; it does not
duplicate. Read the thing it points at.

## Read before changing anything

The design here is written down, and several parts of it are counter-intuitive
enough that re-deriving them from the code goes wrong.

| Read | Before |
| --- | --- |
| [`CONTEXT.md`](CONTEXT.md) | naming anything. It is the **canonical** vocabulary — `src/types.ts` defers to it explicitly |
| [`docs/HANDOFF.md`](docs/HANDOFF.md) | your first change. Its **Traps** section is a list of things not to "fix" back, and its **Open decisions** section records questions already settled — including three answered *no* with the measurements |
| [`docs/adr/`](docs/adr/) | proposing any change to how content is obtained or interpreted |

The short version of the ADRs, so you know whether you need them:

- **0001** — WeRead paints prose to `<canvas>`; the DOM has no book text. This is
  why the PDF is images. Do not go looking for a text extraction path.
- **0002** — chapter boundaries are sub-page and every boundary signal lags, so
  capture is one linear pass over screens. Three per-chapter designs failed first.
- **0003** — EPUB comes from OCR over the cache, in overlapping bands, because
  Vision silently returns *nothing* for large clear text next to dense small text.
- **0004** — whether a walk finished is decided from the whole trail of running
  headers, not the last one, because 目录 titles repeat and a page turn dies in
  three different ways. Read it before touching `looksTruncated`/`reachedIndex`.

## Naming

Adding or renaming a domain concept means updating `CONTEXT.md` in the same
change. The test: if a name appears in a type, a cache field, a function name or
user-facing output, someone reading the code has to know precisely what it means,
so it belongs in the glossary. Thresholds, rationale and usage do **not** —
those are implementation, ADRs and README respectively.

## How code is written here

Match the surrounding style rather than a general default:

- **Comments explain *why*, at length, especially where the code looks odd.** Most
  of the non-obvious lines exist because something else failed; that reason is the
  comment. Do not strip these down.
- **Pure logic is extracted so it can be tested offline.** Anything that shapes an
  export must be checkable without a login: `text.ts`, `epub.ts`, `zip.ts`,
  `render.ts` and `status.ts` are pure; `ocr.ts`, `capture.ts` and `session.ts` are
  where the impurity is allowed to live. Keep that line.
- **Design decisions get an ADR**, including the evidence and the rejected
  alternatives. A decision that was measured and rejected is worth as much as one
  that was adopted — it stops the next person retrying it.
- **Nothing uneven about an export is left implicit.** A truncated capture, a
  mixed `--scale`, OCR the tool is unsure of: each is stated in the output, and
  incomplete exports exit non-zero. Never let a partial result pass for a whole
  one, and never present an OCR confidence figure as an accuracy score.

## Verifying

```bash
pnpm test          # 68 offline tests, no login, no browser
pnpm typecheck
pnpm build
```

Browser- and Vision-dependent halves have no automated coverage by design. For
those, **run it and look at the output** — the failures that mattered in this repo
were all invisible to types and obvious on inspection:

```bash
weread-export status --open           # what the cache actually holds
weread-export epub "书名"              # offline; then unzip it and read the prose
node scripts/dev-export.ts "书名" 8    # live capture, 8 screens, headed
```

When writing tests for `text.ts`, note that every rule there calibrates against
the column's own median line height and widest line. **Give fixtures enough
lines** (use the `body()` helper) or the feature under test defines its own
baseline — four tests failed this way before the code was ever wrong.

## Conduct — this drives a real account against a live site

- Scope is **books the account can already read, for personal offline use.** Do
  not widen it.
- Capture is **serial with 1–3 s randomised pauses on purpose.** Do not
  parallelise it; the cost of the account being flagged lands on its owner.
- **Exporting advances real reading progress** (已读时长, 进度). Say so before
  suggesting a long run.
- **Never `--force` a large existing cache to test something.** Point a scratch
  `HOME` at a temp dir and copy the session in.
- OCR results and captures live in `~/.cache/weread-export/`. Deleting a book's
  directory throws away hours of capture; `ocr.json` alone is minutes.

## Commits

Messages explain **why**, at length in the body — several are the only record of a
subtle finding. Subject lines are imperative and unprefixed, e.g. `Capture books
linearly by screen instead of chapter by chapter`. Commit only when asked.
