# Context

Ubiquitous language for this project. Glossary only — no implementation detail,
no decisions. Decisions live in `docs/adr/`.

## Terms

**Book** — a 书 in WeRead, identified by the id embedded in its reader URL
(`/web/reader/<bookId>`). A Book is the thing you read; it is not the file we
produce. See [[Export]].

**Export** — one file produced from one Book, either a PDF of the page images or
an EPUB of [[Recognised Text]]. Exporting never modifies the Book; it is a
read-only projection of it. Several Exports of the same Book may exist over time
as the [[Capture]]s are re-typeset or re-read.

**Chapter** — an entry in a Book's 目录. Chapters have a **level**: level 1 is a
top-level 章 (or a 分卷 heading), level 2 is a 节 nested beneath it. A Chapter is
identified by its position in the 目录, because WeRead's TOC entries carry no
stable identifier of their own.

**Volume** — a level-1 Chapter that only groups its 节 and carries no prose of
its own. Distinguishable from an ordinary Chapter only by what it contains, not
by how it is marked.

**Screen** — what the reader displays at one moment, and the unit of capture and
of caching. In WeRead's horizontal layout that is two side-by-side **Columns**,
which together are one logical reading position. A Screen is identified by the
content hash of its Columns, not by which Chapter it belongs to: a 节 may begin
partway down a page, so a Screen can span two Chapters (see ADR 0002).

**Column** — one of the two side-by-side text areas of a Screen. A Column is the
unit that becomes one page of an [[Export]].

**Capture** — the image of one Column. Book prose is painted rather than marked
up (see ADR 0001), so a Capture is a picture, and it is the most faithful record
of a Chapter we can obtain.

**Walk** — one linear pass through a Book, advancing a Screen at a time from the
first page and capturing as it goes. A Walk ends when the reader stops advancing,
which is how the end of a Book presents itself. A Walk is never bounded by a
Chapter, because Chapter boundaries do not fall on page boundaries.

**Running Header** — the title the reader shows above the Columns. It names the
current 节 and lags the display by up to a page, so it is a **label** attached to
a captured [[Screen]] — never an identity and never a boundary. It is what
Chapter marks and PDF bookmarks are derived from.

**Recognised Text** — what OCR reads out of a [[Capture]]: a set of **Lines**,
each with the text, a confidence, and a box in coordinates relative to the
[[Column]]. It is a reading of the Book, never the Book itself — there is no
source text to check it against, so an EPUB [[Export]] carries a [[Quality
Report]] rather than a claim of correctness.

**Line** — one recognised line of text. Recognition happens in overlapping
**Bands**, so the same Line is usually read more than once and the readings
differ; the Line kept is the most confident of them, with a box that is the union
of all of them.

**Block** — what a [[Column]] is interpreted as: a Paragraph, a Heading or a
Plate, in reading order. Paragraphs are rebuilt from the geometry of the Lines
and stitched across Columns, because a Column is WeRead's pagination rather than
the Book's structure.

**Plate** — an illustration, recovered by cropping a region of a [[Capture]] that
holds a picture rather than text. Which regions those are is decided from the
pixels: every Column ends in white space, so the recognised text alone cannot
tell a picture from a margin.

**Quality Report** — the closing section of an EPUB [[Export]], listing what OCR
could not recover and every Line it was unsure of. It names places to check; it
never scores the text, because a score would imply the rest is verified.

**Session** — the stored WeRead credentials for one account. Sessions expire
after days rather than months, so expiry is an ordinary event, not an error.

**Trial Access** (试读) — the state where an account may read only part of a
Book. Chapters beyond the trial are **Unauthorized**: legitimately absent rather
than failed, and recorded as such.

**Placeholder** — a closing page in an [[Export]] stating that the [[Walk]] did
not reach the end of the Book, and why. An Export carrying one is incomplete by
design and says so, so a truncated book is never mistaken for a whole one.

**Cache** — the Captures and metadata retained for a Book between runs, keyed by
Screen hash. It makes a [[Walk]] resumable — a resumed Walk re-pages over known
ground and simply does not store it again — and lets an [[Export]] be re-typeset
without touching WeRead again.
