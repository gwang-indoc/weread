# Work log

Append-only journal of finished work bulks, so anyone (human or agent) can catch up fast.
Newest at the BOTTOM. Append an entry whenever a bulk of work wraps (ideally right before
the commit that ships it). Keep entries SHORT: header line + What + Refs, nothing else.

**Entry grammar** (strict, one header line per entry):
```
## YYYY-MM-DD · Short title · #tag1 #tag2
What: 1-2 lines, outcome first.
Refs: [doc](path) (new|updated), repo PR/commit links.
```

**Tags** (reuse before inventing): add your own as loops emerge, e.g.
#analysis #product #content #infra #skill #research #ops #revenue #growth

**Retrieval recipes** (macOS; entry headers always start `## 20`):
```bash
# index of all entries (one line each)
grep '^## 20' LOG.md
# last 5 entries, full
tail -r LOG.md | awk '{print} /^## 20/{c++; if(c==5) exit}' | tail -r
# all entries about a topic
awk '/^## 20/{p=/#product/} p' LOG.md
# entries from a month
awk '/^## 20/{p=/^## 2026-06/} p' LOG.md
```

---

## 2026-08-05 · book-export loop created + first run · #ops #infra
What: Stood up the knowledge base (in `kb-docs/`, not `docs/`, which is the ADRs) and the
`book-export` loop; its first run read the real cache rather than capturing, and found
HANDOFF's "State of the work" stale — three books now read `complete`, not zero.
Refs: ARCHITECTURE.md (new), LOG.md (new), domains/book-export/README.md (new),
signals/README.md (new), kb-docs/README.md (new), domains/README.md (new), CLAUDE.md (updated).

## 2026-08-08 · HANDOFF "State of the work" rewritten against the cache · #ops
What: The section claimed no book had ever been exported completely; three have (1,643 screens,
953 MB). Rewrote it with measured figures and four further corrections — stale re-run timing,
a guard that isn't on the export path, unprovable resume behaviour, and a coverage number that
isn't one.
Refs: docs/HANDOFF.md (updated), domains/book-export/README.md (updated).
