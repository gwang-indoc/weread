/**
 * Opening an EPUB and checking what is inside it.
 *
 * `src/zip.ts` can write an archive but not read one, and the gate has to read
 * what the CLI produced rather than trust the builder that produced it. So this
 * reads the archive the way a reader does — from the central directory, not by
 * walking local headers — and re-checks every CRC, which is the one assertion
 * that catches a corrupt member rather than a merely surprising one.
 */
import { inflateRawSync } from 'node:zlib'
import { crc32 } from '../../../src/zip.ts'

export interface ZipMember {
  path: string
  data: Buffer
  /** Stored rather than deflated. EPUB requires this of `mimetype`. */
  stored: boolean
  /** Offset of this member's local header, so "is it first?" is answerable. */
  offset: number
  /** The stored CRC matched the data we inflated. */
  crcOk: boolean
}

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50

export function readZip(buf: Buffer): ZipMember[] {
  // The end-of-central-directory record is last, but a trailing comment can push
  // it back, so it is found by scanning backwards for its signature.
  let eocd = -1
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not a ZIP archive: no end-of-central-directory record')

  const count = buf.readUInt16LE(eocd + 10)
  let cursor = buf.readUInt32LE(eocd + 16)
  const members: ZipMember[] = []

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(cursor) !== CENTRAL) {
      throw new Error(`central directory entry ${n} has a bad signature`)
    }
    const method = buf.readUInt16LE(cursor + 10)
    const crc = buf.readUInt32LE(cursor + 16)
    const compressedSize = buf.readUInt32LE(cursor + 20)
    const nameLen = buf.readUInt16LE(cursor + 28)
    const extraLen = buf.readUInt16LE(cursor + 30)
    const commentLen = buf.readUInt16LE(cursor + 32)
    const offset = buf.readUInt32LE(cursor + 42)
    const path = buf.toString('utf8', cursor + 46, cursor + 46 + nameLen)

    if (buf.readUInt32LE(offset) !== LOCAL) {
      throw new Error(`「${path}」 points at offset ${offset}, which is not a local header`)
    }
    // The local header's own name and extra lengths are what locate the data;
    // they are allowed to differ from the central directory's.
    const localNameLen = buf.readUInt16LE(offset + 26)
    const localExtraLen = buf.readUInt16LE(offset + 28)
    const start = offset + 30 + localNameLen + localExtraLen
    const body = buf.subarray(start, start + compressedSize)
    const data = method === 0 ? Buffer.from(body) : inflateRawSync(body)

    members.push({ path, data, stored: method === 0, offset, crcOk: crc32(data) === crc })
    cursor += 46 + nameLen + extraLen + commentLen
  }

  return members
}

/**
 * Structural problems in an XML document, as a list of complaints.
 *
 * This is deliberately *not* called a validator. Node ships no XML parser, and
 * writing a conforming one to test a fixture would be its own project. What this
 * checks is the class of failure that has actually shipped from this code path —
 * a character that needed escaping and did not get escaped, and a tag left open
 * — both of which make the file unopenable in a reader while being invisible to
 * `tsc`. A document that passes this is not proven well-formed; a document that
 * fails it is definitely broken.
 */
export function findXmlProblems(text: string): string[] {
  const problems: string[] = []
  const stack: Array<{ name: string; at: number }> = []
  const at = (i: number) => `line ${text.slice(0, i).split('\n').length}`

  // Entities XHTML defines, plus numeric character references.
  const ENTITY = /^&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9A-Fa-f]+);/

  let i = 0
  while (i < text.length) {
    const ch = text[i]!

    if (ch === '&') {
      if (!ENTITY.test(text.slice(i, i + 12))) {
        problems.push(`${at(i)}: a raw & that is not an entity — 「${text.slice(i, i + 20)}」`)
      }
      i++
      continue
    }

    if (ch !== '<') {
      i++
      continue
    }

    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i)
      if (end < 0) {
        problems.push(`${at(i)}: an unterminated comment`)
        break
      }
      i = end + 3
      continue
    }
    // The XML declaration and the doctype carry no nesting.
    if (text.startsWith('<?', i) || text.startsWith('<!', i)) {
      const end = text.indexOf('>', i)
      if (end < 0) {
        problems.push(`${at(i)}: an unterminated declaration`)
        break
      }
      i = end + 1
      continue
    }

    const end = findTagEnd(text, i)
    if (end < 0) {
      problems.push(`${at(i)}: an unterminated tag — 「${text.slice(i, i + 30)}」`)
      break
    }
    const tag = text.slice(i, end + 1)
    const name = /^<\/?\s*([^\s/>]+)/.exec(tag)?.[1]

    if (!name) {
      // `< ` in text rather than a tag: exactly what escaping is meant to prevent.
      problems.push(`${at(i)}: a raw < that does not open a tag — 「${tag.slice(0, 20)}」`)
      i = end + 1
      continue
    }

    if (tag.startsWith('</')) {
      const open = stack.pop()
      if (!open) problems.push(`${at(i)}: </${name}> closes nothing`)
      else if (open.name !== name) {
        problems.push(`${at(i)}: </${name}> closes <${open.name}>, opened at ${at(open.at)}`)
      }
    } else if (!tag.endsWith('/>')) {
      stack.push({ name, at: i })
    }

    i = end + 1
  }

  for (const open of stack) problems.push(`${at(open.at)}: <${open.name}> is never closed`)
  return problems
}

/** The `>` that ends a tag, skipping any inside a quoted attribute value. */
function findTagEnd(text: string, start: number): number {
  let quote: string | null = null
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '>') return i
  }
  return -1
}
