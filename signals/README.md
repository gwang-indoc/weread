# signals/ — evidence

One file per **signal**: a piece of feedback, an idea, or an observation worth remembering.
Signals are **deduped and frequency-counted** — when the same thing shows up again, you don't
make a new file, you add a Timeline entry to the existing one and bump `frequency`.

This README is the schema. See `ARCHITECTURE.md` for the model.

## Frontmatter

```yaml
---
kind: signal
category: feedback | idea | friction | observation   # what sort of signal
frequency: 1                # how many times seen; increment on recurrence
sources: []                 # where it came from (links, ticket ids, urls)
domain: []                  # which loop(s) this feeds — a list of domain names
status: open | triaged | actioned | closed
---
```

## Body

A short statement of the signal (what, and why it matters), then an optional append-only
`## Timeline` accumulating each sighting:

```
## Timeline
2026-06-14 | support ticket #123 — user hit the same wall again
```

`frequency` = number of Timeline entries. Link related artifacts with `[[slug]]`.

## Naming

`<short-kebab-slug>.md`, or a stable id like `FB-<n>.md` if you prefer running numbers.

## In this repo

A signal is not the place for a design decision or for a trap in the capture code — those go
to `docs/adr/` and `docs/HANDOFF.md` respectively, which predate this knowledge base and stay
authoritative. Use a signal for what a *run* observed: a book that behaved oddly, a timing, a
selector that looks fragile, a thing worth watching. If a signal hardens into a decision, write
the ADR and close the signal pointing at it.
