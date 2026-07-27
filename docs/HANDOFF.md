# Handoff — weread-export

For someone picking this up cold. Written **2026-07-27** against `main` @
`3b0da97` (24 tests passing, typecheck clean, nothing uncommitted).

> This is a point-in-time snapshot and will drift. `git log` and the files it
> points at are the current truth; the parts worth keeping are the traps, the
> open decisions, and the conduct notes — those age slowly. If you finish an open
> decision below, strike it here.

## What it is

A CLI that exports books the logged-in WeRead (微信读书) account can already read
into A5 PDFs, for personal offline use. Node 25 + TypeScript, driven by
`playwright-core`.

Don't re-derive the design from the code — it is written down:

| Read this | For |
|---|---|
| [`README.md`](../README.md) | install, usage, all commands and flags, known trade-offs |
| [`CONTEXT.md`](../CONTEXT.md) | glossary (Book, Export, Screen, Column, Walk, Running Header, …) |
| [`docs/adr/0001-capture-canvas-pixels.md`](adr/0001-capture-canvas-pixels.md) | **why the PDF is images, not text** |
| [`docs/adr/0002-walk-the-book-linearly.md`](adr/0002-walk-the-book-linearly.md) | **why capture is one linear pass, not per chapter** |

Both ADRs record the evidence and the rejected alternatives. Read them before
proposing any change to how content is obtained — each documents a design that
was tried and failed for a non-obvious reason.

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

## State of the work

Verified working end to end: login and session reuse, shelf listing, nested 目录,
linear capture with hash-deduped resume, A5 PDF with bookmarks and page numbers,
and the `status` report.

**The biggest gap: no book has ever been exported completely.** The longest run
is 298 screens / 358 MB of an 86-entry book, stopped by `--max-screens`. Untested
at full scale: total wall-clock, cache size, the 400-screens-per-walk guard, and
the 未授权 (trial-expired) code path, which has never once triggered against a
real book.

The local cache currently holds three books: two v2 (17 and 298 screens, both
`interrupted`) and one **v1 legacy** that `readMeta` deliberately refuses to
read — it needs `--force` to re-capture. That is expected, not a bug.

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
4. **OCR text layer** deliberately deferred. Images rather than a finished PDF
   are cached precisely so OCR can be added later without re-scraping.
5. **Resume seams may duplicate a page.** De-duplication is by exact pixel hash,
   so a page that re-renders one pixel differently is stored twice. Cosmetic;
   perceptual hashing would fix it.

## Verifying a change

```bash
pnpm test                          # 24 offline tests, no login needed
pnpm typecheck
node scripts/dev-export.ts "书名" 8 # live: capture 8 screens end-to-end, headed
weread-export status --open        # eyeball what landed
```

Tests cover the pure halves only (unit grouping, resume targeting, cache
ordering, HTML generation, escaping). Anything touching the browser has no
automated coverage by design — the live harness above is the check. **Render and
look at the output**; a class-name collision that blanked every KPI number in the
dashboard was invisible to tests and obvious in a screenshot.

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
