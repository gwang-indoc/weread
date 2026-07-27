/**
 * A local HTML report over the capture cache.
 *
 * Reads only `~/.cache/weread-export`, so it needs no session and no browser —
 * `weread-export status` works offline and while an export is running.
 *
 * Layout follows the prototype's winning variant: a scannable per-book table
 * where each row is followed by that book's filmstrip. Coverage therefore reads
 * two ways — the meter gives the ratio, the strip shows whether those screens
 * are continuous, which is the property a linear walk has to preserve. The full
 * variant set that settled this is on the `prototype/dashboard-variants` branch.
 *
 * Colour follows the data-viz reference palette: one sequential blue hue for
 * every magnitude, and reserved status colours that always ship with an icon and
 * a word, so colour never carries meaning alone.
 */
import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ScreenRecord } from './cache.ts'

const CACHE_ROOT = join(homedir(), '.cache', 'weread-export')

/** One run of consecutive screens sharing a running header. */
export interface Unit {
  header: string
  screens: number
  firstSeq: number
}

export interface BookStatus {
  id: string
  title: string
  /** Written by a cache layout we can no longer interpret; must be re-captured. */
  legacy: boolean
  chapters: number
  screenCount: number
  pages: number
  bytes: number
  outcome: string | null
  note: string | null
  updatedAt: string | null
  units: Unit[]
  screens: Array<{ seq: number; header: string | null; columns: number }>
}

export interface StatusView {
  books: BookStatus[]
  totals: { books: number; screens: number; pages: number; bytes: number }
}

/**
 * Group screens into units by their running header.
 *
 * Consecutive screens with the same header are one unit. A header that recurs
 * after a different one starts a NEW unit rather than joining the earlier one —
 * reading order is what matters here, not identity.
 */
export function unitsOf(screens: Array<{ seq: number; header: string | null }>): Unit[] {
  const units: Unit[] = []
  for (const s of screens) {
    const header = s.header ?? '（无页眉）'
    const last = units[units.length - 1]
    if (last && last.header === header) last.screens++
    else units.push({ header, screens: 1, firstSeq: s.seq })
  }
  return units
}

export function coverageOf(book: BookStatus): number {
  return book.chapters ? Math.min(1, book.units.length / book.chapters) : 0
}

/**
 * Read every cached book.
 *
 * Deliberately reads meta.json directly rather than through `readMeta`: that
 * helper hides caches from older layouts by returning null, and a status report
 * needs to show them so they can be re-captured.
 */
export function collectStatus(cacheRoot: string = CACHE_ROOT): StatusView {
  const books: BookStatus[] = []
  if (existsSync(cacheRoot)) {
    for (const id of readdirSync(cacheRoot)) {
      const dir = join(cacheRoot, id)
      const metaPath = join(dir, 'meta.json')
      if (!existsSync(metaPath)) continue
      let meta: {
        version?: number
        title?: string
        chapters?: unknown[]
        screens?: ScreenRecord[]
        outcome?: string
        note?: string
        updatedAt?: string
      }
      try {
        meta = JSON.parse(readFileSync(metaPath, 'utf8'))
      } catch {
        continue // unreadable cache is not worth reporting on
      }
      const pngs = readdirSync(dir).filter((f) => f.endsWith('.png'))
      const screens = (meta.screens ?? []).map((s) => ({
        seq: s.seq,
        header: s.header ?? null,
        columns: s.files.length,
      }))
      books.push({
        id,
        title: meta.title ?? id,
        legacy: (meta.version ?? 1) < 2,
        chapters: meta.chapters?.length ?? 0,
        screenCount: screens.length,
        pages: pngs.length,
        bytes: pngs.reduce((n, f) => n + statSync(join(dir, f)).size, 0),
        outcome: meta.outcome ?? null,
        note: meta.note ?? null,
        updatedAt: meta.updatedAt ?? null,
        units: unitsOf(screens),
        screens,
      })
    }
  }
  books.sort((a, b) => b.screenCount - a.screenCount)
  return {
    books,
    totals: {
      books: books.length,
      screens: books.reduce((n, b) => n + b.screenCount, 0),
      pages: books.reduce((n, b) => n + b.pages, 0),
      bytes: books.reduce((n, b) => n + b.bytes, 0),
    },
  }
}

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const mb = (bytes: number) => (bytes / 1048576).toFixed(1)
const num = (n: number) => n.toLocaleString('zh-CN')
const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'

/** Status wears an icon and a word; the colour is only reinforcement. */
function chip(book: BookStatus): string {
  if (book.legacy) return '<span class="chip warning"><i class="dot"></i>⚠ 旧格式缓存，已失效</span>'
  if (book.outcome === 'complete') return '<span class="chip good"><i class="dot"></i>✓ 已抓完</span>'
  if (book.outcome === 'unauthorized') return '<span class="chip critical"><i class="dot"></i>✕ 未授权，被截断</span>'
  if (book.outcome === 'interrupted') return '<span class="chip warning"><i class="dot"></i>⚠ 未抓完</span>'
  return '<span class="chip"><i class="dot" style="background:var(--axis)"></i>· 未知</span>'
}

function filmstrip(book: BookStatus): string {
  if (!book.screens.length) {
    return `<p class="muted" style="margin:0">没有可用的屏缓存${book.legacy ? '（旧格式，需 --force 重抓）' : ''}。</p>`
  }
  let alt = false
  let seen: string | null | undefined
  const ticks = book.screens
    .map((s) => {
      const isNew = s.header !== seen
      if (isNew) {
        alt = !alt
        seen = s.header
      }
      return `<i class="tick${alt ? ' alt' : ''}" data-first="${isNew ? 1 : 0}" data-tip="第 ${s.seq} 屏 · ${esc(
        s.header ?? '（无页眉）',
      )} · ${s.columns} 栏"></i>`
    })
    .join('')

  const max = Math.max(...book.units.map((u) => u.screens))
  const top = [...book.units].sort((a, b) => b.screens - a.screens).slice(0, 8)
  return `
    <div class="legend">
      <span><i class="sw" style="background:var(--seq-450)"></i><i class="sw" style="background:var(--seq-250)"></i>一屏，深浅交替＝换单元</span>
      <span class="muted">连续无缺口 = 没有漏页</span>
    </div>
    <div class="strip">${ticks}</div>
    <details>
      <summary>每个单元抓了多少屏 · 前 8 与完整表格</summary>
      <div class="bars">${top
        .map(
          (u) => `<div class="bar-row">
            <span class="name" title="${esc(u.header)}">${esc(u.header)}</span>
            <span class="track" data-tip="${esc(u.header)} · ${u.screens} 屏 · 从第 ${u.firstSeq} 屏起"><i style="width:${(
              (u.screens / max) * 100
            ).toFixed(1)}%"></i></span>
            <span class="val">${u.screens}</span>
          </div>`,
        )
        .join('')}</div>
      <table class="units">
        <thead><tr><th>单元</th><th class="num">屏</th><th class="num">起始屏</th></tr></thead>
        <tbody>${book.units
          .map((u) => `<tr><td>${esc(u.header)}</td><td class="num">${u.screens}</td><td class="num">${u.firstSeq}</td></tr>`)
          .join('')}</tbody>
      </table>
    </details>`
}

/** Pure: the same view always produces the same document. */
export function buildStatusHtml(view: StatusView, generatedAt = ''): string {
  const { books, totals } = view
  const todo = books.filter((b) => b.legacy || b.outcome !== 'complete')

  const empty = `<div class="card"><p style="margin:0">还没有任何缓存。先跑一次 <code>weread-export &lt;书名&gt;</code>。</p></div>`

  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>weread-export · 导出状况</title>
<style>
  /* One sequential blue hue carries every magnitude; the four status colours are
     reserved and never used as series colours. */
  :root {
    --plane:#f9f9f7; --surface:#fcfcfb;
    --ink:#0b0b0b; --ink-2:#52514e; --ink-muted:#898781;
    --grid:#e1e0d9; --axis:#c3c2b7; --ring:rgba(11,11,11,.10);
    --seq-100:#cde2fb; --seq-250:#86b6ef; --seq-450:#2a78d6; --seq-550:#1c5cab;
    --good:#0ca30c; --warning:#fab219; --critical:#d03b3b;
    color-scheme: light;
  }
  @media (prefers-color-scheme: dark) {
    :root:where(:not([data-theme="light"])) {
      --plane:#0d0d0d; --surface:#1a1a19; --ink:#fff; --ink-2:#c3c2b7;
      --grid:#2c2c2a; --axis:#383835; --ring:rgba(255,255,255,.10);
      --seq-450:#3987e5; --seq-550:#256abf;
      color-scheme: dark;
    }
  }
  :root[data-theme="dark"] {
    --plane:#0d0d0d; --surface:#1a1a19; --ink:#fff; --ink-2:#c3c2b7;
    --grid:#2c2c2a; --axis:#383835; --ring:rgba(255,255,255,.10);
    --seq-450:#3987e5; --seq-550:#256abf;
    color-scheme: dark;
  }
  * { box-sizing: border-box; }
  body {
    margin:0; padding:0 0 40px; background:var(--plane); color:var(--ink);
    font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;
    font-variant-numeric: tabular-nums;
  }
  header { padding:26px 24px 6px; }
  header h1 { margin:0; font-size:17px; font-weight:650; letter-spacing:-.01em; }
  header p { margin:4px 0 0; color:var(--ink-muted); font-size:12.5px; }
  main { padding:16px 24px; }
  .card { background:var(--surface); border:1px solid var(--ring); border-radius:10px; padding:16px 18px; margin-bottom:14px; }
  .card > h2 { margin:0 0 12px; font-size:12px; font-weight:650; letter-spacing:.06em; text-transform:uppercase; color:var(--ink-muted); }
  .muted { color:var(--ink-muted); font-size:12px; }
  code { background:var(--plane); border:1px solid var(--ring); border-radius:4px; padding:1.5px 5px; font-size:12px; }

  .top { display:flex; align-items:flex-end; gap:28px; flex-wrap:wrap; }
  .hero { font-size:54px; font-weight:630; letter-spacing:-.03em; line-height:1; }
  .hero .u { font-size:20px; font-weight:400; color:var(--ink-2); margin-left:3px; }
  .kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:1px; background:var(--ring); border-radius:10px; overflow:hidden; flex:1; min-width:280px; }
  .kpi { background:var(--surface); padding:14px 16px; }
  .kpi .k { font-size:11.5px; color:var(--ink-muted); letter-spacing:.04em; }
  .kpi .val { font-size:26px; font-weight:620; letter-spacing:-.02em; margin-top:2px; }
  .kpi .val span { font-size:12px; color:var(--ink-2); font-weight:400; margin-left:3px; }

  .chip { display:inline-flex; align-items:center; gap:5px; font-size:12px; font-weight:550; white-space:nowrap; }
  .chip .dot { width:8px; height:8px; border-radius:50%; flex:none; }
  .chip.good .dot { background:var(--good); }
  .chip.warning .dot { background:var(--warning); }
  .chip.critical .dot { background:var(--critical); }

  .meter { height:8px; background:var(--seq-100); border-radius:4px; overflow:hidden; }
  .meter > i { display:block; height:100%; background:var(--seq-450); border-radius:4px; }

  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { text-align:left; font-size:11px; font-weight:600; letter-spacing:.05em; text-transform:uppercase; color:var(--ink-muted); padding:0 10px 8px 0; border-bottom:1px solid var(--grid); }
  td { padding:11px 10px 11px 0; vertical-align:middle; }
  td.num, th.num { text-align:right; }
  /* Keep the right-aligned 体积 column off the 更新 header beside it. */
  table.books th:last-child, table.books td:last-child { padding-left:16px; }
  /* One tbody per book, so the hairline separates books rather than a row from
     its own detail. */
  table.books tbody { border-bottom:1px solid var(--grid); }
  table.books tbody:last-child { border-bottom:0; }
  tr.detail td { padding:2px 0 18px; }

  .legend { display:flex; gap:14px; align-items:center; font-size:12px; color:var(--ink-2); margin-bottom:7px; }
  .legend .sw { width:10px; height:10px; border-radius:2px; display:inline-block; margin-right:3px; vertical-align:-1px; }
  .strip { display:flex; gap:2px; flex-wrap:wrap; align-items:flex-end; }
  .tick { width:7px; height:22px; border-radius:2px 2px 0 0; background:var(--seq-450); }
  .tick.alt { background:var(--seq-250); }
  .tick[data-first="1"] { box-shadow:inset 2px 0 0 var(--seq-550); }

  details { margin-top:12px; }
  summary { cursor:pointer; font-size:12.5px; color:var(--ink-2); }
  .bars { display:grid; gap:7px; margin-top:10px; }
  .bar-row { display:grid; grid-template-columns:190px 1fr 52px; gap:10px; align-items:center; font-size:12.5px; }
  .bar-row .name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--ink-2); }
  .track { background:var(--plane); border-radius:3px; height:14px; position:relative; }
  .track > i { position:absolute; inset:0 auto 0 0; background:var(--seq-450); border-radius:0 4px 4px 0; }
  .bar-row .val { text-align:right; color:var(--ink-2); }
  table.units { margin-top:12px; }
  table.units td { padding:7px 10px 7px 0; border-bottom:1px solid var(--grid); }

  #tip { position:fixed; z-index:60; pointer-events:none; opacity:0; transition:opacity .1s;
    background:var(--ink); color:var(--plane); font-size:12px; padding:6px 9px; border-radius:6px;
    max-width:260px; box-shadow:0 4px 14px rgba(0,0,0,.22); }
</style>

<header>
  <h1>weread-export · 导出状况</h1>
  <p>只读本地缓存 ~/.cache/weread-export${generatedAt ? ` · 生成于 ${esc(generatedAt)}` : ''}</p>
</header>
<main>
${
  books.length === 0
    ? empty
    : `<div class="card">
  <h2>缓存总量</h2>
  <div class="top">
    <div>
      <div class="hero">${mb(totals.bytes)}<span class="u">MB</span></div>
      <div class="muted" style="margin-top:4px">${num(totals.pages)} 张页图 · ${num(totals.screens)} 屏</div>
    </div>
    <div class="kpis">
      <div class="kpi"><div class="k">书</div><div class="val">${totals.books}</div></div>
      <div class="kpi"><div class="k">已抓屏数</div><div class="val">${num(totals.screens)}</div></div>
      <div class="kpi"><div class="k">PDF 页数</div><div class="val">${num(totals.pages)}</div></div>
      <div class="kpi"><div class="k">平均每页</div><div class="val">${
        totals.pages ? Math.round(totals.bytes / totals.pages / 1024) : 0
      }<span>KB</span></div></div>
    </div>
  </div>
</div>

<div class="card">
  <h2>逐本状况</h2>
  <table class="books">
    <thead><tr>
      <th>书</th><th>状态</th><th style="width:180px">已覆盖单元</th>
      <th class="num">屏</th><th class="num">页图</th><th class="num">体积</th><th>更新</th>
    </tr></thead>
    ${books
      .map(
        (b) => `<tbody>
      <tr>
        <td><b>${esc(b.title)}</b><div class="muted" style="font-size:11px">${esc(b.id)}</div></td>
        <td>${chip(b)}${b.note ? `<div class="muted" style="font-size:11px">${esc(b.note)}</div>` : ''}</td>
        <td>
          <div class="meter" data-tip="${b.units.length} / ${b.chapters} 个目录单元出现过"><i style="width:${(
            coverageOf(b) * 100
          ).toFixed(1)}%"></i></div>
          <div class="muted" style="font-size:11px;margin-top:3px">${b.units.length} / ${b.chapters}（${(
            coverageOf(b) * 100
          ).toFixed(0)}%）</div>
        </td>
        <td class="num">${num(b.screenCount)}</td>
        <td class="num">${num(b.pages)}</td>
        <td class="num">${mb(b.bytes)} MB</td>
        <td class="muted" style="font-size:12px">${when(b.updatedAt)}</td>
      </tr>
      <tr class="detail"><td colspan="7">${filmstrip(b)}</td></tr>
    </tbody>`,
      )
      .join('')}
  </table>
</div>

${
  todo.length
    ? `<div class="card">
  <h2>需要处理 · ${todo.length}</h2>
  ${todo
    .map(
      (b) => `<div style="display:flex;gap:12px;align-items:baseline;padding:9px 0;border-bottom:1px solid var(--grid)">
    <div style="flex:1"><b>${esc(b.title)}</b> ${chip(b)}</div>
    <code>weread-export ${esc(b.title.slice(0, 4))}${b.legacy ? ' --force' : ''}</code>
  </div>`,
    )
    .join('')}
  <p class="muted" style="margin:10px 0 0">未抓完的书重跑同一命令会续抓；旧格式缓存必须 <code>--force</code> 重来。</p>
</div>`
    : ''
}`
}
</main>
<div id="tip" role="status"></div>
<script>
  // Every mark that encodes a value gets a tooltip.
  const tip = document.getElementById('tip');
  addEventListener('mousemove', (e) => {
    const el = e.target.closest('[data-tip]');
    if (!el) { tip.style.opacity = 0; return; }
    tip.textContent = el.dataset.tip;
    tip.style.opacity = 1;
    tip.style.left = Math.min(e.clientX + 14, innerWidth - 275) + 'px';
    tip.style.top = (e.clientY + 18) + 'px';
  });
</script>
`
}

/** Write the report and return its file:// URL. */
export async function writeStatusReport(outPath: string, view = collectStatus()): Promise<string> {
  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, buildStatusHtml(view, new Date().toLocaleString('zh-CN')))
  return pathToFileURL(outPath).href
}
