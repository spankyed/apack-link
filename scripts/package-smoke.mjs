// The package as a consumer gets it: packed, installed into a project of its own, each entry imported by its name,
// consumer TypeScript checks under Node16/Bundler/DOM/WebWorker with zero @types/node, and the README's example run there.
// Removes what it made either way.
//
//   node scripts/package-smoke.mjs [tarball]   (without one, packs this checkout: `prepack` builds dist/ first)
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const run = (args, cwd) => execFileSync(npm, process.platform === 'win32' ? args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)) : args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], shell: process.platform === 'win32' })
const consumer = fs.mkdtempSync(path.join(os.tmpdir(), 'apack-link-consumer-'))
try {
  let tarball = process.argv[2] && path.resolve(process.argv[2])
  if (!tarball) {
    const [packed] = JSON.parse(run(['pack', '--json', '--pack-destination', consumer], ROOT))
    tarball = path.join(consumer, packed.filename)
  }
  if (!fs.existsSync(tarball)) throw new Error(`No tarball at ${tarball}`)
  fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }))
  run(['install', '--no-audit', '--no-fund', '--no-package-lock', tarball], consumer)

  // 1. Runtime check: each entry loads by its exported name.
  fs.writeFileSync(path.join(consumer, 'entries.mjs'), `
import * as link from '@apackdev/link'
import * as testing from '@apackdev/link/testing'
for (const name of ['join', 'dial', 'listen', 'accept', 'socket', 'port', 'stream', 'memoryPair', 'json']) if (typeof link[name] === 'undefined') throw new Error('@apackdev/link has no ' + name)
for (const name of ['scheduledPair', 'memoryEnds', 'peers', 'hold', 'model', 'trackedLater']) if (typeof testing[name] === 'undefined') throw new Error('@apackdev/link/testing has no ' + name)
`)
  execFileSync(process.execPath, ['entries.mjs'], { cwd: consumer, stdio: 'inherit' })

  // 2. Consumer TypeScript checks: verify clean .d.ts resolution without @types/node or @types/ws.
  const tscBin = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
  fs.writeFileSync(path.join(consumer, 'browser-check.ts'), `
import { dial, join, listen, memoryPair, port, socket, timers, type HoldStall, type JoinOptions, type Prepared } from '@apackdev/link'

const [left, right] = memoryPair()
const a = dial(left, { bound: { kept: { frames: 64 }, waiting: { size: 1024 * 1024 } } })
const p: Prepared = a.prepare({ kind: 'tell', to: 'x', event: 1 }, { cause: 'c' })
const size: number = p.size
void size
a.send(p)
a.send({ kind: 'tell', to: 'x', event: 2 }, { private: true })
const opts: JoinOptions = { bound: { frames: 100 }, onStall: (s: HoldStall) => { void s.views } }
join(listen(right), { tell: () => {}, ask: () => () => {}, follow: () => ({ stop: () => {} }) }, opts)
void (() => {
  const ch = new MessageChannel()
  dial(port(ch.port1))
  dial(() => socket(new WebSocket('wss://example.invalid')), { reopen: { clock: timers } })
})
`)
  fs.writeFileSync(path.join(consumer, 'tsconfig.dom.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'Node16',
      moduleResolution: 'Node16',
      lib: ['ES2023', 'DOM'],
      types: [],
      strict: true,
      noEmit: true,
      skipLibCheck: false,
    },
    files: ['browser-check.ts'],
  }))
  execFileSync(process.execPath, [tscBin, '-p', 'tsconfig.dom.json'], { cwd: consumer, stdio: 'inherit' })

  fs.writeFileSync(path.join(consumer, 'tsconfig.worker.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      lib: ['ES2023', 'WebWorker'],
      types: [],
      strict: true,
      noEmit: true,
      skipLibCheck: false,
    },
    files: ['browser-check.ts'],
  }))
  execFileSync(process.execPath, [tscBin, '-p', 'tsconfig.worker.json'], { cwd: consumer, stdio: 'inherit' })

  // 3. Testing subpath TypeScript check with @apackdev/orderings linked from the repo's devDependencies.
  const orderingsSrc = path.join(ROOT, 'node_modules', '@apackdev', 'orderings')
  if (fs.existsSync(orderingsSrc)) {
    fs.symlinkSync(orderingsSrc, path.join(consumer, 'node_modules', '@apackdev', 'orderings'), 'junction')
    fs.writeFileSync(path.join(consumer, 'testing-check.ts'), `
import { dial, listen } from '@apackdev/link'
import { laneClock, memoryEnds, scheduledPair, trackedJoin, trackedLater, trackedLink } from '@apackdev/link/testing'
import { everyOrder } from '@apackdev/orderings'

void everyOrder((schedule) => {
  const resA = schedule.resource('a')
  const resB = schedule.resource('b')
  const [l, r] = scheduledPair(schedule, ['a', 'b'], { tracked: true, resources: [resA, resB] })
  const clock = laneClock(schedule, { label: 'c' }, { resource: resA })
  const a = trackedLink(dial(l, { later: trackedLater(schedule, { label: 'la' }, resA), there: { window: 10, clock } }), schedule, resA)
  const b = trackedLink(listen(r), schedule, resB)
  trackedJoin(a, { tell: () => {}, ask: () => () => {}, follow: () => ({ stop: () => {} }) }, schedule, resA, { bound: { frames: 8 } })
  void b
  void memoryEnds(schedule, { tracked: true })
  return () => {}
})
`)
    fs.writeFileSync(path.join(consumer, 'tsconfig.testing.json'), JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'Node16',
        moduleResolution: 'Node16',
        lib: ['ES2023', 'DOM'],
        types: [],
        strict: true,
        noEmit: true,
        skipLibCheck: false,
      },
      files: ['testing-check.ts'],
    }))
    execFileSync(process.execPath, [tscBin, '-p', 'tsconfig.testing.json'], { cwd: consumer, stdio: 'inherit' })
  }

  // 4. The README's first example, as it is written there, run with its types stripped: it logs how its ask ended.
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').replace(/\r\n/g, '\n')
  const example = /```ts\n([\s\S]*?)```/.exec(readme)?.[1]
  if (!example) throw new Error('The README has no ts example')
  fs.writeFileSync(path.join(consumer, 'example.mts'), example)
  const logged = execFileSync(process.execPath, ['example.mts'], { cwd: consumer, encoding: 'utf8' })
  if (!/ok: true/.test(logged) || !/THR-1/.test(logged)) throw new Error(`The README example logged ${logged}`)
  console.log(`each entry loaded, consumer types verified (Node16+DOM, Bundler+WebWorker, testing), and the README example ran: ${logged.trim()}`)
} finally {
  fs.rmSync(consumer, { recursive: true, force: true })
}
