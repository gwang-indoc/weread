/**
 * Make the built CLI executable.
 *
 * tsc emits dist/cli.js as 644. npm normally sets the executable bit on `bin`
 * targets when it installs a packed tarball — but `npm i -g .` symlinks the
 * working directory instead of copying it, so nothing ever chmods the file and
 * the shell reports "permission denied". Every build regenerates dist/, so this
 * has to run as part of the build rather than once by hand.
 *
 * Uses node rather than chmod(1) so the build also works on Windows.
 */
import { chmodSync } from 'node:fs'

chmodSync(new URL('../dist/cli.js', import.meta.url), 0o755)
