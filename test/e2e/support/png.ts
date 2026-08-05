/**
 * A minimal grayscale PNG encoder, for building fixture page images.
 *
 * The cache stores captured pages as PNGs, so a fixture cache needs PNGs. It
 * must not contain *real* ones: a captured page is a publisher's page, under the
 * 数字版权声明 this project quotes back at itself — 「仅供您个人使用，未经授权，不得
 * 进行传播」 — and a committed fixture is distribution. So the pages here are
 * drawn from the same geometry the fixture's OCR lines describe, not captured.
 *
 * Grayscale (colour type 0) with no palette keeps this to about forty lines and
 * keeps the files small: a page of black bars on white deflates to a couple of
 * hundred bytes, which is what lets the whole fixture live in the repo.
 */
import { deflateSync } from 'node:zlib'
import { crc32 } from '../../../src/zip.ts'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** length + type + data + CRC over (type + data) — the PNG chunk framing. */
function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const tail = Buffer.alloc(4)
  // The CRC covers the type as well as the payload, so it is computed over the
  // slice of `head` holding the type rather than over `data` alone.
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, tail])
}

/** A filled rectangle in pixel coordinates, clipped to the canvas by `drawPng`. */
export interface Bar {
  x: number
  y: number
  width: number
  height: number
  /** 0 is black, 255 is white. */
  grey?: number
}

/**
 * Draw white paper with dark bars on it and encode the result.
 *
 * Every scanline is written with filter type 0 (None). Filtering would compress
 * better, but a fixture page is already a few hundred bytes and an unfiltered
 * encoder is one that can be read in a sitting.
 */
export function drawPng(width: number, height: number, bars: Bar[]): Buffer {
  const stride = width + 1
  const raw = Buffer.alloc(stride * height, 0xff)
  for (let y = 0; y < height; y++) raw[y * stride] = 0 // filter: None

  for (const bar of bars) {
    const grey = bar.grey ?? 0x22
    const x0 = Math.max(0, Math.round(bar.x))
    const x1 = Math.min(width, Math.round(bar.x + bar.width))
    const y0 = Math.max(0, Math.round(bar.y))
    const y1 = Math.min(height, Math.round(bar.y + bar.height))
    for (let y = y0; y < y1; y++) {
      raw.fill(grey, y * stride + 1 + x0, y * stride + 1 + x1)
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // colour type: grayscale
  ihdr[10] = 0 // compression: deflate
  ihdr[11] = 0 // filter method: adaptive
  ihdr[12] = 0 // interlace: none

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    // zlib-wrapped, not raw — IDAT carries a zlib stream, unlike a ZIP member.
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
