---
kind: domain
domain: book-export
status: active
goal: Take every readable book on the shelf to a verified-complete export, and learn what breaks at full scale
cadence: manual
---

# book-export — walking whole books, not samples

Takes one book at a time from the shelf to a finished capture, then to PDF/EPUB, and records
what only shows up at full scale. Consumes the 书架 and `~/.cache/weread-export/`; produces
finished exports, `signal`s for anything a run turned up, and the `status` report as its
running scoreboard.

**Cadence is `manual` and must stay that way.** A run drives a real WeRead account, is serial
by design at 1–3 s per screen, and takes hours per book — 于是一片光明 is 860 screens. It also
advances real reading progress (已读时长, 进度). No schedule should start one of these; a human
does, knowing the cost. See the constraint note in `domains/README.md`.

## Current focus

How much the word `complete` is worth. The record now matches the disk, so the open question is
whether ADR 0004's condition is a strong enough definition — it is satisfied by all three
finished books, and it provably cannot see a stall in the last ~200 screens of 《于是一片光明》.

## Backlog

- [x] **Correct `HANDOFF.md`'s "State of the work".** Done 2026-08-05. It claimed no book had
      ever been exported completely and described a cache of two interrupted books plus a legacy
      one; the section now carries the three finished books, current EPUB figures, and four
      corrections the rewrite turned up (see this loop's Timeline).
- [ ] **Decide how much `complete` is worth.** All three finished books satisfy ADR 0004's
      condition — last running header equals the last 目录 entry. ADR 0004 also records a
      residual limit it cannot fix: the final three entries of 于是一片光明 cover roughly its
      last 200 screens, so a stall inside the references would still read as complete. Work out
      whether there is an independent check (page-count sanity, OCR'd back matter) worth having.
- [ ] **Understand the unit shortfalls.** 牛顿传 reports 195/196 units, 达·芬奇手记 77/86,
      while 于是一片光明 reports 26/17 — over 100%, because `unitsOf` starts a new unit when a
      header recurs after a different one. Establish whether a shortfall means missed content or
      is just headers that never appear, so the `status` coverage number can be trusted or dropped.
- [ ] **`我的第一本算法书` is a v1 legacy cache** — `version` undefined, 59 目录 entries, 0
      screens recorded and 2 stray PNGs. `readMeta` refuses it by design; re-capturing needs
      `--force` and hours. Decide whether this book is wanted before spending them.
- [ ] **The 未授权 (trial-expired) path has still never triggered** against a real book. Nothing
      in the loop has exercised it; it is the one outcome branch with no live evidence at all.
- [ ] **The auto-resume "resting" half is still unproven.** ADR 0004 fixed the arbitration, but
      no genuinely stalled reader has been observed recovering after a reload. That reload is an
      assumption, and it is the first thing to question if resuming turns out not to help.
- [ ] **`--format epub` and `--format both` on the capture path have never been run live.** Only
      the from-cache `epub` command has been exercised, and the cache holds no evidence either way.
- [ ] **`walkChapter` is dead code.** Exported from `src/capture.ts`, called from nowhere — the
      per-chapter walker ADR 0002 rejected, and the home of the "400-screens-per-walk guard"
      HANDOFF used to list as untested. Decide whether it stays as an artifact of the rejected
      design or goes; if it stays, it wants a comment saying so.
- [ ] **Cache the illustration crops.** `cropIllustrations` re-runs Vision over every hole on
      every export, which is why a re-run is 15–23 s rather than the 1–2 s recognition caching
      alone would give. `ocr.json` already solves this for recognition; crops land in
      `<bookDir>/crops/` and are simply not consulted.
- [ ] **Record wall-clock per capture.** `meta.json` stores no timing and no attempt count, so
      finished books cannot answer how long they took, or whether they rested on the way. That
      missing field is also what makes the auto-resume "resting" half unprovable from the cache.

## Evidence & analysis

None yet. Note that design decisions belong in `docs/adr/` and capture traps in
`docs/HANDOFF.md`; `kb-docs/` here is for a run's worked-through analysis.

## Metrics

`metrics/` — not written yet, and deliberately not hand-maintained. `collectStatus()` in
`src/status.ts` already computes per-book screens, page images and bytes from the cache, so the
collector for this loop is a thin wrapper over it rather than anything new. Wall-clock per book
is the number nobody has, and the one worth capturing first.

## Timeline

2026-08-05 | test run (read-only) — read the real cache instead of capturing: 4 books, 1,643
screens, 3,288 page images, 953 MB. Three read `complete` (牛顿传 474 screens/198 MB,
于是一片光明 860/388 MB, 达·芬奇手记 309/368 MB), each with its last running header equal to its
last 目录 entry; 我的第一本算法书 is the v1 legacy. Finding: HANDOFF's "State of the work" is
stale — it still says no book has ever been exported completely. No capture was started, so no
reading progress was advanced.

2026-08-05 | run 2 (offline) — rewrote HANDOFF's "State of the work" against measured reality.
Re-exported all three finished books to EPUB from cache (牛顿传 253,671 chars / 27 plates,
达·芬奇手记 134,362 / 218, 于是一片光明 524,707 / 64) and verified each archive with
`test/e2e/support/archive.ts` — mimetype, CRCs, XML, manifest, image refs all clean, so the
gate's assertions hold on real books too. Four further corrections found: re-runs are 15–23 s,
not 1–2 s, because crops are re-cut by Vision every time; the "400-screens-per-walk guard" the
section listed belongs to `walkChapter`, which nothing calls; `meta.json` records no timing or
attempt count, so the resting half is unprovable from the cache; and `status` unit coverage is
not a completeness measure (26/17 on one book). Still no capture run, no progress advanced.
