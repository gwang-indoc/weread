/**
 * WeRead session: QR login, persistence, expiry detection.
 *
 * WeRead's wr_skey rotates every few days, so expiry is a normal event rather
 * than an error — commands should detect it and ask for a fresh login.
 */
import { chromium, type Browser, type BrowserContext } from 'playwright-core'
import { mkdir, chmod } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

export const SESSION_PATH = join(homedir(), '.config', 'weread-export', 'session.json')
export const SHELF_URL = 'https://weread.qq.com/web/shelf'
const HOME_URL = 'https://weread.qq.com/'

export interface OpenOptions {
  /** Show the browser window. Required for QR login; useful when debugging. */
  headed?: boolean
  /**
   * Capture resolution multiplier. Book text is painted to canvas, so this is
   * what determines how legible the exported pages are; 3 keeps CJK glyphs
   * crisp at A5 without inflating files unreasonably.
   */
  deviceScaleFactor?: number
}

export interface Opened {
  browser: Browser
  ctx: BrowserContext
}

export function hasSession(): boolean {
  return existsSync(SESSION_PATH)
}

export class NoBrowserError extends Error {
  constructor(attempts: string[]) {
    super(
      [
        '找不到可用的浏览器。',
        '',
        '本工具依赖 playwright-core，不会自己下载浏览器，请任选一种：',
        '  · 安装 Google Chrome 或 Microsoft Edge（推荐，装好即可直接使用）',
        '  · 或下载 Playwright 自带的 Chromium：npx playwright install chromium',
        '',
        '尝试过的启动方式：',
        ...attempts.map((a) => `  · ${a}`),
      ].join('\n'),
    )
    this.name = 'NoBrowserError'
  }
}

/**
 * Launch a browser, preferring one already on the machine.
 *
 * playwright-core deliberately ships no browser binaries, which keeps `npx`
 * startup to seconds instead of a ~150MB download. So we reuse the user's Chrome
 * or Edge, and fall back to a Playwright-managed Chromium if they installed one.
 */
async function launchBrowser(headed: boolean): Promise<Browser> {
  const attempts: Array<[string, () => Promise<Browser>]> = [
    ['Google Chrome', () => chromium.launch({ headless: !headed, channel: 'chrome' })],
    ['Microsoft Edge', () => chromium.launch({ headless: !headed, channel: 'msedge' })],
    ['Playwright Chromium', () => chromium.launch({ headless: !headed })],
  ]
  const failures: string[] = []
  for (const [label, launch] of attempts) {
    try {
      return await launch()
    } catch (e) {
      failures.push(`${label} — ${(e as Error).message.split('\n')[0]}`)
    }
  }
  throw new NoBrowserError(failures)
}

/** A context that looks like an ordinary desktop Chrome in mainland China. */
export async function open({ headed = false, deviceScaleFactor = 3 }: OpenOptions = {}): Promise<Opened> {
  const browser = await launchBrowser(headed)
  const ctx = await browser.newContext({
    storageState: hasSession() ? SESSION_PATH : undefined,
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  })
  return { browser, ctx }
}

/** wr_vid is present and non-zero exactly when a real account is attached. */
export async function isLoggedIn(ctx: BrowserContext): Promise<boolean> {
  const cookies = await ctx.cookies('https://weread.qq.com')
  return cookies.some((c) => c.name === 'wr_vid' && !!c.value && c.value !== '0')
}

export async function save(ctx: BrowserContext): Promise<void> {
  await mkdir(dirname(SESSION_PATH), { recursive: true })
  await ctx.storageState({ path: SESSION_PATH })
  await chmod(SESSION_PATH, 0o600)
}

/**
 * Interactive QR login. Opens a real window, waits for the user to scan with
 * WeChat, then persists cookies. Returns the account's wr_vid.
 */
export async function login({ timeoutMs = 240_000 }: { timeoutMs?: number } = {}): Promise<string> {
  const { browser, ctx } = await open({ headed: true })
  try {
    const page = await ctx.newPage()
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded' })

    if (!(await isLoggedIn(ctx))) {
      console.log('\n  请用微信扫码登录（浏览器窗口已打开）')
      console.log('  Scan the QR code with WeChat. This continues automatically.\n')
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (await isLoggedIn(ctx)) break
        await page.waitForTimeout(2000)
      }
    }
    if (!(await isLoggedIn(ctx))) throw new Error('login timed out')

    await save(ctx)
    const cookies = await ctx.cookies('https://weread.qq.com')
    return cookies.find((c) => c.name === 'wr_vid')?.value ?? 'unknown'
  } finally {
    await browser.close()
  }
}

export class SessionExpiredError extends Error {
  constructor() {
    super('WeRead session expired — run `weread-export login` again')
    this.name = 'SessionExpiredError'
  }
}

/** Open a context that is known to be logged in, or fail loudly. */
export async function openAuthenticated(opts: OpenOptions = {}): Promise<Opened> {
  if (!hasSession()) throw new SessionExpiredError()
  const opened = await open(opts)
  const page = await opened.ctx.newPage()
  await page.goto(SHELF_URL, { waitUntil: 'domcontentloaded' })
  if (!(await isLoggedIn(opened.ctx))) {
    await opened.browser.close()
    throw new SessionExpiredError()
  }
  await page.close()
  return opened
}
