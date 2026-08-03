/**
 * Reading the cached page images with macOS's Vision framework.
 *
 * This is the only impure half of the EPUB path: it runs a helper binary over
 * the cache and hands plain data to text.ts, which does the interpreting. The
 * helper is deliberately dumb — pixels in, one JSON line per recognised line
 * out, in coordinates normalised to the whole column — so that everything which
 * shapes the export stays testable offline.
 *
 * Two things here are not obvious and are the reason ADR 0003 exists:
 *
 * 1. Recognition runs in overlapping horizontal bands rather than one pass over
 *    the column. Vision's detection scale gets captured by dense small text: on
 *    an illustrated page it transcribed a manuscript facsimile and returned
 *    *none* of the large, legible Chinese sharing the page — silently.
 * 2. Even banded, a band that contains a facsimile can still swallow a heading
 *    next to it. So after the banded pass, every vertical hole is recognised
 *    again on its own before we conclude it is a picture rather than text.
 *
 * Results are cached per column hash next to the images, so a re-run — or a
 * re-typeset with different EPUB settings — costs nothing.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createInterface } from 'node:readline'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CACHE_ROOT, bookDir } from './cache.ts'
import { columnMetrics, findHoles, mergeLines, type OcrColumn, type OcrLine } from './text.ts'

/** How many bands a full column is recognised in, and how much they overlap. */
const BANDS = 6
const OVERLAP = 0.25
/** How many times a hole is re-recognised before it is called a picture. */
const REFINE_ROUNDS = 2

export class OcrUnavailableError extends Error {}

const VISION_SWIFT = String.raw`
import Foundation
import Vision
import AppKit

// Protocol: one JSON command per line on stdin, one JSON result per line on
// stdout, in order. Coordinates in and out are fractions of the FULL image, so
// the caller never has to know a band from a crop.
//
//   {"op":"ocr","path":"...","top":0.0,"height":1.0,"bands":6}
//   {"op":"crop","src":"...","dst":"...","top":0.1,"height":0.5}

let out = FileHandle.standardOutput
func emit(_ s: String) { out.write((s + "\n").data(using: .utf8)!) }

func esc(_ s: String) -> String {
    var r = ""
    for c in s.unicodeScalars {
        switch c {
        case "\"": r += "\\\""
        case "\\": r += "\\\\"
        case "\n": r += "\\n"
        case "\r": r += "\\r"
        case "\t": r += "\\t"
        default:
            if c.value < 0x20 { r += String(format: "\\u%04x", c.value) } else { r.unicodeScalars.append(c) }
        }
    }
    return r
}

func load(_ path: String) -> CGImage? {
    guard let img = NSImage(contentsOfFile: path),
          let tiff = img.tiffRepresentation,
          let rep = NSBitmapImageRep(data: tiff) else { return nil }
    return rep.cgImage
}

func recognise(_ cg: CGImage) -> [VNRecognizedTextObservation] {
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.recognitionLanguages = ["zh-Hans", "en-US"]
    req.usesLanguageCorrection = true
    do { try VNImageRequestHandler(cgImage: cg, options: [:]).perform([req]) } catch { return [] }
    return req.results ?? []
}

/// How much of a region is covered in ink, and how that ink is spread.
///
/// Two numbers, because the fraction alone cannot tell a picture from a rule.
/// A hairline separator in a short region scores a *higher* ink fraction (0.21)
/// than the outline of a quotation box (0.02), and neither is an illustration,
/// while a real plate scores 0.57. What separates them is shape: a picture fills
/// rows, a rule occupies one, and a box outline puts a couple of pixels in every
/// row and everything else in one. So the second number counts only rows with
/// substantial ink: near 1 for a plate, near 0 for both kinds of decoration.
func inkProfile(_ cg: CGImage) -> (fraction: Double, rows: Double) {
    let w = min(cg.width, 240), h = max(1, min(cg.height, 480))
    var buf = [UInt8](repeating: 255, count: w * h)
    guard let ctx = CGContext(data: &buf, width: w, height: h, bitsPerComponent: 8,
                             bytesPerRow: w, space: CGColorSpaceCreateDeviceGray(),
                             bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return (1, 1) }
    ctx.setFillColor(gray: 1, alpha: 1)
    ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
    ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))

    var hist = [Int](repeating: 0, count: 256)
    for v in buf { hist[Int(v)] += 1 }
    var background = 0, most = -1
    for (value, count) in hist.enumerated() where count > most { most = count; background = value }

    var ink = 0
    var inkyRows = 0
    for row in 0..<h {
        var rowInk = 0
        for col in 0..<w where abs(Int(buf[row * w + col]) - background) > 16 { rowInk += 1 }
        ink += rowInk
        if Double(rowInk) / Double(w) >= 0.03 { inkyRows += 1 }
    }
    return (Double(ink) / Double(w * h), Double(inkyRows) / Double(h))
}

func handleOcr(_ cmd: [String: Any]) {
    let path = cmd["path"] as? String ?? ""
    guard let full = load(path) else { emit("{\"error\":\"unreadable\"}"); return }
    let top = cmd["top"] as? Double ?? 0
    let height = cmd["height"] as? Double ?? 1
    let bands = max(1, cmd["bands"] as? Int ?? 1)

    let H = Double(full.height)
    let regionY = Int((top * H).rounded())
    let regionH = max(1, min(full.height - regionY, Int((height * H).rounded())))
    guard let region = full.cropping(to: CGRect(x: 0, y: regionY, width: full.width, height: regionH)) else {
        emit("{\"error\":\"crop failed\"}"); return
    }

    let bandH = max(1, Int((Double(regionH) / Double(bands)).rounded(.up)))
    let step = max(1, Int(Double(bandH) * (1 - ${OVERLAP})))
    var parts: [String] = []
    var y = 0
    while y < regionH {
        let h = min(bandH, regionH - y)
        guard let band = region.cropping(to: CGRect(x: 0, y: y, width: region.width, height: h)) else { break }
        for obs in recognise(band) {
            guard let best = obs.topCandidates(1).first else { continue }
            let b = obs.boundingBox
            // Band-local (bottom-left origin) -> whole-image, top-down.
            let topPx = Double(regionY + y) + (1 - b.maxY) * Double(h)
            parts.append(String(format: "{\"t\":%.5f,\"l\":%.5f,\"w\":%.5f,\"h\":%.5f,\"c\":%.3f,\"s\":\"%@\"}",
                                topPx / H, b.minX, b.width, b.height * Double(h) / H,
                                best.confidence, esc(best.string)))
        }
        if y + h >= regionH { break }
        y += step
    }
    emit("{\"width\":\(full.width),\"height\":\(full.height),\"lines\":[\(parts.joined(separator: ","))]}")
}

func handleCrop(_ cmd: [String: Any]) {
    let src = cmd["src"] as? String ?? ""
    let dst = cmd["dst"] as? String ?? ""
    guard let full = load(src) else { emit("{\"error\":\"unreadable\"}"); return }
    let H = Double(full.height)
    let top = cmd["top"] as? Double ?? 0
    let height = cmd["height"] as? Double ?? 1
    // Two insets, because the question "is there a picture here" and the answer
    // "here is the picture" want different rectangles. Vision's line boxes sit
    // slightly below the actual tops of CJK glyphs, so a region bounded by a text
    // line includes a sliver of that line's ink — enough to read as a picture.
    // The probe inset is wide enough to exclude such a sliver; the output inset
    // is narrow, so a real plate is not visibly clipped.
    let probeInset = cmd["probeInset"] as? Double ?? 0
    let cropInset = cmd["cropInset"] as? Double ?? 0

    func rect(_ inset: Double) -> CGRect? {
        let y = Int(((top + inset) * H).rounded())
        let h = Int(((height - 2 * inset) * H).rounded())
        if h < 8 || y < 0 || y >= full.height { return nil }
        return CGRect(x: 0, y: y, width: full.width, height: min(full.height - y, h))
    }

    guard let probeRect = rect(probeInset), let probe = full.cropping(to: probeRect) else {
        emit("{\"blank\":true,\"ink\":0,\"rows\":0}"); return
    }
    let (ink, rows) = inkProfile(probe)
    // Anything that is not a two-dimensional picture is reported rather than
    // written, and the caller drops it — so a page margin, a chapter that ended
    // early, a hairline separator and the border of a quotation box all stay out
    // of the EPUB instead of appearing as mystery images.
    if ink < 0.015 || rows < 0.30 {
        emit("{\"blank\":true,\"ink\":\(ink),\"rows\":\(rows)}"); return
    }

    guard let outRect = rect(cropInset), let piece = full.cropping(to: outRect) else {
        emit("{\"blank\":true,\"ink\":\(ink),\"rows\":\(rows)}"); return
    }
    let rep = NSBitmapImageRep(cgImage: piece)
    guard let data = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.85]) else {
        emit("{\"error\":\"encode failed\"}"); return
    }
    do { try data.write(to: URL(fileURLWithPath: dst)) } catch {
        emit("{\"error\":\"\(esc("\(error)"))\"}"); return
    }
    emit("{\"blank\":false,\"ink\":\(ink),\"rows\":\(rows),\"bytes\":\(data.count)}")
}

while let line = readLine(strippingNewline: true) {
    if line.isEmpty { continue }
    guard let data = line.data(using: .utf8),
          let cmd = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
        emit("{\"error\":\"bad command\"}"); continue
    }
    switch cmd["op"] as? String {
    case "ocr": handleOcr(cmd)
    case "crop": handleCrop(cmd)
    default: emit("{\"error\":\"unknown op\"}")
    }
}
`

interface OcrReply {
  width?: number
  height?: number
  lines?: OcrLine[]
  error?: string
}

interface CropReply {
  blank?: boolean
  ink?: number
  rows?: number
  bytes?: number
  error?: string
}

/**
 * Compile the helper on first use and cache it by the hash of its source, so
 * editing the Swift above rebuilds and a stale binary can never be reused.
 */
async function ensureHelper(): Promise<string> {
  if (process.platform !== 'darwin') {
    throw new OcrUnavailableError('EPUB 导出需要 macOS 的 Vision 框架（PDF 导出不受影响）')
  }
  const digest = createHash('sha1').update(VISION_SWIFT).digest('hex').slice(0, 12)
  const dir = join(CACHE_ROOT, 'bin')
  const binary = join(dir, `vision-${digest}`)
  if (existsSync(binary)) return binary

  await mkdir(dir, { recursive: true })
  const source = `${binary}.swift`
  await writeFile(source, VISION_SWIFT)
  await new Promise<void>((resolve, reject) => {
    const child = spawn('swiftc', ['-O', source, '-o', binary], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (d) => (stderr += String(d)))
    child.on('error', () => reject(new OcrUnavailableError('找不到 swiftc，请安装 Xcode Command Line Tools：xcode-select --install')))
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new OcrUnavailableError(`编译 OCR 辅助程序失败：\n${stderr.trim()}`)),
    )
  })
  return binary
}

type Resolver = (value: unknown) => void

/**
 * A live helper process.
 *
 * Replies are matched to commands by order rather than by an id, which is safe
 * because the helper is strictly sequential — it reads one line, answers it, and
 * only then reads the next. Keeping one process alive for a whole book matters:
 * a 600-page book is ~4000 recognition calls, and paying process startup for
 * each would dominate the run.
 */
class Vision {
  readonly #child: import('node:child_process').ChildProcess
  readonly #queue: Resolver[] = []

  private constructor(child: import('node:child_process').ChildProcess, queue: Resolver[]) {
    this.#child = child
    this.#queue = queue
  }

  static async start(): Promise<Vision> {
    const binary = await ensureHelper()
    const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'inherit'] })
    const queue: Resolver[] = []
    createInterface({ input: child.stdout! }).on('line', (line) => {
      const resolve = queue.shift()
      if (!resolve) return
      try {
        resolve(JSON.parse(line))
      } catch {
        resolve({ error: `unparsable reply: ${line.slice(0, 120)}` })
      }
    })
    // A dead helper must reject everything outstanding, or the export would hang
    // on a promise that can never settle.
    child.on('exit', () => {
      while (queue.length) queue.shift()!({ error: 'OCR 辅助程序已退出' })
    })
    return new Vision(child, queue)
  }

  #send<T>(command: object): Promise<T> {
    return new Promise<T>((resolve) => {
      this.#queue.push(resolve as Resolver)
      this.#child.stdin!.write(`${JSON.stringify(command)}\n`)
    })
  }

  ocr(path: string, top = 0, height = 1, bands = 1): Promise<OcrReply> {
    return this.#send<OcrReply>({ op: 'ocr', path, top, height, bands })
  }

  crop(src: string, dst: string, region: Omit<CropRequest, 'file' | 'id'>): Promise<CropReply> {
    return this.#send<CropReply>({ op: 'crop', src, dst, ...region })
  }

  close(): void {
    this.#child.stdin!.end()
  }
}

/**
 * Recognise one column, then re-recognise its holes.
 *
 * The refinement pass is not an optimisation, it is a correctness measure: a
 * band containing a dense facsimile can still lose a heading beside it, and the
 * only way to tell "picture" from "text Vision declined to see" is to look at
 * the region on its own.
 */
async function readColumn(vision: Vision, path: string): Promise<OcrColumn> {
  const first = await vision.ocr(path, 0, 1, BANDS)
  if (first.error) throw new Error(`OCR 失败 ${path}: ${first.error}`)
  const width = first.width ?? 0
  const height = first.height ?? 0
  let lines = first.lines ?? []

  for (let round = 0; round < REFINE_ROUNDS; round++) {
    const { lineHeight } = columnMetrics(lines.length ? lines : [{ t: 0, l: 0, w: 1, h: 0.03, c: 1, s: '' }])
    const holes = findHoles(mergeLines(lines, lineHeight), lineHeight)
    if (!holes.length) break

    let gained = 0
    for (const hole of holes) {
      // Nothing legible fits in less than a line, and asking wastes a second.
      if (hole.height < lineHeight * 1.2) continue
      const reply = await vision.ocr(path, hole.top, hole.height, 1)
      const found = reply.lines ?? []
      if (found.length) {
        lines = lines.concat(found)
        gained += found.length
      }
    }
    if (!gained) break
  }

  return { width, height, lines }
}

export interface OcrCache {
  version: number
  /** Column content hash -> what was recognised in it. */
  columns: Record<string, OcrColumn>
}

/** Bumped when banding or refinement changes what a pass would return. */
export const OCR_VERSION = 1

const ocrPath = (bookId: string) => join(bookDir(bookId), 'ocr.json')

export async function readOcrCache(bookId: string): Promise<OcrCache> {
  const path = ocrPath(bookId)
  if (!existsSync(path)) return { version: OCR_VERSION, columns: {} }
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as OcrCache
    if (parsed.version !== OCR_VERSION) return { version: OCR_VERSION, columns: {} }
    return parsed
  } catch {
    return { version: OCR_VERSION, columns: {} }
  }
}

export interface RecogniseTarget {
  file: string
  hash: string
}

export interface RecogniseOptions {
  onProgress?: (done: number, total: number) => void
  /** Re-recognise even columns already in the cache. */
  force?: boolean
}

/**
 * Recognise every column of a book, reusing whatever the cache already holds.
 *
 * Keyed by column hash rather than file name, matching how captures are
 * identified (ADR 0002), so a resumed or partially re-captured book does not
 * re-read pages it has already read.
 */
export async function recogniseColumns(
  bookId: string,
  targets: RecogniseTarget[],
  opts: RecogniseOptions = {},
): Promise<Map<string, OcrColumn>> {
  const { onProgress = () => {}, force = false } = opts
  const cache = await readOcrCache(bookId)
  const pending = targets.filter((t) => force || !cache.columns[t.hash])
  const byFile = new Map<string, OcrColumn>()

  if (pending.length) {
    const vision = await Vision.start()
    try {
      let done = 0
      for (const target of pending) {
        cache.columns[target.hash] = await readColumn(vision, join(bookDir(bookId), target.file))
        done++
        onProgress(done, pending.length)
        // Persist as we go: OCR of a long book is minutes of work, and an
        // interruption must not throw all of it away.
        if (done % 20 === 0) await writeFile(ocrPath(bookId), JSON.stringify(cache))
      }
    } finally {
      vision.close()
      await writeFile(ocrPath(bookId), JSON.stringify(cache))
    }
  }

  for (const target of targets) {
    const column = cache.columns[target.hash]
    if (column) byFile.set(target.file, column)
  }
  return byFile
}

export interface CropRequest {
  file: string
  top: number
  height: number
  id: string
  /** Shrink by this much (fraction of column height) before testing for ink. */
  probeInset: number
  /** Shrink by this much before writing the image out. */
  cropInset: number
}

/**
 * Crop the illustration regions out of the cached PNGs, as JPEG.
 *
 * JPEG rather than PNG because these regions are photographic — manuscript
 * scans and plates — where PNG costs several times the bytes for no visible
 * gain. Regions the helper reports as blank are dropped: a chapter that ended
 * halfway down a column leaves a hole that is not a picture.
 */
export async function cropIllustrations(
  bookId: string,
  requests: CropRequest[],
): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>()
  if (!requests.length) return out

  const dir = join(bookDir(bookId), 'crops')
  await mkdir(dir, { recursive: true })
  const vision = await Vision.start()
  try {
    for (const { file, id, ...region } of requests) {
      const dst = join(dir, `${id}.jpg`)
      const reply = await vision.crop(join(bookDir(bookId), file), dst, region)
      if (reply.error || reply.blank) continue
      out.set(id, await readFile(dst))
    }
  } finally {
    vision.close()
  }
  return out
}
