# Context

Ubiquitous language for this project. Glossary only — no implementation detail,
no decisions. Decisions live in `docs/adr/`.

## Terms

**Book** — a 书 in WeRead, identified by the id embedded in its reader URL
(`/web/reader/<bookId>`). A Book is the thing you read; it is not the file we
produce. See [[Export]].

**Export** — one PDF produced from one Book. Exporting never modifies the Book;
it is a read-only projection of it. Several Exports of the same Book may exist
over time as the [[Capture]]s are re-typeset.

**Chapter** — an entry in a Book's 目录. Chapters have a **level**: level 1 is a
top-level 章 (or a 分卷 heading), level 2 is a 节 nested beneath it. A Chapter is
identified by its position in the 目录, because WeRead's TOC entries carry no
stable identifier of their own.

**Volume** — a level-1 Chapter that only groups its 节 and carries no prose of
its own. Distinguishable from an ordinary Chapter only by what it contains, not
by how it is marked.

**Capture Unit** — the Chapter a [[Walk]] starts from. Level-1 Chapters are
Capture Units; level-2 Chapters are navigation targets only, because a Walk that
begins at a 章 continues through all of its 节.

**Screen** — what the reader displays at one moment. In WeRead's horizontal
layout that is two side-by-side **Columns**, which together are one logical
reading position.

**Column** — one of the two side-by-side text areas of a Screen. A Column is the
unit that becomes one page of an [[Export]].

**Capture** — the image of one Column. Book prose is painted rather than marked
up (see ADR 0001), so a Capture is a picture, and it is the most faithful record
of a Chapter we can obtain.

**Walk** — advancing through a Capture Unit one Screen at a time, capturing as
we go, until the Chapter ends. A Walk ends when the [[Running Header]] changes or
when the reader stops advancing.

**Running Header** — the chapter title the reader shows above the Columns. It is
the only part of a Chapter that exists as real text, which is what makes Chapter
boundaries detectable during a [[Walk]].

**Session** — the stored WeRead credentials for one account. Sessions expire
after days rather than months, so expiry is an ordinary event, not an error.

**Trial Access** (试读) — the state where an account may read only part of a
Book. Chapters beyond the trial are **Unauthorized**: legitimately absent rather
than failed, and recorded as such.

**Placeholder** — a page in an [[Export]] standing in for content that could not
be captured, naming the Chapter and the reason. An Export with Placeholders is
incomplete by design and says so, so a gap is never silent.

**Cache** — the Captures and metadata retained for a Book between runs. It makes
a Walk resumable and lets an Export be re-typeset without touching WeRead again.
