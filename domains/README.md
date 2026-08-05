# domains/ — loops

Each subfolder is one **loop**: a thread of work with a charter, a cadence, and (optionally)
metrics. A domain folder holds only its **`README.md`** (the loop's live state) and optional
**machinery** (`metrics/*.jsonl`, collectors). It **links** to artifacts in `signals/` and
`kb-docs/`; it never contains them. The loop's to-dos live inline in the README's `## Backlog`
(promote to a `task` kind only once that outgrows the README — see `ARCHITECTURE.md`).

Don't create domains by hand — run the **`new-loop`** skill. It scaffolds the README from the
template below, test-runs the loop, and records the run.

This README is the schema. See `ARCHITECTURE.md` for the model.

## Domain README template

```markdown
---
kind: domain
domain: <loop-name>
status: active | paused | archived
goal: <one line — the outcome this loop drives>
cadence: <manual | daily | weekly | cron expr — how often it runs>
---

# <loop-name> — <short tagline>

<2-4 lines: what this loop does, what it consumes (which signals/data), what it produces.>

## Current focus
<The single most important thing this loop is working on right now. Keep it fresh.>

## Backlog
- [ ] <work item — inline; link [[signal-slug]] / [[doc-slug]] if one exists>
- [ ] <next thing>

## Evidence & analysis
[[doc-slug]] · [[doc-slug]]

## Metrics
`metrics/` — <which numbers, and the collector that writes them (TBD is fine to start)>.

## Timeline
YYYY-MM-DD | <run/source> — <what happened this run>
```

A domain's `## Timeline` is its run-log: one terse dated line per run. Rich per-run detail
lives in the artifacts it links, not here.

## A standing constraint in this repo

Any loop here that touches WeRead inherits `CLAUDE.md`'s conduct rules, and they are not
negotiable by a cadence field:

- Capture is **serial with 1–3 s randomised pauses**. A loop must not parallelise it to hit a
  schedule; the cost of the account being flagged lands on its owner.
- **Exporting advances real reading progress** (已读时长, 进度), so a loop that captures is
  acting on a person's account. Say what it will cost before a long run.
- **Never `--force` a large existing cache.** At the time of writing the cache holds ~950 MB
  across three finished books — hours of walking that cannot be re-fetched any faster.

A loop that only reads the cache or the repo has none of these constraints and can be
scheduled freely.
