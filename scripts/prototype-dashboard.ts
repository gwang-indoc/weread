/**
 * PROTOTYPE — throwaway. Delete once a variant has won.
 *
 * Question: what should a dashboard over the export cache look like?
 *
 * Three structurally different variants of the same data, switchable via
 * `?variant=A|B|C` and the floating bar at the bottom. There is no web app in
 * this project, so this is a self-contained HTML file generated from the real
 * cache and opened over file:// — captured page images are referenced in place
 * rather than copied.
 *
 * Assumption stated up front (the prompt said only "做个 dashboard 看看"): the
 * dashboard is about **export health** — what is cached, how complete it is,
 * how big it is, and whether the captures look right. It is read-only; nothing
 * here triggers an export.
 *
 *   A  运维台   — KPI row + per-book coverage meters + what to do next
 *   B  质检台   — contact sheet of the actual captured pages
 *   C  结构带   — filmstrip of reading order + screens-per-unit distribution
 *
 * Run: pnpm prototype:dashboard
 */
import { readdirSync, statSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const CACHE_ROOT = join(homedir(), '.cache', 'weread-export')
const OUT = join('out', 'prototype-dashboard.html')
/** Contact sheet cap — surfaced in the UI rather than silently truncating. */
const THUMB_CAP = 120

interface Unit {
  header: string
  screens: number
  firstSeq: number
}

interface BookView {
  id: string
  title: string
  legacy: boolean
  chapters: number
  screenCount: number
  pngs: number
  bytes: number
  outcome: string | null
  note: string | null
  updatedAt: string | null
  units: Unit[]
  screens: Array<{ seq: number; header: string | null; files: string[] }>
}

function readBooks(): BookView[] {
  if (!existsSync(CACHE_ROOT)) return []
  const out: BookView[] = []
  for (const id of readdirSync(CACHE_ROOT)) {
    const dir = join(CACHE_ROOT, id)
    const metaPath = join(dir, 'meta.json')
    if (!existsSync(metaPath)) continue
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
    const pngs = readdirSync(dir).filter((f) => f.endsWith('.png'))
    const bytes = pngs.reduce((n, f) => n + statSync(join(dir, f)).size, 0)

    const screens: BookView['screens'] = (meta.screens ?? []).map(
      (s: { seq: number; header: string | null; files: string[] }) => ({
        seq: s.seq,
        header: s.header ?? null,
        files: s.files.map((f) => pathToFileURL(join(dir, f)).href),
      }),
    )

    // Consecutive screens sharing a header form one unit.
    const units: Unit[] = []
    for (const s of screens) {
      const h = s.header ?? '（无页眉）'
      const last = units[units.length - 1]
      if (last && last.header === h) last.screens++
      else units.push({ header: h, screens: 1, firstSeq: s.seq })
    }

    out.push({
      id,
      title: meta.title ?? id,
      legacy: (meta.version ?? 1) < 2,
      chapters: meta.chapters?.length ?? 0,
      screenCount: screens.length,
      pngs: pngs.length,
      bytes,
      outcome: meta.outcome ?? null,
      note: meta.note ?? null,
      updatedAt: meta.updatedAt ?? null,
      units,
      screens,
    })
  }
  return out.sort((a, b) => b.screenCount - a.screenCount)
}

const books = readBooks()
const totals = {
  books: books.length,
  screens: books.reduce((n, b) => n + b.screenCount, 0),
  pages: books.reduce((n, b) => n + b.pngs, 0),
  bytes: books.reduce((n, b) => n + b.bytes, 0),
}

const html = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PROTOTYPE · weread-export dashboard</title>
<style>
  /* Tokens from the data-viz reference palette. Sequential blue carries every
     magnitude; the four status colours are reserved and always ship with an
     icon + label, never colour alone. No categorical palette is used. */
  :root {
    --plane: #f9f9f7;  --surface: #fcfcfb;
    --ink: #0b0b0b;    --ink-2: #52514e;  --ink-muted: #898781;
    --grid: #e1e0d9;   --axis: #c3c2b7;   --ring: rgba(11,11,11,0.10);
    --seq-100: #cde2fb; --seq-250: #86b6ef; --seq-400: #3987e5;
    --seq-450: #2a78d6; --seq-550: #1c5cab; --seq-700: #0d366b;
    --good: #0ca30c; --warning: #fab219; --serious: #ec835a; --critical: #d03b3b;
    color-scheme: light;
  }
  @media (prefers-color-scheme: dark) {
    :root:where(:not([data-theme="light"])) {
      --plane: #0d0d0d; --surface: #1a1a19;
      --ink: #fff; --ink-2: #c3c2b7; --ink-muted: #898781;
      --grid: #2c2c2a; --axis: #383835; --ring: rgba(255,255,255,0.10);
      --seq-450: #3987e5; --seq-550: #256abf;
      color-scheme: dark;
    }
  }
  :root[data-theme="dark"] {
    --plane: #0d0d0d; --surface: #1a1a19;
    --ink: #fff; --ink-2: #c3c2b7; --grid: #2c2c2a; --axis: #383835;
    --ring: rgba(255,255,255,0.10); --seq-450: #3987e5; --seq-550: #256abf;
    color-scheme: dark;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0 0 96px;
    background: var(--plane); color: var(--ink);
    font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
    font-variant-numeric: tabular-nums;
  }
  .proto-banner {
    background: repeating-linear-gradient(45deg, #fab219 0 12px, #e8a413 12px 24px);
    color: #1a1a19; font-size: 12px; font-weight: 600; letter-spacing: .04em;
    padding: 6px 20px;
  }
  header.page { padding: 24px 24px 8px; }
  header.page h1 { margin: 0; font-size: 17px; font-weight: 650; letter-spacing: -.01em; }
  header.page p { margin: 4px 0 0; color: var(--ink-2); font-size: 12.5px; }
  main { padding: 16px 24px; }
  .card {
    background: var(--surface); border: 1px solid var(--ring);
    border-radius: 10px; padding: 16px 18px; margin-bottom: 14px;
  }
  .card > h2 {
    margin: 0 0 12px; font-size: 12px; font-weight: 650; letter-spacing: .06em;
    text-transform: uppercase; color: var(--ink-muted);
  }
  .muted { color: var(--ink-muted); }
  .sec { color: var(--ink-2); }

  /* ---- stat tiles / hero ---- */
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px,1fr)); gap: 1px; background: var(--ring); border-radius: 10px; overflow: hidden; }
  .kpi { background: var(--surface); padding: 14px 16px; }
  .kpi .k { font-size: 11.5px; color: var(--ink-muted); letter-spacing: .04em; }
  .kpi .v { font-size: 26px; font-weight: 620; letter-spacing: -.02em; margin-top: 2px; }
  .kpi .u { font-size: 12px; color: var(--ink-2); font-weight: 400; margin-left: 3px; }
  .hero { font-size: 54px; font-weight: 630; letter-spacing: -.03em; line-height: 1; }

  /* ---- status chip: icon + label, never colour alone ---- */
  .chip { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 550; white-space: nowrap; }
  .chip .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .chip.good .dot { background: var(--good); }
  .chip.warning .dot { background: var(--warning); }
  .chip.critical .dot { background: var(--critical); }

  /* ---- meter: single ratio against a limit, same-ramp track ---- */
  .meter { height: 8px; background: var(--seq-100); border-radius: 4px; overflow: hidden; }
  .meter > i { display: block; height: 100%; background: var(--seq-450); border-radius: 4px; }

  /* ---- tables ---- */
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; font-size: 11px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; color: var(--ink-muted); padding: 0 10px 8px 0; border-bottom: 1px solid var(--grid); }
  td { padding: 11px 10px 11px 0; border-bottom: 1px solid var(--grid); vertical-align: middle; }
  tr:last-child td { border-bottom: 0; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  code { background: var(--plane); border: 1px solid var(--ring); border-radius: 4px; padding: 1.5px 5px; font-size: 12px; }

  /* ---- horizontal bar (magnitude, one hue) ---- */
  .bars { display: grid; gap: 7px; }
  .bar-row { display: grid; grid-template-columns: 190px 1fr 62px; gap: 10px; align-items: center; font-size: 12.5px; }
  .bar-row .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink-2); }
  .track { background: var(--plane); border-radius: 3px; height: 14px; position: relative; }
  .track > i { position: absolute; inset: 0 auto 0 0; background: var(--seq-450); border-radius: 0 4px 4px 0; }
  .bar-row .val { text-align: right; color: var(--ink-2); }

  /* ---- contact sheet ---- */
  .sheet { display: grid; grid-template-columns: repeat(auto-fill, minmax(132px,1fr)); gap: 12px; }
  .shot { background: var(--plane); border: 1px solid var(--ring); border-radius: 6px; overflow: hidden; }
  .shot img { display: block; width: 100%; height: auto; background: #fff; }
  .shot .cap { font-size: 10.5px; color: var(--ink-muted); padding: 5px 6px; display: flex; justify-content: space-between; gap: 6px; }
  .shot .cap b { font-weight: 600; color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* Unit starts are marked on the thumbnail itself. A full-width heading row
     per unit was tried first and wasted most of the grid — most units are only
     two screens, so every one of them broke the flow after two columns. */
  .shot.unit-start { border-left: 3px solid var(--seq-550); }
  .shot .unit-tag { font-size: 10.5px; font-weight: 600; color: var(--seq-550); padding: 4px 6px 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tabs { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 14px; }
  .tab { font: inherit; font-size: 12.5px; padding: 6px 11px; border-radius: 999px; border: 1px solid var(--ring); background: var(--surface); color: var(--ink-2); cursor: pointer; }
  .tab[aria-current="true"] { background: var(--seq-450); border-color: var(--seq-450); color: #fff; font-weight: 550; }

  /* ---- filmstrip ---- */
  .strip { display: flex; gap: 2px; align-items: flex-end; flex-wrap: wrap; }
  .tick { width: 9px; height: 30px; border-radius: 2px 2px 0 0; background: var(--seq-450); position: relative; }
  .tick.alt { background: var(--seq-250); }
  .tick[data-first="1"] { box-shadow: inset 2px 0 0 var(--seq-700); }
  .lane { display: flex; gap: 2px; flex-wrap: wrap; margin-top: 4px; }
  .legend { display: flex; gap: 14px; font-size: 12px; color: var(--ink-2); margin-bottom: 10px; align-items: center; }
  .legend .sw { width: 10px; height: 10px; border-radius: 2px; display: inline-block; margin-right: 5px; vertical-align: -1px; }

  /* ---- variant D: a full-width detail row under each book's table row ----
     One <tbody> per book groups the row and its strip, so the hairline falls
     between books rather than between a row and its own detail. */
  table.with-detail tbody { border-bottom: 1px solid var(--grid); }
  table.with-detail tbody:last-child { border-bottom: 0; }
  table.with-detail tbody td { border-bottom: 0; }
  tr.detail td { padding: 2px 0 18px; }
  .strip--compact .tick { width: 7px; height: 22px; }

  /* ---- tooltip ---- */
  #tip { position: fixed; z-index: 60; pointer-events: none; opacity: 0; transition: opacity .1s;
    background: var(--ink); color: var(--plane); font-size: 12px; padding: 6px 9px; border-radius: 6px;
    max-width: 260px; box-shadow: 0 4px 14px rgba(0,0,0,.22); }

  /* ---- prototype switcher: deliberately unlike the design being judged ---- */
  #switcher {
    position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%); z-index: 100;
    display: flex; align-items: center; gap: 2px; padding: 5px;
    background: #0b0b0b; color: #fff; border-radius: 999px;
    box-shadow: 0 6px 24px rgba(0,0,0,.32); font-size: 13px;
  }
  #switcher button { font: inherit; background: transparent; border: 0; color: #fff; cursor: pointer; padding: 6px 12px; border-radius: 999px; }
  #switcher button:hover { background: rgba(255,255,255,.14); }
  #switcher .label { padding: 0 12px; font-weight: 550; white-space: nowrap; }
  #switcher .label span { color: #9a9a94; font-weight: 400; }
</style>

<div class="proto-banner">PROTOTYPE — 一次性代码，用完请删。数据来自 ~/.cache/weread-export，只读。</div>
<header class="page">
  <h1>weread-export · 导出状况</h1>
  <p class="sec">同一份数据的三种结构。用底部横条或 ← → 切换。</p>
</header>
<main id="app"></main>

<div id="tip" role="status"></div>
<div id="switcher"></div>

<script>
const DATA = ${JSON.stringify({ books, totals, thumbCap: THUMB_CAP })};
const VARIANTS = [
  { key: 'D', name: '表格 + 条带（选中）' },
  { key: 'A', name: '运维台' },
  { key: 'B', name: '质检台' },
  { key: 'C', name: '结构带' },
];

const fmt = (n) => n.toLocaleString('zh-CN');
const mb = (b) => (b / 1048576).toFixed(1);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
const when = (iso) => iso ? new Date(iso).toLocaleString('zh-CN', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '—';

// Status wears an icon + a word. Colour never carries the meaning by itself.
function chip(book) {
  if (book.legacy) return '<span class="chip warning"><i class="dot"></i>⚠ 旧格式缓存，已失效</span>';
  if (book.outcome === 'complete') return '<span class="chip good"><i class="dot"></i>✓ 已抓完</span>';
  if (book.outcome === 'unauthorized') return '<span class="chip critical"><i class="dot"></i>✕ 未授权，被截断</span>';
  if (book.outcome === 'interrupted') return '<span class="chip warning"><i class="dot"></i>⚠ 未抓完</span>';
  return '<span class="chip"><i class="dot" style="background:var(--axis)"></i>· 未知</span>';
}
const coverage = (b) => (b.chapters ? Math.min(1, b.units.length / b.chapters) : 0);

/* ================= Variant A — 运维台 =================
   Leads with a hero figure and a KPI row, then one row per book: status,
   coverage meter, size. Primary affordance: see what is unfinished and what
   command fixes it. Table-driven, so it doubles as the accessible table view. */
function VariantA() {
  const { books, totals } = DATA;
  const problems = books.filter((b) => b.legacy || b.outcome !== 'complete');
  return \`
  <div class="card">
    <h2>缓存总量</h2>
    <div style="display:flex;align-items:flex-end;gap:28px;flex-wrap:wrap">
      <div>
        <div class="hero">\${mb(totals.bytes)}<span class="u" style="font-size:20px">MB</span></div>
        <div class="muted" style="font-size:12px;margin-top:4px">\${fmt(totals.pages)} 张页图 · \${fmt(totals.screens)} 屏</div>
      </div>
      <div class="kpis" style="flex:1;min-width:280px">
        <div class="kpi"><div class="k">书</div><div class="v">\${totals.books}</div></div>
        <div class="kpi"><div class="k">已抓屏数</div><div class="v">\${fmt(totals.screens)}</div></div>
        <div class="kpi"><div class="k">PDF 页数</div><div class="v">\${fmt(totals.pages)}</div></div>
        <div class="kpi"><div class="k">平均每页</div><div class="v">\${totals.pages ? (totals.bytes/totals.pages/1024).toFixed(0) : 0}<span class="u">KB</span></div></div>
      </div>
    </div>
  </div>

  <div class="card">
    <h2>逐本状况</h2>
    <table>
      <thead><tr>
        <th>书</th><th>状态</th><th style="width:200px">已覆盖单元</th>
        <th class="num">屏</th><th class="num">页图</th><th class="num">体积</th><th>更新</th>
      </tr></thead>
      <tbody>\${books.map((b) => \`
        <tr>
          <td><b>\${esc(b.title)}</b><div class="muted" style="font-size:11px">\${esc(b.id)}</div></td>
          <td>\${chip(b)}\${b.note ? \`<div class="muted" style="font-size:11px">\${esc(b.note)}</div>\` : ''}</td>
          <td>
            <div class="meter" data-tip="\${b.units.length} / \${b.chapters} 个目录单元出现过"><i style="width:\${(coverage(b)*100).toFixed(1)}%"></i></div>
            <div class="muted" style="font-size:11px;margin-top:3px">\${b.units.length} / \${b.chapters} 单元（\${(coverage(b)*100).toFixed(0)}%）</div>
          </td>
          <td class="num">\${fmt(b.screenCount)}</td>
          <td class="num">\${fmt(b.pngs)}</td>
          <td class="num">\${mb(b.bytes)} MB</td>
          <td class="sec" style="font-size:12px">\${when(b.updatedAt)}</td>
        </tr>\`).join('')}
      </tbody>
    </table>
  </div>

  \${problems.length ? \`<div class="card">
    <h2>需要处理 · \${problems.length}</h2>
    \${problems.map((b) => \`<div style="display:flex;gap:12px;align-items:baseline;padding:9px 0;border-bottom:1px solid var(--grid)">
      <div style="flex:1"><b>\${esc(b.title)}</b> \${chip(b)}</div>
      <code>\${b.legacy ? 'weread-export ' + esc(b.title.slice(0,4)) + ' --force' : 'weread-export ' + esc(b.title.slice(0,4))}</code>
    </div>\`).join('')}
    <p class="muted" style="font-size:12px;margin:10px 0 0">未抓完的书重跑同一命令会续抓；旧格式缓存必须 <code>--force</code> 重来。</p>
  </div>\` : ''}\`;
}

/* ================= Variant B — 质检台 =================
   The pages themselves dominate. Nothing here is a chart: the question this
   variant answers is "do the captures look right" — dark pages, blank pages,
   duplicated seams — which only pixels can answer. */
function VariantB() {
  const usable = DATA.books.filter((b) => b.screens.length);
  const which = Number(new URLSearchParams(location.search).get('book') ?? 0);
  const book = usable[Math.min(which, usable.length - 1)];
  if (!book) return '<div class="card">还没有任何缓存页面。先跑一次 <code>weread-export &lt;书名&gt;</code>。</div>';

  const flat = [];
  let lastHeader = null;
  for (const s of book.screens) {
    const isNew = s.header !== lastHeader;
    lastHeader = s.header;
    for (const [i, f] of s.files.entries()) {
      flat.push({ img: f, seq: s.seq, col: i, header: s.header, unitStart: isNew && i === 0 });
    }
  }
  const total = flat.length;
  const shown = Math.min(total, DATA.thumbCap);

  let html = \`<div class="tabs">\${usable.map((b, i) => \`
    <button class="tab" aria-current="\${b.id === book.id}" onclick="pick(\${i})">\${esc(b.title)} <span class="muted">\${b.pngs}</span></button>\`).join('')}</div>
  <div class="card">
    <h2>\${esc(book.title)} · 抓到的页面</h2>
    <p class="sec" style="margin:-4px 0 14px;font-size:12.5px">
      按阅读顺序连续排列，左侧蓝条＝换单元。显示前 \${shown} / \${total} 张\${total > shown ? '（其余已略去，避免一次加载几百 MB）' : ''}。
    </p>
    <div class="sheet">\`;
  for (const x of flat.slice(0, DATA.thumbCap)) {
    html += \`<figure class="shot\${x.unitStart ? ' unit-start' : ''}" style="margin:0">
      \${x.unitStart ? \`<div class="unit-tag" title="\${esc(x.header ?? '')}">\${esc(x.header ?? '（无页眉）')}</div>\` : ''}
      <img src="\${x.img}" loading="lazy" alt="第 \${x.seq} 屏 第 \${x.col + 1} 栏">
      <figcaption class="cap"><b>\${esc(x.header ?? '')}</b><span>\${x.seq}·\${x.col ? '右' : '左'}</span></figcaption>
    </figure>\`;
  }
  return html + '</div></div>';
}

/* ================= Variant C — 结构带 =================
   Reading order as one continuous strip, shaded in alternating steps of the
   same blue ramp so unit boundaries read without a categorical palette. Then
   the magnitude question — how many screens each unit got — as a one-hue bar
   chart, plus the table view. */
function VariantC() {
  const usable = DATA.books.filter((b) => b.screens.length);
  if (!usable.length) return '<div class="card">还没有任何缓存页面。</div>';

  return usable.map((book) => {
    const max = Math.max(...book.units.map((u) => u.screens));
    let alt = false, seen = null;
    const ticks = book.screens.map((s) => {
      if (s.header !== seen) { alt = !alt; seen = s.header; return { s, alt, first: 1 }; }
      return { s, alt, first: 0 };
    });
    const top = [...book.units].sort((a, b) => b.screens - a.screens).slice(0, 12);
    return \`
    <div class="card">
      <h2>\${esc(book.title)} · 阅读顺序</h2>
      <div class="legend">
        <span><i class="sw" style="background:var(--seq-450)"></i>一屏（深浅交替＝换单元）</span>
        <span><i class="sw" style="background:var(--seq-250)"></i></span>
        <span class="muted">共 \${book.screenCount} 屏 · \${book.units.length} 个单元 · \${chip(book)}</span>
      </div>
      <div class="strip">\${ticks.map((t) => \`<i class="tick\${t.alt ? ' alt' : ''}" data-first="\${t.first}"
          data-tip="第 \${t.s.seq} 屏 · \${esc(t.s.header ?? '（无页眉）')} · \${t.s.files.length} 栏"></i>\`).join('')}</div>
      <p class="muted" style="font-size:12px;margin:12px 0 0">
        连续无缺口 = 线性走法没有漏页。目录共 \${book.chapters} 项，已出现 \${book.units.length} 个。
      </p>
    </div>

    <div class="card">
      <h2>每个单元抓了多少屏 · 前 12</h2>
      <div class="bars">\${top.map((u) => \`
        <div class="bar-row">
          <span class="name" title="\${esc(u.header)}">\${esc(u.header)}</span>
          <span class="track" data-tip="\${esc(u.header)} · \${u.screens} 屏 · 从第 \${u.firstSeq} 屏起"><i style="width:\${(u.screens / max * 100).toFixed(1)}%"></i></span>
          <span class="val">\${u.screens}</span>
        </div>\`).join('')}</div>
      <details style="margin-top:14px">
        <summary class="sec" style="cursor:pointer;font-size:12.5px">全部单元（表格视图）</summary>
        <table style="margin-top:10px">
          <thead><tr><th>单元</th><th class="num">屏</th><th class="num">起始屏</th></tr></thead>
          <tbody>\${book.units.map((u) => \`<tr><td>\${esc(u.header)}</td><td class="num">\${u.screens}</td><td class="num">\${u.firstSeq}</td></tr>\`).join('')}</tbody>
        </table>
      </details>
    </div>\`;
  }).join('');
}

/* ================= Variant D — A 的表格 + C 的条带 =================
   The picked combination. A's hero + KPI row + scannable cross-book table is
   kept intact; each book row is followed by a full-width detail row carrying
   that book's filmstrip, so coverage is readable as both a number (meter) and a
   structure (continuity, where units change). C's per-unit bars stay, folded
   into a <details> so the table remains the thing you scan first. */
function VariantD() {
  const { books, totals } = DATA;
  const problems = books.filter((b) => b.legacy || b.outcome !== 'complete');

  const strip = (book) => {
    if (!book.screens.length) {
      return '<p class="muted" style="font-size:12px;margin:0">没有可用的屏缓存' + (book.legacy ? '（旧格式，需 --force 重抓）' : '') + '。</p>';
    }
    let alt = false, seen = null;
    const ticks = book.screens.map((s) => {
      if (s.header !== seen) { alt = !alt; seen = s.header; return { s, alt, first: 1 }; }
      return { s, alt, first: 0 };
    });
    const max = Math.max(...book.units.map((u) => u.screens));
    const top = [...book.units].sort((a, b) => b.screens - a.screens).slice(0, 8);
    return \`
      <div class="legend" style="margin-bottom:7px">
        <span><i class="sw" style="background:var(--seq-450)"></i><i class="sw" style="background:var(--seq-250)"></i>一屏，深浅交替＝换单元</span>
        <span class="muted">连续无缺口 = 没有漏页</span>
      </div>
      <div class="strip strip--compact">\${ticks.map((t) => \`<i class="tick\${t.alt ? ' alt' : ''}" data-first="\${t.first}"
        data-tip="第 \${t.s.seq} 屏 · \${esc(t.s.header ?? '（无页眉）')} · \${t.s.files.length} 栏"></i>\`).join('')}</div>
      <details style="margin-top:12px">
        <summary class="sec" style="cursor:pointer;font-size:12.5px">每个单元抓了多少屏 · 前 8 与完整表格</summary>
        <div class="bars" style="margin-top:10px">\${top.map((u) => \`
          <div class="bar-row">
            <span class="name" title="\${esc(u.header)}">\${esc(u.header)}</span>
            <span class="track" data-tip="\${esc(u.header)} · \${u.screens} 屏 · 从第 \${u.firstSeq} 屏起"><i style="width:\${(u.screens / max * 100).toFixed(1)}%"></i></span>
            <span class="val">\${u.screens}</span>
          </div>\`).join('')}</div>
        <table style="margin-top:12px">
          <thead><tr><th>单元</th><th class="num">屏</th><th class="num">起始屏</th></tr></thead>
          <tbody>\${book.units.map((u) => \`<tr><td>\${esc(u.header)}</td><td class="num">\${u.screens}</td><td class="num">\${u.firstSeq}</td></tr>\`).join('')}</tbody>
        </table>
      </details>\`;
  };

  return \`
  <div class="card">
    <h2>缓存总量</h2>
    <div style="display:flex;align-items:flex-end;gap:28px;flex-wrap:wrap">
      <div>
        <div class="hero">\${mb(totals.bytes)}<span class="u" style="font-size:20px">MB</span></div>
        <div class="muted" style="font-size:12px;margin-top:4px">\${fmt(totals.pages)} 张页图 · \${fmt(totals.screens)} 屏</div>
      </div>
      <div class="kpis" style="flex:1;min-width:280px">
        <div class="kpi"><div class="k">书</div><div class="v">\${totals.books}</div></div>
        <div class="kpi"><div class="k">已抓屏数</div><div class="v">\${fmt(totals.screens)}</div></div>
        <div class="kpi"><div class="k">PDF 页数</div><div class="v">\${fmt(totals.pages)}</div></div>
        <div class="kpi"><div class="k">平均每页</div><div class="v">\${totals.pages ? (totals.bytes/totals.pages/1024).toFixed(0) : 0}<span class="u">KB</span></div></div>
      </div>
    </div>
  </div>

  <div class="card">
    <h2>逐本状况</h2>
    <table class="with-detail">
      <thead><tr>
        <th>书</th><th>状态</th><th style="width:180px">已覆盖单元</th>
        <th class="num">屏</th><th class="num">页图</th><th class="num">体积</th><th>更新</th>
      </tr></thead>
      \${books.map((b) => \`<tbody>
        <tr>
          <td><b>\${esc(b.title)}</b><div class="muted" style="font-size:11px">\${esc(b.id)}</div></td>
          <td>\${chip(b)}\${b.note ? \`<div class="muted" style="font-size:11px">\${esc(b.note)}</div>\` : ''}</td>
          <td>
            <div class="meter" data-tip="\${b.units.length} / \${b.chapters} 个目录单元出现过"><i style="width:\${(coverage(b)*100).toFixed(1)}%"></i></div>
            <div class="muted" style="font-size:11px;margin-top:3px">\${b.units.length} / \${b.chapters}（\${(coverage(b)*100).toFixed(0)}%）</div>
          </td>
          <td class="num">\${fmt(b.screenCount)}</td>
          <td class="num">\${fmt(b.pngs)}</td>
          <td class="num">\${mb(b.bytes)} MB</td>
          <td class="sec" style="font-size:12px">\${when(b.updatedAt)}</td>
        </tr>
        <tr class="detail"><td colspan="7">\${strip(b)}</td></tr>
      </tbody>\`).join('')}
    </table>
  </div>

  \${problems.length ? \`<div class="card">
    <h2>需要处理 · \${problems.length}</h2>
    \${problems.map((b) => \`<div style="display:flex;gap:12px;align-items:baseline;padding:9px 0;border-bottom:1px solid var(--grid)">
      <div style="flex:1"><b>\${esc(b.title)}</b> \${chip(b)}</div>
      <code>weread-export \${esc(b.title.slice(0,4))}\${b.legacy ? ' --force' : ''}</code>
    </div>\`).join('')}
    <p class="muted" style="font-size:12px;margin:10px 0 0">未抓完的书重跑同一命令会续抓；旧格式缓存必须 <code>--force</code> 重来。</p>
  </div>\` : ''}\`;
}

const RENDER = { D: VariantD, A: VariantA, B: VariantB, C: VariantC };

function currentVariant() {
  const v = (new URLSearchParams(location.search).get('variant') ?? 'D').toUpperCase();
  return RENDER[v] ? v : 'D';
}
function go(key) {
  const p = new URLSearchParams(location.search);
  p.set('variant', key); p.delete('book');
  history.replaceState(null, '', location.pathname + '?' + p);
  draw();
}
function pick(i) {
  const p = new URLSearchParams(location.search);
  p.set('book', String(i));
  history.replaceState(null, '', location.pathname + '?' + p);
  draw();
}
function draw() {
  const key = currentVariant();
  document.getElementById('app').innerHTML = RENDER[key]();
  const cur = VARIANTS.findIndex((v) => v.key === key);
  const prev = VARIANTS[(cur - 1 + VARIANTS.length) % VARIANTS.length].key;
  const next = VARIANTS[(cur + 1) % VARIANTS.length].key;
  document.getElementById('switcher').innerHTML =
    '<button onclick="go(\\'' + prev + '\\')" aria-label="上一个方案">←</button>' +
    '<span class="label">' + key + ' <span>' + VARIANTS[cur].name + '</span></span>' +
    '<button onclick="go(\\'' + next + '\\')" aria-label="下一个方案">→</button>';
}

// Hover layer: every mark that encodes a value gets a tooltip.
const tip = document.getElementById('tip');
addEventListener('mousemove', (e) => {
  const el = e.target.closest('[data-tip]');
  if (!el) { tip.style.opacity = 0; return; }
  tip.textContent = el.dataset.tip;
  tip.style.opacity = 1;
  tip.style.left = Math.min(e.clientX + 14, innerWidth - 275) + 'px';
  tip.style.top = (e.clientY + 18) + 'px';
});

addEventListener('keydown', (e) => {
  if (/^(INPUT|TEXTAREA)$/.test(e.target.tagName) || e.target.isContentEditable) return;
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const cur = VARIANTS.findIndex((v) => v.key === currentVariant());
  const d = e.key === 'ArrowRight' ? 1 : -1;
  go(VARIANTS[(cur + d + VARIANTS.length) % VARIANTS.length].key);
});

draw();
</script>
`

mkdirSync('out', { recursive: true })
writeFileSync(OUT, html)

console.log(`\n  PROTOTYPE dashboard written`)
console.log(`  书 ${totals.books} · 屏 ${totals.screens} · 页图 ${totals.pages} · ${(totals.bytes / 1048576).toFixed(1)} MB`)
for (const b of books) {
  console.log(
    `    · ${b.title} — ${b.legacy ? '旧格式' : `${b.screenCount} 屏 / ${b.units.length}/${b.chapters} 单元 / ${(b.bytes / 1048576).toFixed(1)}MB / ${b.outcome}`}`,
  )
}
console.log(`\n  ${pathToFileURL(join(process.cwd(), OUT)).href}`)
console.log(`  变体：?variant=D 表格+条带（默认）· A 运维台 · B 质检台 · C 结构带（底部横条或 ← →）\n`)
