import { describe, expect, it } from 'vitest'
import { link, memoryPair, type Ending, type Frame, type Transport } from '../src/index.ts'

const turn = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })
/** Two ends joined in memory, and what each has heard. */
const joined = (later?: (run: () => void) => void) => {
  const [left, right] = memoryPair(later)
  const a = link(left)
  const b = link(right)
  const heard: Frame[] = []
  const ended: Ending[] = []
  b.onFrame((frame) => { heard.push(frame) })
  b.onEnd((ending) => { ended.push(ending) })
  return { a, b, left, right, heard, ended }
}

describe('a link', () => {
  it('hands over frames of every kind in the order they were sent', async () => {
    const { a, heard } = joined()
    const sent: Frame[] = [
      { kind: 'follow', id: 1, feature: 'threads', view: 'list', args: {} },
      { kind: 'ask', id: 1, to: 'threads', name: 'CREATE', args: { topic: 'one' } },
      { kind: 'shown', id: 1, update: ['one'] },
      { kind: 'progress', id: 1, update: 'half' },
      { kind: 'tell', to: 'panel', event: { type: 'CREATED' } },
      { kind: 'answer', id: 1, outcome: { ok: true } },
      { kind: 'unfollow', id: 1 },
    ]
    for (const frame of sent) a.send(frame)
    await turn()
    expect(heard).toEqual(sent)
  })

  it('carries both ways at once, each way numbered on its own', async () => {
    const { a, b, heard } = joined()
    const back: Frame[] = []
    a.onFrame((frame) => { back.push(frame) })
    a.send({ kind: 'tell', to: 'x', event: 1 })
    b.send({ kind: 'tell', to: 'y', event: 2 })
    a.send({ kind: 'tell', to: 'x', event: 3 })
    await turn()
    expect(heard.map((frame) => frame.kind === 'tell' && frame.event)).toEqual([1, 3])
    expect(back.map((frame) => frame.kind === 'tell' && frame.event)).toEqual([2])
  })

  it('refuses a frame that cannot be put into text, alone: the next one arrives, and nothing is missing before it', async () => {
    const { a, heard, ended } = joined()
    a.send({ kind: 'tell', to: 'x', event: 'before' })
    expect(() => a.send({ kind: 'tell', to: 'x', event: { big: 1n } })).toThrow(TypeError)
    a.send({ kind: 'tell', to: 'x', event: 'after' })
    await turn()
    expect(heard.map((frame) => frame.kind === 'tell' && frame.event)).toEqual(['before', 'after'])
    expect(ended).toEqual([])
  })

  it('closes, saying why, when a frame arrives that is not the next one', async () => {
    // What carries it hands the second text over before the first.
    const waiting: Array<() => void> = []
    const { a, heard, ended } = joined((run) => { waiting.push(run) })
    a.send({ kind: 'tell', to: 'x', event: 'first' })
    a.send({ kind: 'tell', to: 'x', event: 'second' })
    waiting[1]!()
    waiting[0]!()
    expect(heard).toEqual([])
    expect(ended).toEqual([{ why: 'out of order', expected: 1, got: 2 }])
  })

  it('closes when the same frame arrives twice, having handed it over once', async () => {
    const [left, right] = memoryPair()
    const b = link(right)
    const heard: Frame[] = []
    const ended: Ending[] = []
    b.onFrame((frame) => { heard.push(frame) })
    b.onEnd((ending) => { ended.push(ending) })
    const text = JSON.stringify({ seq: 1, frame: { kind: 'tell', to: 'x', event: 'once' } })
    left.send(text)
    left.send(text)
    await turn()
    expect(heard).toHaveLength(1)
    expect(ended).toEqual([{ why: 'out of order', expected: 2, got: 1 }])
  })

  it('closes when what arrives is not a frame', async () => {
    const [left, right] = memoryPair()
    const ended: Ending[] = []
    link(right).onEnd((ending) => { ended.push(ending) })
    left.send('{ not json')
    await turn()
    expect(ended).toEqual([{ why: 'not a frame', text: '{ not json' }])
  })

  it('tells both ends once when either closes, and sends nothing after', async () => {
    const { a, b, heard, ended } = joined()
    const mine: Ending[] = []
    a.onEnd((ending) => { mine.push(ending) })
    a.send({ kind: 'tell', to: 'x', event: 'sent' })
    await turn()
    b.close()
    b.close()
    a.send({ kind: 'tell', to: 'x', event: 'late' })
    await turn()
    expect(heard).toHaveLength(1)
    expect([mine, ended]).toEqual([[{ why: 'closed' }], [{ why: 'closed' }]])
    // One that asks after it has closed is told at once.
    const late: Ending[] = []
    a.onEnd((ending) => { late.push(ending) })
    expect(late).toEqual([{ why: 'closed' }])
  })

  it('is closed by what carries it going', async () => {
    const { left, ended } = joined()
    ;(left satisfies Transport).close()
    expect(ended).toEqual([{ why: 'closed' }])
  })
})
