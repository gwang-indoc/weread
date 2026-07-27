/**
 * Domain vocabulary. Names here are canonical — see CONTEXT.md.
 */

/** A WeRead 书, identified by the id embedded in its reader URL. */
export interface Book {
  id: string
  title: string
  readerUrl: string
}

/**
 * A node in a book's 目录. `level` 1 is a 分卷 or top-level 章; level 2 is a 节.
 * A Volume (level 1 with children) carries no content of its own.
 */
export interface Chapter {
  index: number
  level: number
  title: string
}

/** One paragraph of prose, positioned as it appeared on screen. */
export interface TextBlock {
  kind: 'text'
  text: string
  x: number
  y: number
  column: number
}

/** One illustration, whether an <img> or a CSS background-image. */
export interface ImageBlock {
  kind: 'image'
  src: string
  x: number
  y: number
  column: number
}

export type Block = TextBlock | ImageBlock

/**
 * What the reader displays at one moment — for WeRead's horizontal layout that
 * is two columns side by side, which together form one logical reading unit.
 */
export interface Screen {
  /** Running header, i.e. the current chapter title. Not prose. */
  header: string | null
  blocks: Block[]
  /** Cheap identity used to detect "pagination didn't advance". */
  signature: string
}

/**
 * A raw on-screen item straight out of the browser, before any ordering.
 * Kept deliberately dumb and serialisable so it can be saved as a test fixture
 * and replayed offline.
 */
export interface RawItem {
  kind: 'text' | 'image'
  /** Prose for text items, URL for image items. */
  value: string
  /** Key identifying the nearest block-level ancestor, to group text nodes. */
  blockKey: string
  x: number
  y: number
  width: number
  height: number
  fontSize: number
}

export interface Viewport {
  width: number
  height: number
}
