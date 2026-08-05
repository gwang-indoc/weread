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

Establishing what is actually true. The first run found that `docs/HANDOFF.md`'s "State of the
work" is materially stale: it says **"the biggest gap: no book has ever been exported
completely"**, and in fact three of the four cached books now read `complete`. Before planning
any new capture, the loop needs the record to match the disk — and needs to know how much to
trust the word `complete`.

## Backlog

- [ ] **Correct `HANDOFF.md`'s "State of the work".** It claims no book has ever been exported
      completely, and describes a cache of "two v2 (17 and 298 screens, both `interrupted`) and
      one v1 legacy". Reality on 2026-08-05: three v2 books, all `complete`, 1,643 screens and
      953 MB. HANDOFF says it is a point-in-time snapshot that will drift, so this is expected
      drift, not a defect — but it is the first thing a newcomer reads.
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
      the from-cache `epub` command has been exercised.

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
