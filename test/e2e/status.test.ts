/**
 * The offline end-to-end gate for `weread-export status`.
 *
 * `status` is the one command that needs neither a session nor a browser, which
 * makes it the safe first thing to run — and the thing most likely to be trusted
 * without being read. It is also where a failure invisible to types has already
 * shipped once: a class-name collision blanked every KPI number in the dashboard,
 * which no test caught and a screenshot made obvious.
 *
 * So the assertions here are about the numbers reaching the page, not about how
 * it looks. Looking at it is still a human step; see the `/verify` notes in
 * HANDOFF.md.
 */
import test, { before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Scratch } from './support/run.ts'
import { writeFixture, BOOK_TITLE } from './support/fixture.ts'

describe('status, from a cache, offline', () => {
  let scratch: Scratch
  let html: string
  let stdout: string

  before(async () => {
    scratch = await Scratch.create()
    await writeFixture(scratch.cacheRoot)

    const result = await scratch.run(['status', '-o', 'out/status.html'])
    assert.equal(result.code, 0, `the CLI failed:\n${result.output}`)
    stdout = result.output
    html = await readFile(join(scratch.outDir, 'status.html'), 'utf8')
  })

  after(async () => {
    await scratch?.dispose()
  })

  test('counts what the cache actually holds', () => {
    // Four screens of two columns each. The page-image count is the one that
    // catches a cache half-written: meta.json can claim screens whose PNGs are
    // not on disk.
    assert.match(stdout, /1 本 · 4 屏 · 8 张页图/)
  })

  test('reports the book by name, with its capture state', () => {
    assert.match(stdout, /夹具之书：一次虚构的远行/)
    assert.match(stdout, /4 屏 · 3\/4 单元 · interrupted/, 'three of the four 目录 entries were reached')
  })

  test('the numbers reach the page, not just the terminal', () => {
    // The failure this stands for: the KPI numbers were computed correctly and
    // rendered into an element whose class had been taken over by another rule,
    // so the page showed a dashboard of blanks.
    assert.ok(html.includes(BOOK_TITLE), 'the book title is on the page')
    assert.match(html, /8/, 'the page-image count')
    for (const header of ['第一章 出发', '第三章 归程']) {
      assert.ok(html.includes(header), `the running header 「${header}」 is on the page`)
    }
  })

  test('says the book is unfinished rather than leaving it to be inferred', () => {
    assert.match(html, /未抓完/)
  })

  test('escapes a title into the page instead of interpolating it', () => {
    // The chapter titles come out of a book, so they are untrusted input to the
    // report exactly as they are to the EPUB.
    assert.match(html, /「山」 &amp; &lt;海&gt;/)
    assert.doesNotMatch(html, /<海>/)
  })

  test('an empty cache is a report, not a crash', async () => {
    const empty = await Scratch.create()
    try {
      const result = await empty.run(['status', '-o', 'out/status.html'])
      assert.equal(result.code, 0, result.output)
      assert.match(result.output, /0 本/)
    } finally {
      await empty.dispose()
    }
  })
})
