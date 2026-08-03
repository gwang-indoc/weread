/**
 * A minimal ZIP writer, because an EPUB is a ZIP with rules.
 *
 * Written by hand rather than pulled in as a dependency for one reason: EPUB
 * requires the first entry to be an uncompressed `mimetype` with no extra
 * fields, and most convenience wrappers do not expose that. It is ~80 lines of
 * well-specified format, so owning it is cheaper than owning the workaround.
 *
 * Entries carry a fixed 1980-01-01 timestamp. That is deliberate: it makes the
 * archive a pure function of its contents, so the same cache always produces a
 * byte-identical EPUB and `buildEpub` can be tested by comparison.
 */
import { deflateRawSync } from 'node:zlib'

export interface ZipEntry {
  path: string
  data: Buffer
  /** Skip compression. Required for `mimetype`; pointless for PNG/JPEG. */
  store?: boolean
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  return table
})()

export function crc32(buf: Buffer): number {
  let c = -1
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

/** 1980-01-01 00:00:00 in DOS date/time form — the ZIP epoch. */
const DOS_TIME = 0
const DOS_DATE = 0x0021

/**
 * Build the archive.
 *
 * Entries are written in the order given, which matters: an EPUB reader is
 * entitled to read `mimetype` from a fixed offset, so it must be first and
 * stored. `writeEpub` guarantees that; this function just preserves order.
 */
export function zip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8')
    const crc = crc32(entry.data)
    const stored = entry.store === true
    const body = stored ? entry.data : deflateRawSync(entry.data, { level: 9 })
    const method = stored ? 0 : 8
    // Bit 11 declares the name is UTF-8, which CJK titles in file names need.
    const flags = 0x0800

    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28) // no extra field — required for mimetype
    name.copy(local, 30)

    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // disk
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE(0, 38) // external attrs
    central.writeUInt32LE(offset, 42)
    name.copy(central, 46)

    locals.push(local, body)
    centrals.push(central)
    offset += local.length + body.length
  }

  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4) // this disk
  end.writeUInt16LE(0, 6) // disk with directory
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20) // comment length

  return Buffer.concat([...locals, directory, end])
}
