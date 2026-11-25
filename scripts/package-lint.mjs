// Lints the built package tarball with publint and @arethetypeswrong/cli (attw).
// Runs `npm pack` into a temp dir so no tarball is left in the repo root.
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apack-link-lint-'))
try {
  const [packed] = JSON.parse(execFileSync(npm, ['pack', '--json', '--pack-destination', tmp], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    shell: process.platform === 'win32',
  }))
  const tarball = path.join(tmp, packed.filename)
  const publintBin = path.join(ROOT, 'node_modules', 'publint', 'src', 'cli.js')
  const attwBin = path.join(ROOT, 'node_modules', '@arethetypeswrong', 'cli', 'dist', 'index.js')
  console.log('Running publint...')
  execFileSync(process.execPath, [publintBin, '--strict'], { cwd: ROOT, stdio: 'inherit' })
  console.log('Running attw...')
  execFileSync(process.execPath, [attwBin, tarball, '--profile', 'esm-only'], { cwd: ROOT, stdio: 'inherit' })
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
