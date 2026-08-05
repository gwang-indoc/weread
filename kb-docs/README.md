# kb-docs/ — durable knowledge

One file per **doc**: something you learned, analyzed, or decided that you want to be findable
later. If a signal is raw evidence, a doc is the worked-through version: an analysis, a writeup,
a decision and its rationale, a how-it-works note.

This README is the schema. See `ARCHITECTURE.md` for the model.

> **Why `kb-docs/` and not `docs/`.** `docs/` in this repo already holds the ADRs and
> `HANDOFF.md`, and `CLAUDE.md` points at them by name. The knowledge base takes a separate
> folder rather than overloading that one. See the note at the top of `ARCHITECTURE.md`.

## Frontmatter

```yaml
---
kind: doc
domain: []                  # which loop(s) this belongs to
status: draft | adopted | superseded   # optional; use when a doc can be acted on or replaced
links: []                   # related artifacts, [[slug]] or paths
---
```

Optionally add a `type:` field (e.g. `analysis`, `decision`, `learning`) if you find yourself
wanting to filter docs by shape — but don't force it. Most docs are just knowledge.

## Body

Main text = *what's true now*. Append an optional `## Timeline` for *what happened*
(revisions, supersessions, when a decision was revisited). Link liberally with `[[slug]]`.

## Naming

`<short-kebab-slug>.md` or `<TOPIC>-<YYYY-MM>.md` — whatever reads well and sorts sensibly.

## What does NOT go here

- **A decision about how content is obtained or interpreted** → `docs/adr/`. That convention
  is older, is referenced from `CLAUDE.md`, and carries the rejected alternatives with the
  evidence. Don't fork it.
- **A trap that will bite the next person editing the code** → `docs/HANDOFF.md`'s Traps
  section, which exists so things don't get "fixed" back.
- **Domain vocabulary** → `CONTEXT.md`, which `src/types.ts` defers to explicitly.

A `kb-docs/` doc is for what a loop worked out — an analysis of a run, a measurement, a
comparison — and it may link to any of the above.
