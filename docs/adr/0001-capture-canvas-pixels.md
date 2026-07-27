# 0001 — Capture canvas pixels rather than extracting text

Date: 2026-07-26
Status: Accepted

## Context

The goal is to export a Book from WeRead as a PDF. Three approaches were
considered:

1. **Drive the web reader and extract text from the DOM**, then typeset our own
   HTML. Selectable, searchable, reflowable output; nothing to reverse-engineer.
2. **Call WeRead's private chapter endpoints and de-obfuscate the payload.**
   Fast, yields real text, but means owning a decoder that breaks whenever the
   server changes, and it is the most hostile to WeRead's terms.
3. **Capture what the reader displays as images.** Faithful and simple, but no
   text layer.

We chose (1) and started building it. It does not work, for a reason that is not
obvious and cost nine rounds of investigation to establish:

**WeRead's web reader paints book prose to `<canvas>`. The text is never in the
DOM.**

The evidence, which is worth recording because every intermediate observation
pointed somewhere misleading:

- `document.body.innerText` on a chapter is ~47 characters — the top bar, the
  running header, and the pager buttons. Nothing else.
- Of ~1170 text nodes in the main frame, 7 have a non-zero `Range` rect. The
  rest sit under `display: none` ancestors. (`getComputedStyle(parent).display`
  still reports `block` in that case, which is what made them look present.)
- `elementFromPoint` at any prose pixel returns `div.content_decoration`, and
  the census finds two `<canvas>` elements at `198,73 393×770` and
  `689,73 393×770` — exactly the two visible text columns.
- A sentence plainly visible on screen (`举个简单的例子`) has **zero** holders
  anywhere in the document. Searching for other visible sentences finds them
  only in the AI 导读 summary panel, which is generated text, not the book.
- `#preRenderContainer`, `.preRenderContent`, `.renderTargetContent` and
  `.contentWrapper` all hold 0 characters on a chapter. Containers that *did*
  hold text in early probing turned out to be cover and flyleaf pages, which
  genuinely are DOM HTML — chapters are not.

So option (1) is not merely fragile, it is impossible. That leaves (2) or (3),
and the trade-off has shifted: the browser path can now only ever yield pixels,
which removes the "clean text without reverse-engineering" advantage that made
it preferable in the first place.

## Decision

Capture the canvas Columns as images and assemble them into the PDF, one Column
per A5 page.

Capture uses element screenshots rather than `canvas.toDataURL()`, because the
canvas draws cross-origin illustrations from `res.weread.qq.com` and is
therefore tainted — `toDataURL` throws. Screenshots also honour the browser
context's `deviceScaleFactor`, so capture resolution is a single knob.

Two consequences must be handled deliberately:

- **Theme.** Prose is painted, so a dark reader produces a dark PDF and no CSS
  of ours can invert it without wrecking the coloured headings. The reader is
  switched to its light theme before capture and switched back afterwards. The
  canvas itself is transparent — only glyphs are painted — so the light
  background composites correctly.
- **Overlays.** An element screenshot includes anything painted over that
  element, so the pager buttons must be hidden during capture. They are hidden
  with `visibility: hidden`, not `display: none`, because removing them from
  layout could reflow the Columns and change where pages break mid-Walk.

Captures are cached per Chapter, so the PDF can be re-typeset — or gain an OCR
text layer later — with no further requests to WeRead.

## Consequences

**Accepted losses.** The PDF has no text layer: not searchable, not copyable,
not reflowable. Files are larger than typeset text (tens of MB for a long book
rather than a few). Page breaks are inherited from WeRead's pagination rather
than chosen by us.

**What we keep.** Complete visual fidelity, including illustrations, tables and
the publisher's typography. No decoder to maintain: if WeRead changes its
payload format, capture is unaffected. Searchability remains reachable later via
OCR over the cache, without re-scraping, which is why images rather than a
finished PDF are what we cache.

**Revisit if** WeRead ships a DOM-rendered reader mode, or if searchability
turns out to matter more than fidelity and the OCR pass proves inadequate. The
private-API path (option 2) stays the only route to genuine text and remains
deliberately unbuilt.
