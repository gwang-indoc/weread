/**
 * The offline end-to-end gate: `weread-export epub` over a cache, start to
 * finish, through the built CLI.
 *
 * The unit tests cover the pure halves in isolation. This covers the seam they
 * cannot: that the built artifact, given a cache on disk, writes a file a reader
 * can open — and that the things this project promises about that file are
 * actually in it. Every assertion below stands for a failure that has shipped
 * from this code path or that HANDOFF.md names as the thing to check by hand:
 * paragraphs split mid-sentence, a chapter title appearing twice, mystery images
 * that were page margins, and a QA section that has to read honestly.
 *
 * No login, no browser, no Vision, no network. See `support/fixture.ts` for how
 * the last of those is arranged, and `support/run.ts` for why this can never
 * touch the real cache.
 */
import test, { before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Scratch } from './support/run.ts'
import { writeFixture, BOOK_TITLE, TRICKY_TITLE } from './support/fixture.ts'
import { readZip, findXmlProblems, type ZipMember } from './support/archive.ts'

describe('epub, from a cache, offline', () => {
  let scratch: Scratch
  let members: ZipMember[]
  let bytes: Buffer
  let stdout: string
  let exitCode: number

  const text = (suffix: string): string => {
    const member = members.find((m) => m.path.endsWith(suffix))
    assert.ok(member, `the archive has no ${suffix}`)
    return member.data.toString('utf8')
  }

  before(async () => {
    scratch = await Scratch.create()
    await writeFixture(scratch.cacheRoot)

    const result = await scratch.run(['epub', BOOK_TITLE, '-o', 'out'])
    exitCode = result.code
    stdout = result.output
    assert.equal(result.code, 0, `the CLI failed:\n${result.output}`)

    bytes = await readFile(join(scratch.outDir, `${BOOK_TITLE}.epub`))
    members = readZip(bytes)
  })

  after(async () => {
    await scratch?.dispose()
  })

  /* -------------------------------------------------------------- the archive */

  test('does not need Vision, so it runs anywhere the cache does', () => {
    // The fixture has no holes, so `cropIllustrations` returns before starting
    // the Swift helper. If this ever reports a non-zero count, the gate has
    // quietly become a macOS-only test — see support/fixture.ts.
    assert.match(stdout, /其中 0 处是插图/)
  })

  test('mimetype comes first and uncompressed, as the format requires', () => {
    const first = members[0]
    assert.equal(first?.path, 'mimetype')
    assert.equal(first?.offset, 0, 'a reader is entitled to find it at a fixed offset')
    assert.equal(first?.stored, true)
    assert.equal(first?.data.toString('utf8'), 'application/epub+zip')
  })

  test('every member survives its own checksum', () => {
    const corrupt = members.filter((m) => !m.crcOk).map((m) => m.path)
    assert.deepEqual(corrupt, [])
  })

  test('every XML document is structurally sound', () => {
    // Not a conforming validation — see findXmlProblems. It catches the class of
    // failure that actually ships here: something unescaped, or a tag left open.
    const broken = members
      .filter((m) => /\.(xhtml|opf|xml)$/.test(m.path))
      .flatMap((m) => findXmlProblems(m.data.toString('utf8')).map((p) => `${m.path} — ${p}`))
    assert.deepEqual(broken, [])
  })

  /* ------------------------------------------------------ manifest vs reality */

  test('the manifest and the files on disk agree, in both directions', () => {
    const opf = text('content.opf')
    const manifest = /<manifest>([\s\S]*?)<\/manifest>/.exec(opf)?.[1] ?? ''
    const declared = [...manifest.matchAll(/href="([^"]+)"/g)].map((m) => `OEBPS/${m[1]}`).sort()
    const present = members
      .map((m) => m.path)
      .filter((p) => p.startsWith('OEBPS/') && p !== 'OEBPS/content.opf')
      .sort()

    assert.deepEqual(
      declared,
      present,
      'a file in the manifest that is not in the archive is a book that will not open; ' +
        'a file in the archive that is not in the manifest is one no reader will show',
    )
  })

  test('every internal link resolves to something in the archive', () => {
    const paths = new Set(members.map((m) => m.path))
    const dangling: string[] = []

    for (const member of members.filter((m) => /\.(xhtml|opf)$/.test(m.path))) {
      const body = member.data.toString('utf8')
      for (const [, ref] of body.matchAll(/(?:href|src)="([^"#]+)(?:#[^"]*)?"/g)) {
        if (/^(?:https?:|mailto:)/.test(ref!)) continue
        if (!paths.has(`OEBPS/${ref}`)) dangling.push(`${member.path} → ${ref}`)
      }
    }

    assert.deepEqual(dangling, [], 'HANDOFF calls this out: every src="images/…" has to resolve')
  })

  test('the spine orders every chapter between the title page and the QA section', () => {
    const opf = text('content.opf')
    const spine = [...opf.matchAll(/<itemref idref="([^"]+)"/g)].map((m) => m[1])
    assert.deepEqual(spine, ['title', 'nav', 'ch1', 'ch2', 'ch3', 'qa'])
  })

  /* ------------------------------------------------------------------- prose */

  test('recovers the chapters the running headers named', () => {
    const titles = [...text('nav.xhtml').matchAll(/<a href="ch\d+\.xhtml">([^<]+)<\/a>/g)].map((m) => m[1])
    assert.deepEqual(titles, ['第一章 出发', '第二章 「山」 &amp; &lt;海&gt; 之间', '第三章 归程'])
  })

  test('stitches a paragraph back together across a column boundary', () => {
    // The fixture's first paragraph runs off the bottom of the left column and
    // continues at the top of the right one. Split, this reads as two paragraphs
    // and the sentence breaks mid-clause — the failure HANDOFF describes as
    // visible in the prose and invisible to types.
    const chapter = text('ch0001.xhtml')
    assert.match(chapter, /只有一段接着一段的空话。这一段是上一栏的下半截/)
  })

  test('stitches a paragraph across a screen boundary too', () => {
    // Columns and screens are the same thing to the cache — an ordered list of
    // page images — and the stitch must not care which boundary it is crossing.
    assert.match(text('ch0003.xhtml'), /它要接到下一栏里。而这一段是它的下半截/)
  })

  test('does not stitch across a chapter boundary', () => {
    // The running header lags the display by up to a page, so a boundary can
    // fall mid-paragraph. Closing the paragraph keeps the error to the page-level
    // imprecision the reader itself has; joining would pull one chapter's opening
    // into the end of the previous one.
    assert.doesNotMatch(text('ch0002.xhtml'), /这一栏属于第二章[^<]*第三章/)
    assert.match(text('ch0003.xhtml'), /^[\s\S]*<p>第三章从这里开始。/)
  })

  test('drops the chapter title WeRead paints into the page', () => {
    // It arrives twice: once as the running header this <h1> is built from, once
    // painted into the canvas as prose.
    const chapter = text('ch0001.xhtml')
    assert.equal(chapter.match(/第一章 出发/g)?.length, 2, 'once in <title>, once in <h1> — never as a <p>')
    assert.doesNotMatch(chapter, /<p>第一章 出发/)
  })

  test('keeps a real subheading, which is not the same as a repeated title', () => {
    assert.match(text('ch0001.xhtml'), /<h2>一 关于这次远行<\/h2>/)
  })

  test('escapes the characters XML cannot carry, everywhere they appear', () => {
    // Three separate paths carry this chapter title: the nav, the chapter's own
    // <title> and <h1>, and the QA list. A miss in any one is a file no reader
    // can open. (content.opf carries only the *book* title, so it is not in this
    // list — it is covered by the XML check over every document.)
    const escaped = TRICKY_TITLE.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    for (const path of ['nav.xhtml', 'ch0002.xhtml']) {
      const body = text(path)
      assert.ok(body.includes(escaped), `${path} does not carry the title escaped`)
      assert.doesNotMatch(body, /<海>/, `${path} carries the title raw`)
    }
    assert.match(text('ch0002.xhtml'), /出现 &lt; 和 &gt; 和 &amp; 这样的字符/, 'and inside the prose itself')
  })

  /* ---------------------------------------------------- saying what is uneven */

  test('states that the book was not captured to the end', () => {
    // The rule across this project: nothing uneven about an export is left for
    // the reader to discover. The fixture's walk stopped one 目录 entry short.
    const qa = text('qa.xhtml')
    assert.match(qa, /这本书没有抓完/)
    assert.match(qa, /抓取中断，没有翻到最后一页/)
    assert.match(qa, /夹具刻意停在第 4 屏/, 'the note the cache recorded, not a generic line')
    assert.match(stdout, /未翻到最后一页/, 'and the CLI says so too')
  })

  test('lists the doubtful lines without implying the rest are right', () => {
    const qa = text('qa.xhtml')
    assert.match(qa, /建议核对的地方（1 处）/)
    // The doubtful *line*, not the paragraph containing it — a reader checking
    // against the app needs the fragment Vision was unsure of, not its context.
    assert.match(qa, /该被悄悄删掉。正确的做法是把它们照原样留在书里，/)
    assert.match(qa, /<span class="where">第一章 出发<\/span>/, 'and where to find it')
    assert.match(qa, /会有错字，且无法自检/)
    // The one thing this section must never become.
    assert.doesNotMatch(qa, /准确率|正确率|置信度\s*[:：]\s*\d/, 'an accuracy figure would be a claim we cannot support')
    assert.doesNotMatch(stdout, /准确率|正确率/)
  })

  test('an incomplete export still exits 0 on this path', () => {
    // Recorded rather than endorsed. CLAUDE.md says incomplete exports exit
    // non-zero, and the capture path does; `epub` from a cache only warns. This
    // test exists so that changing it is a deliberate act with a visible diff,
    // not so that the current behaviour is blessed.
    assert.equal(exitCode, 0)
  })

  /* ------------------------------------------------------------ determinism */

  test('the same cache produces the same bytes, so a diff means something', async () => {
    const again = await scratch.run(['epub', BOOK_TITLE, '-o', 'out2'])
    assert.equal(again.code, 0, again.output)
    const second = await readFile(join(scratch.home, 'out2', `${BOOK_TITLE}.epub`))
    assert.deepEqual(second, bytes, 'ZIP timestamps are fixed precisely so this holds')
  })
})
