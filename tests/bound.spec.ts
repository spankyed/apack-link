// What a link keeps, and what waits, are bounded: a view's result overtaken while the other end is behind is let
// go, nothing else is, and past the bound with nothing left to let go the link ends by name.
import { MessageChannel } from 'node:worker_threads'
import { describe, expect, it } from 'vitest'
import { dial, memoryPair, port, type Ending, type Frame, type Message, type Transport } from '../src/index.ts'

const turn = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })
const until = async (done: () => boolean): Promise<void> => { while (!done()) await turn() }
const shown = (id: number, update: unknown): Frame => ({ kind: 'shown', id, update })
const tell = (event: unknown): Frame => ({ kind: 'tell', to: 'x', event })

/** Two ends in memory, where what the first sends is held until `release` lets it cross: the other end takes nothing. */
const held = () => {
  const waiting: Array<() => void> = []
  let holding = true
  const [left, right] = memoryPair((run) => { if (holding) waiting.push(run); else queueMicrotask(run) }, queueMicrotask)
  return {
    left, right,
    release: () => { holding = false; for (const run of waiting.splice(0)) run() },
  }
}
const listening = (to: Transport) => {
  const end = dial(to)
  const heard: Frame[] = []
  const ended: Ending[] = []
  end.onFrame((frame) => { heard.push(frame) })
  end.onEnd((ending) => { ended.push(ending) })
  return { end, heard, ended }
}

describe('a view that changes while nothing is taken', () => {
  it('crosses as one frame once taking goes on, over memory', async () => {
    const { left, right, release } = held()
    const a = dial(left, { bound: { kept: { frames: 4, size: 1 << 20 } } })
    const b = listening(right)
    for (let result = 1; result <= 10_000; result++) {
      a.send(shown(1, result))
      if (result % 1000 === 0) await turn()
    }
    expect([a.kept(), a.waiting()]).toEqual([4, 1])
    release()
    await until(() => b.heard.length === 5)
    await turn()
    expect(b.heard).toEqual([1, 2, 3, 4, 10_000].map((result) => shown(1, result)))
    expect(b.ended).toEqual([])
  })

  it('crosses as one frame once taking goes on, over a message port', async () => {
    const channel = new MessageChannel()
    const a = dial(port(channel.port1), { bound: { kept: { frames: 4, size: 1 << 20 } } })
    for (let result = 1; result <= 10_000; result++) {
      a.send(shown(1, result))
      if (result % 1000 === 0) await turn()
    }
    expect(a.waiting()).toBe(1)
    // The other end begins to take only now.
    const b = listening(port(channel.port2))
    await until(() => b.heard.length === 5)
    await turn()
    expect(b.heard).toEqual([1, 2, 3, 4, 10_000].map((result) => shown(1, result)))
    channel.port1.close()
  })
})

describe('what does arrive', () => {
  it('is in the order it was sent, with a view never behind what was said after it', async () => {
    const { left, right, release } = held()
    const a = dial(left, { bound: { kept: { frames: 1, size: 1 << 20 } } })
    const b = listening(right)
    const sent: Frame[] = [tell('first'), shown(1, 1), tell('A'), shown(2, 1), shown(1, 2), tell('B'), shown(1, 3), shown(2, 2), tell('C')]
    for (const frame of sent) a.send(frame)
    release()
    await until(() => b.heard.length === 6)
    await turn()
    // A later result takes the place of the one it overtook: what was said after a result never passes it.
    expect(b.heard).toEqual([tell('first'), shown(1, 3), tell('A'), shown(2, 2), tell('B'), tell('C')])
  })
})

describe('past the bound', () => {
  it('ends the link by name, when nothing waiting can be let go', async () => {
    const { left, right } = held()
    const a = dial(left, { bound: { kept: { frames: 10, size: 1 << 20 }, waiting: { frames: 1000, size: 1 << 30 } } })
    listening(right)
    const ended: Ending[] = []
    a.onEnd((ending) => { ended.push(ending) })
    for (let id = 1; id <= 10_000; id++) a.send({ kind: 'answer', id, outcome: { ok: true, value: id } })
    expect(ended).toHaveLength(1)
    expect(ended[0]).toMatchObject({ why: 'overrun', waiting: { frames: 1001 }, bound: { frames: 1000, size: 1 << 30 } })
  })

  it('lets no progress go, however much of it there is for one ask', async () => {
    const { left, right, release } = held()
    const a = dial(left, { bound: { kept: { frames: 1, size: 1 << 20 }, waiting: { frames: 100_000, size: 1 << 30 } } })
    const b = listening(right)
    for (let part = 1; part <= 1000; part++) a.send({ kind: 'progress', id: 1, update: part })
    release()
    await until(() => b.heard.length === 1000)
    expect(b.heard.map((frame) => frame.kind === 'progress' && frame.update)).toEqual(Array.from({ length: 1000 }, (_, at) => at + 1))
  })

  it('counts the length of what waits as well as how many', () => {
    const { left } = held()
    const a = dial(left, { bound: { kept: { frames: 1, size: 1 << 20 }, waiting: { frames: 1000, size: 100 } } })
    const ended: Ending[] = []
    a.onEnd((ending) => { ended.push(ending) })
    a.send(tell('numbered'))
    a.send(tell('waits'))
    expect(ended).toEqual([])
    a.send(tell('x'.repeat(100)))
    expect(ended).toEqual([{ why: 'overrun', waiting: { frames: 2, size: expect.any(Number) }, bound: { frames: 1000, size: 100 } }])
  })
})

describe('an end that only listens', () => {
  it('says what it took, so the one sending is not taken to be behind', async () => {
    const [left, right] = memoryPair()
    // About thirty characters a frame: what was taken has to be let go by length as well, or the mark is soon passed.
    const a = dial(left, { bound: { kept: { frames: 150, size: 6000 }, waiting: { frames: 200, size: 1 << 20 } } })
    const ended: Ending[] = []
    a.onEnd((ending) => { ended.push(ending) })
    const b = listening(right)
    for (let turns = 0; turns < 100; turns++) {
      for (let at = 0; at < 100; at++) a.send(tell(turns * 100 + at))
      await turn()
    }
    await until(() => b.heard.length === 10_000)
    await turn()
    expect(ended).toEqual([])
    expect(b.heard.map((frame) => frame.kind === 'tell' && frame.event)).toEqual(Array.from({ length: 10_000 }, (_, at) => at))
    expect(a.kept()).toBe(0)
  })
})

describe('a transport that says how much it has not written', () => {
  it('is counted against the bound', async () => {
    const [left, right] = memoryPair()
    let unwritten = 0
    const counted: Transport = { ...left, send: (message: Message) => left.send(message), waiting: () => unwritten }
    const a = dial(counted, { bound: { kept: { frames: 1000, size: 1000 } } })
    const b = listening(right)
    a.send(tell(1))
    await until(() => b.heard.length === 1)
    unwritten = 5000
    a.send(tell(2))
    a.send(tell(3))
    expect(a.waiting()).toBe(2)
    unwritten = 0
    // Room again, and nothing has arrived to say so: what is sent now still waits behind what was waiting.
    a.send(tell(4))
    // Anything arriving is when a link looks again.
    b.end.send(tell('back'))
    await until(() => b.heard.length === 4)
    expect(b.heard.map((frame) => frame.kind === 'tell' && frame.event)).toEqual([1, 2, 3, 4])
  })
})
