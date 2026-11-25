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

  it('counts cause bytes toward bound.waiting.size, including when an overtaken shown changes cause length', async () => {
    const { left } = held()
    // Each short frame is ~35 bytes; a 120-byte cause pushes the waiting size past 100 even though the frame alone is under 100.
    const a = dial(left, { bound: { kept: { frames: 1, size: 1 << 20 }, waiting: { frames: 1000, size: 100 } } })
    const ended: Ending[] = []
    a.onEnd((ending) => { ended.push(ending) })
    a.send(tell('numbered'))
    a.send(shown(1, 'a'), { cause: 'c'.repeat(20) })
    expect(ended).toEqual([])
    // Replacing the waiting shown with a longer cause updates waitingSize accurately and triggers overrun.
    a.send(shown(1, 'b'), { cause: 'c'.repeat(120) })
    expect(ended).toHaveLength(1)
    expect(ended[0]).toMatchObject({ why: 'overrun', waiting: { frames: 1 }, bound: { frames: 1000, size: 100 } })
    if (ended[0]?.why === 'overrun') expect(ended[0].waiting.size).toBeGreaterThan(100)

    // When a waiting shown is overtaken with a much longer cause and then released under a small `part` limit,
    // its updated `causeSize` keeps `frameSize` accurate so the short frame crosses whole instead of splitting.
    const { left: left2, right: right2, release } = held()
    const a2 = dial(left2, { part: 100, bound: { kept: { frames: 1, size: 1 << 20 } } })
    const b2 = listening(right2)
    a2.send(tell('numbered'))
    a2.send(shown(1, 'a'), { cause: 'x' })
    a2.send(shown(1, 'b'), { cause: 'y'.repeat(500) })
    a2.send(tell('after'))
    release()
    await until(() => b2.heard.length === 3 || b2.ended.length > 0)
    expect(b2.ended).toEqual([])
    expect(b2.heard).toEqual([tell('numbered'), shown(1, 'b'), tell('after')])
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

  it('does not falsely overrun when taken arrives earlier in the same batch before onFrame sends, nor deadlock when backlog lags past the last taken', async () => {
    // Mid-batch taken frees room before onFrame runs, so sending from onFrame does not trigger overrun.
    const [bare, right] = memoryPair()
    const a = dial(right, { bound: { kept: { frames: 1, size: 1024 }, waiting: { frames: 1, size: 1024 } } })
    const ended: Ending[] = []
    a.onEnd((ending) => { ended.push(ending) })
    a.onFrame(() => { a.send(tell('from-onFrame')) })
    a.send(tell('kept'))
    a.send(tell('waiting'))
    expect([a.kept(), a.waiting()]).toEqual([1, 1])
    bare.send(JSON.stringify([{ link: 1, session: 'peer', taken: 0 }, { taken: 1 }, { seq: 1, frame: tell('trigger') }]))
    await turn()
    expect(ended).toEqual([])
    expect([a.kept(), a.waiting()]).toEqual([1, 1])

    // Backlog momentarily high when the last taken arrives still probes waiting frames once kept empties, preventing deadlock.
    const [left2, right2] = memoryPair()
    let unwritten = 0
    const a2 = dial({ ...left2, waiting: () => unwritten }, { bound: { kept: { frames: 10, size: 1000 } } })
    const b2 = listening(right2)
    a2.send(tell('first'))
    unwritten = 5000
    a2.send(tell('second'))
    a2.send(tell('third'))
    expect([a2.kept(), a2.waiting()]).toEqual([1, 2])
    // Even while unwritten stays high, probing 1 frame whenever kept drains to 0 keeps progress moving without deadlock.
    await until(() => b2.heard.length === 3)
    expect(b2.heard.map((f) => f.kind === 'tell' && f.event)).toEqual(['first', 'second', 'third'])
    unwritten = 0
    await turn()
    expect([a2.kept(), a2.waiting()]).toEqual([0, 0])
  })

  it('handles thousands of trickle acks and partial drains without drift', async () => {
    const [left, right] = memoryPair()
    const a = dial(left, { bound: { kept: { frames: 8, size: 1 << 20 }, waiting: { frames: 5000, size: 1 << 20 } } })
    const b = listening(right)
    for (let i = 1; i <= 1200; i++) a.send(tell(i))
    await until(() => b.heard.length === 1200)
    await turn()
    expect([a.kept(), a.waiting()]).toEqual([0, 0])
    expect(b.heard.map((f) => f.kind === 'tell' && f.event)).toEqual(Array.from({ length: 1200 }, (_, i) => i + 1))
  })
})
