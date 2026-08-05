/**
 * Running the built CLI against a scratch cache.
 *
 * Everything here exists to make one guarantee: the gate cannot touch the real
 * `~/.cache/weread-export`. That cache is hours of serial capture that cannot be
 * re-fetched quickly, and CLAUDE.md's standing instruction for testing anything
 * destructive is to point a scratch `HOME` at a temp dir. This does the same
 * thing, and then checks that it worked rather than assuming it.
 *
 * The CLI is run as a child process from `dist/`, not imported. `CACHE_ROOT` and
 * `SESSION_PATH` are computed from `homedir()` at module load, so an in-process
 * import would bind them to the real home before a test could redirect anything.
 * A child process with its own `HOME` is the only way to redirect them at all —
 * and it also means the gate exercises the built artifact, argument parsing and
 * exit codes included, which is the part no unit test covers.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'

const REPO = resolve(import.meta.dirname, '../../..')
const CLI = join(REPO, 'dist', 'cli.js')

export interface RunResult {
  code: number
  stdout: string
  stderr: string
  /** stdout and stderr interleaved, for assertions that do not care which. */
  output: string
}

export class Scratch {
  home: string
  cacheRoot: string
  outDir: string

  // Plain fields and an explicit assignment, not parameter properties: the repo
  // compiles under `erasableSyntaxOnly`, so the tests have to be strippable too.
  private constructor(home: string, cacheRoot: string, outDir: string) {
    this.home = home
    this.cacheRoot = cacheRoot
    this.outDir = outDir
  }

  static async create(): Promise<Scratch> {
    if (!existsSync(CLI)) {
      throw new Error(`${CLI} is missing — the end-to-end gate runs the built CLI. Run: pnpm build`)
    }

    const home = await mkdtemp(join(tmpdir(), 'weread-e2e-'))
    const cacheRoot = join(home, '.cache', 'weread-export')

    // Belt and braces. If HOME ever stopped reaching the child, or `homedir()`
    // stopped honouring it, the commands below would run against the real cache
    // and `epub --force` would discard a real book's OCR. Refusing here is
    // cheap; noticing afterwards is not.
    const real = join(homedir(), '.cache', 'weread-export')
    if (cacheRoot === real || !cacheRoot.startsWith(home)) {
      throw new Error(`refusing to run: the scratch cache resolved to ${cacheRoot}`)
    }

    return new Scratch(home, cacheRoot, join(home, 'out'))
  }

  /**
   * Run the CLI. Never rejects on a non-zero exit — the exit code is part of
   * what the gate asserts, since an incomplete export is required to be one.
   */
  run(args: string[]): Promise<RunResult> {
    return new Promise((done, fail) => {
      const child = spawn(process.execPath, [CLI, ...args], {
        cwd: this.home,
        env: {
          ...process.env,
          HOME: this.home,
          // Chinese output is compared against literals, so the locale must not
          // be free to reinterpret the bytes.
          LANG: 'en_US.UTF-8',
          // Turns off any progress rendering that would depend on a terminal.
          CI: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d))
      child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d))
      child.on('error', fail)
      child.on('close', (code) => done({ code: code ?? 0, stdout, stderr, output: stdout + stderr }))
    })
  }

  async dispose(): Promise<void> {
    await rm(this.home, { recursive: true, force: true })
  }
}
