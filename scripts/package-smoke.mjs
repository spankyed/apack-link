// The package as a consumer gets it: packed, installed into a project of its own, each entry imported by its name,
// and the README's example run there. Removes what it made either way.
//
//   node scripts/package-smoke.mjs [tarball]   (without one, packs this checkout: `prepack` builds dist/ first)
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const run = (args, cwd) => execFileSync(npm, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], shell: process.platform === 'win32' })
const consumer = fs.mkdtempSync(path.join(os.tmpdir(), 'apack-link-consumer-'))
try {
  let tarball = process.argv[2] && path.resolve(process.argv[2])
  if (!tarball) {
    const [packed] = JSON.parse(run(['pack', '--json', '--pack-destination', consumer], path.resolve(import.meta.dirname, '..')))
    tarball = path.join(consumer, packed.filename)
  }
  if (!fs.existsSync(tarball)) throw new Error(`No tarball at ${tarball}`)
  fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }))
  run(['install', '--no-audit', '--no-fund', '--no-package-lock', tarball], consumer)
  // Each entry by its name.
  fs.writeFileSync(path.join(consumer, 'entries.mjs'), `
import * as link from '@apackdev/link'
import * as testing from '@apackdev/link/testing'
for (const name of ['join', 'dial', 'listen', 'accept', 'socket', 'port', 'stream', 'memoryPair', 'json']) if (typeof link[name] === 'undefined') throw new Error('@apackdev/link has no ' + name)
for (const name of ['everyOrder', 'explore', 'scheduledPair', 'memoryEnds', 'peers', 'hold']) if (typeof testing[name] === 'undefined') throw new Error('@apackdev/link/testing has no ' + name)
`)
  execFileSync(process.execPath, ['entries.mjs'], { cwd: consumer, stdio: 'inherit' })
  // The README's first example, as it is written there, run with its types stripped: it logs how its ask ended.
  const readme = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'README.md'), 'utf8').replace(/\r\n/g, '\n')
  const example = /```ts\n([\s\S]*?)```/.exec(readme)?.[1]
  if (!example) throw new Error('The README has no ts example')
  fs.writeFileSync(path.join(consumer, 'example.mts'), example)
  const logged = execFileSync(process.execPath, ['example.mts'], { cwd: consumer, encoding: 'utf8' })
  if (!/ok: true/.test(logged) || !/THR-1/.test(logged)) throw new Error(`The README example logged ${logged}`)
  console.log(`each entry loaded, and the README example ran: ${logged.trim()}`)
} finally {
  fs.rmSync(consumer, { recursive: true, force: true })
}
