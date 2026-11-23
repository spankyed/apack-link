import { expect, it } from 'vitest'
import { join, link, memoryPair, type Outcome, type Port } from '../src/index.ts'

// The README's example, as it is written there.
it('runs the README example', async () => {
  const backend: Port = {
    tell: () => {},
    ask: (_to, _name, _args, _heard, ended) => { ended({ ok: true, value: { id: 'THR-1' } }); return () => {} },
    follow: (_feature, _view, _args, shown) => { shown(0); return { stop: () => {} } },
  }
  const [left, right] = memoryPair()
  join(link(right), backend)
  const toBackend = join(link(left), { tell: () => {}, ask: () => () => {}, follow: () => ({ stop: () => {} }) })
  const ended = new Promise<Outcome>((resolve) => { toBackend.ask('threads', 'CREATE', { topic: 'one' }, () => {}, resolve) })
  expect(await ended).toEqual({ ok: true, value: { id: 'THR-1' } })
})
