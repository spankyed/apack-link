// The wire, held to what docs/wire.md says of it: an exchange, hello to goodbye with one of each frame and each
// thing an end says of itself, recorded as it crosses and compared text for text with the recording there. A
// change to anything an end sends fails here until the two say the same.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { expect, it } from 'vitest'
import { accept, dial, memoryPair, type Clock, type Link, type Transport } from '../src/index.ts'
import { only } from './support/only.ts'

/** Everything that crossed, in order, as `A → B  text`: the window's end is A and the backend's B. */
const crossed: string[] = []
const recorded = (transport: Transport, from: string, to: string): Transport => ({
  ...transport,
  send: (message) => { crossed.push(`${from} → ${to}  ${message as string}`); transport.send(message) },
})

/** A clock turned by hand: what is due runs when the spec says the time has come. */
const due: Array<() => void> = []
const clock: Clock = { after: (_ms, run) => { due.push(run); return () => { due.splice(due.indexOf(run) >>> 0, 1) } } }
const tick = (): void => { for (const run of due.splice(0)) run() }
/** A clock for opening again that keeps no time either: what is asked for runs in the next microtask. */
const soon: Clock = { after: (_ms, run) => { let off = false; queueMicrotask(() => { if (!off) run() }); return () => { off = true } } }

const settle = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)) }

/** Each session's random name in place of what it is, by the order they appear. */
const named = (lines: readonly string[]): string[] => {
  const names = new Map<string, string>()
  return lines.map((line) => line.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (uuid) => {
    if (!names.has(uuid)) names.set(uuid, `session-${names.size + 1}`)
    return names.get(uuid)!
  }))
}

const recording = (): string[] => {
  const doc = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'docs', 'wire.md'), 'utf8').replace(/\r\n/g, '\n')
  const block = /<!-- recording -->\n```text\n([\s\S]*?)```/.exec(doc)?.[1]
  if (block === undefined) throw new Error('docs/wire.md has no recording')
  return block.trimEnd().split('\n')
}

it('is what docs/wire.md records, text for text', async () => {
  let backend: Link | undefined
  const take = only(accept((made) => { backend = made }, { bound: { frame: 2048 } }))
  let connection: Transport | undefined
  const window = dial(() => {
    const [left, right] = memoryPair()
    take(recorded(right, 'B', 'A'))
    // The window's end is carried on something that takes no message longer than 4 KiB, and says so in its hello.
    connection = { ...recorded(left, 'A', 'B'), most: 4096 }
    return connection
  }, { there: { window: 30_000, clock }, reopen: { clock: soon }, part: 120, bound: { frame: 2048 } })

  // Each frame the window's end says, one caused and one private.
  window.send({ kind: 'tell', to: 'threads', event: { clicked: 'new' } }, { cause: 'click' })
  window.send({ kind: 'ask', id: 1, to: 'threads', name: 'CREATE', args: { topic: 'one' } })
  window.send({ kind: 'follow', id: 1, feature: 'threads', view: 'list', args: null }, { private: true })
  await settle()
  // And the backend's: what is said before an answer, a view's result, the answer.
  backend!.send({ kind: 'progress', id: 1, update: 'half' })
  backend!.send({ kind: 'shown', id: 1, update: [] })
  backend!.send({ kind: 'answer', id: 1, outcome: { ok: true, value: { id: 'THR-1' } } })
  await settle()
  window.send({ kind: 'ask', id: 2, to: 'threads', name: 'WAIT', args: null })
  window.send({ kind: 'left', id: 2 })
  window.send({ kind: 'follow', id: 2, feature: 'threads', view: 'missing', args: null })
  window.send({ kind: 'unfollow', id: 1 })
  await settle()
  backend!.send({ kind: 'over', id: 2, failure: { kind: 'gone', message: 'No such view' } })
  await settle()
  // A frame longer than a part, 120 here, crosses in parts, and what caused it with the first.
  window.send({ kind: 'tell', to: 'threads', event: 'a long event, longer than the hundred and twenty characters a part may be here, and so cut into parts' }, { cause: 'paste' })
  await settle()

  // Owed an answer on a quiet connection: half the window, and the window's end asks whether the backend is there.
  const settled = window.awaiting()
  tick()
  await settle()
  settled()

  // The connection goes in the same turn as a frame is said: the window's end opens another, each end says where it took
  // the other to, and what was said goes on the new one.
  window.send({ kind: 'tell', to: 'threads', event: 'said as it closed' })
  connection!.close()
  await settle()
  window.send({ kind: 'tell', to: 'threads', event: 'after' })
  await settle()

  // The window's end goes for good.
  window.close('ended')
  await settle()

  // A backend that began after a session started does not know it, and says so.
  const fresh = only(accept(() => {}))
  const [left, right] = memoryPair()
  fresh(recorded(right, 'B', 'A'))
  recorded(left, 'A', 'B').send(JSON.stringify([{ link: 1, session: crypto.randomUUID(), taken: 0, resumes: crypto.randomUUID() }]))
  await settle()

  expect(named(crossed)).toEqual(recording())
})
