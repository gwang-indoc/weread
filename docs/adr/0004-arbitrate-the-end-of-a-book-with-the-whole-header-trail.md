# 0004 — Arbitrate the end of a book with the whole header trail

Date: 2026-08-05
Status: Accepted
Refines the end-of-walk arbitration introduced alongside
[0002](0002-walk-the-book-linearly.md)

## Context

A walk ends when 下一页 stops advancing, and that observation is ambiguous: it is
both how a book ends and how a stalled reader presents (ADR 0002). The 目录 was
adopted as the tie-breaker — a dead page turn while the last header seen is still
far from the final entry is a stall, otherwise it is the end. Two failures of that
scheme showed up on one real 860-screen export of 《于是一片光明：1543-1957 人类科学
探索四百年》, and neither was visible to the type system or to any offline test.

**1. Only one of the three ways a page turn dies was recognised.** `walkBook`
reports `end of book (screen repeated)` when the click lands and the same pixels
come back, but it also reports `下一页 not clickable` when the control refuses the
click and `no 下一页 control` when it is absent from the DOM. All three are how a
last page presents; only the first was checked. That export ended on 致谢 — the
final 目录 entry, `#16` of 17 — with `下一页 not clickable`, and was recorded as
`interrupted`. The 目录 tie-breaker was computed, said "not truncated", and was
discarded unread, because the stop reason had not matched the one recognised
string. Cost: two five-minute rests and a third attempt at a book that had
finished, a non-zero exit, and a false 未翻到最后一页 notice written into the
EPUB's 关于这个文件 section.

**2. A 目录 title is not a unique key.** That book lists each of its five chapter
titles twice — once for the prose, once again under 参考文献 — so `第五章 新世纪` is
both `#8` and `#15` of 17. The lookup was `findIndex`, which returns the first
occurrence, so a walk that had reached the references resolved to `#8`: read as
less than half way through a book it had almost finished. Replayed against the
real cache, a stop one screen earlier than the actual end resolves to `#8` and
reports truncated, which at the default `--max-attempts 20` is about 100 minutes
of resting at a finished book.

## Decision

**Group the three dead-page-turn reasons at the point they are produced.**
`pageTurnExhausted` lives in `capture.ts`, beside the strings it matches, because
matching them from elsewhere is how two of the three came to be treated as
failures for as long as they were. `no canvas columns rendered` is deliberately
excluded: that is the reader failing to paint, which says nothing about whether
pages remain.

**Resolve 目录 position from the whole trail of headers, not the last one.** A
walk is linear, so each header can only be at or after where the previous one put
it, and a repeated title later in the book can only be the later occurrence.
`reachedIndex` walks the trail forward through the 目录.

**Ignore a header naming an entry just behind the current position.** The header
lags the display by up to a page (ADR 0002), so a repeat while the walk sits still
is the lag, not progress. Scanning forward unconditionally is wrong in exactly the
case the trail exists to fix: 第一章, 第二章, 第一章, 第二章 across four screens
finds no 第一章 ahead, takes the *duplicate*, and lands the walk in a references
section it never reached. The window is two entries and must stay small — widen it
and a genuine arrival at a repeated title reads as a lag instead, which is the
original bug reached from the other side.

**Require the walk to still be at the end, not merely to have once touched it.**
`reachedIndex` only moves forward, so one stray header latches it for the rest of
the book, and strays are real: that book shows a 致谢 header at screen 645 as well
as at 859, its true position, with 200 screens of references in between — a 目录
is not always in physical order. So the last header must also resolve at or after
the reached entry, allowing for the lag. Without this, a reader stalling anywhere
after screen 645 would have reported a complete book.

A last header matching no 目录 entry at all still reads as the end. Headers do not
always correspond to entries (ADR 0002); guessing "truncated" there retries
forever at a genuine end of book, five minutes at a time.

## Consequences

That export now records `complete`, verified by replaying the decision against
the real 860-screen cache rather than by re-walking it. Cuts of the same real
trail were replayed at four points: the true end and the back-matter chapter both
read complete, a mid-book cut at screen 399 reads truncated.

**The 目录 is a coarse ruler, and that is now the binding constraint.** On this
book the final three entries — the tolerance window — cover roughly the last 200
of 860 screens, all of them headed by titles inside that window. A stall anywhere
in the references therefore still reads as complete, and no better estimate of
position is available from this signal: it is not the latch that limits the
answer, it is the resolution of the 目录 itself. What guards against it is that
`complete` also requires the page turn to be genuinely dead; a reader that stalls
usually does so with the control still live, and that path is unchanged.

**Rejected: resolving the last header to its nearest occurrence.** Nearest-match
picks `#8` over `#15` when the walk is at `#11`, because 3 entries behind beats 4
ahead. Direction carries information that distance does not, and the trail already
supplies it.

**Rejected: treating a non-monotonic header sequence as evidence of a rewind.**
The 致谢-at-645 observation means header order does not always follow 目录 order,
so a sequence that appears to go backwards is not reliably a rewind. Monotonic
plus the still-there check is the conservative reading; making the position
follow the headers down would let a lagging header shorten the book.
