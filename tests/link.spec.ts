import { describe, expect, it } from 'vitest'
import { accept, bytesOf, join, link, memoryPair, socket, type Ending, type Frame, type Transport } from '../src/index.ts'
import { asking, desk, everyOrder, scheduledPair, type Schedule } from '../src/testing/index.ts'

const turn = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })
const tell = (event: unknown): Frame => ({ kind: 'tell', to: 'x', event })
const told = (frames: readonly Frame[]): unknown[] => frames.map((frame) => frame.kind === 'tell' && frame.event)
/** A batch, as one end puts it on the wire. */
const wire = (...said: unknown[]): string => JSON.stringify(said)
/** A hello, as a bare end says it. */
const HELLO = { link: 1, session: 'the bare end', taken: 0 }
const hello = wire(HELLO)
/** A hello as a link says it: its session is its own. */
const saidHello = { link: 1, session: expect.any(String), taken: 0 }

/** Two ends on a schedule, each direction a lane of its own, and what each has heard. */
const joined = (schedule: Schedule) => {
  const [left, right] = scheduledPair(schedule)
  const a = link(left)
  const b = link(right)
  const heard = { a: [] as Frame[], b: [] as Frame[] }
  const ended = { a: [] as Ending[], b: [] as Ending[] }
  a.onFrame((frame) => { heard.a.push(frame) })
  b.onFrame((frame) => { heard.b.push(frame) })
  a.onEnd((ending) => { ended.a.push(ending) })
  b.onEnd((ending) => { ended.b.push(ending) })
  return { a, b, heard, ended }
}

/** One end of a link, and the bare other end of what carries it, to say to it what a link would not. */
const facing = () => {
  const [bare, right] = memoryPair()
  const b = link(right)
  const heard: Frame[] = []
  const ended: Ending[] = []
  b.onFrame((frame) => { heard.push(frame) })
  b.onEnd((ending) => { ended.push(ending) })
  return { bare, heard, ended }
}

describe('a link', () => {
  it('hands over frames of every kind in the order they were sent', async () => {
    const sent: Frame[] = [
      { kind: 'follow', id: 1, feature: 'threads', view: 'list', args: {} },
      { kind: 'ask', id: 1, to: 'threads', name: 'CREATE', args: { topic: 'one' } },
      { kind: 'shown', id: 1, update: ['one'] },
      { kind: 'progress', id: 1, update: 'half' },
      { kind: 'tell', to: 'panel', event: { type: 'CREATED' } },
      { kind: 'answer', id: 1, outcome: { ok: true } },
      { kind: 'unfollow', id: 1 },
    ]
    await everyOrder((schedule) => {
      const { a, heard, ended } = joined(schedule)
      for (const frame of sent) a.send(frame)
      return () => {
        expect(heard.b).toEqual(sent)
        expect(ended.b).toEqual([])
      }
    })
  })

  it('carries both ways at once, each way numbered on its own', async () => {
    const orderings = await everyOrder((schedule) => {
      const { a, b, heard, ended } = joined(schedule)
      // Each in a turn of its own, so each crosses as a batch of its own.
      a.send(tell(1))
      schedule.does('a', ['sends 3', () => a.send(tell(3))])
      schedule.does('b', ['sends 2', () => b.send(tell(2))])
      return () => {
        expect(told(heard.b)).toEqual([1, 3])
        expect(told(heard.a)).toEqual([2])
        expect([ended.a, ended.b]).toEqual([[], []])
      }
    })
    expect(orderings).toBeGreaterThan(1)
  })

  it('refuses a frame that cannot be put into text, alone: the next one arrives, and nothing is missing before it', async () => {
    await everyOrder((schedule) => {
      const { a, heard, ended } = joined(schedule)
      a.send(tell('before'))
      expect(() => a.send(tell({ big: 1n }))).toThrow(TypeError)
      a.send(tell('after'))
      return () => {
        expect(told(heard.b)).toEqual(['before', 'after'])
        expect(ended.b).toEqual([])
      }
    })
  })

  it('closes, saying why, when a frame arrives that is not the next one', async () => {
    const { bare, heard, ended } = facing()
    bare.send(hello)
    bare.send(wire({ seq: 2, frame: tell('second') }))
    bare.send(wire({ seq: 1, frame: tell('first') }))
    await turn()
    expect(heard).toEqual([])
    expect(ended).toEqual([{ why: 'out of order', expected: 1, got: 2 }])
  })

  it('closes when the same frame arrives twice, having handed it over once', async () => {
    const { bare, heard, ended } = facing()
    const text = wire({ seq: 1, frame: tell('once') })
    bare.send(hello)
    bare.send(text)
    bare.send(text)
    await turn()
    expect(heard).toHaveLength(1)
    expect(ended).toEqual([{ why: 'out of order', expected: 2, got: 1 }])
  })

  it('closes when what arrives is not a frame, saying how long it was and not what it said', async () => {
    for (const text of ['{ not json', '7', 'null', '[]', JSON.stringify({ seq: 1, frame: tell('not in a batch') }), wire({ seq: 1 }), wire({ seq: 1, frame: { id: 1 } }), wire(7)]) {
      const { bare, heard, ended } = facing()
      bare.send(hello)
      bare.send(text)
      await turn()
      expect(heard).toEqual([])
      expect(ended).toEqual([{ why: 'not a frame', size: text.length }])
    }
  })

  it('tells both ends once when either closes, and sends nothing after', async () => {
    await everyOrder((schedule) => {
      const { a, b, heard, ended } = joined(schedule)
      a.send(tell('sent'))
      schedule.does('b', ['closes', () => { b.close(); b.close() }])
      schedule.does('a', ['sends late', () => { a.send(tell('late')) }])
      return () => {
        expect(heard.b.length).toBeLessThanOrEqual(2)
        expect([ended.a, ended.b]).toEqual([[{ why: 'closed' }], [{ why: 'closed' }]])
        // One that asks after it has closed is told at once, and what is sent then goes nowhere.
        const late: Ending[] = []
        a.onEnd((ending) => { late.push(ending) })
        expect(late).toEqual([{ why: 'closed' }])
        const before = heard.b.length
        a.send(tell('after the end'))
        expect(heard.b).toHaveLength(before)
      }
    })
  })

  it('hands nothing to what carries it once it has closed', () => {
    const texts: string[] = []
    const a = link({ send: (text) => { texts.push(text as string) }, onData: () => {}, onClose: () => {}, close: () => {} })
    a.send(tell('before'))
    a.close()
    a.send(tell('after'))
    a.close('ended')
    // What was sent before it closed left as it closed, and nothing after.
    expect(texts.map((text) => JSON.parse(text))).toEqual([[saidHello, { seq: 1, frame: tell('before') }]])
  })

  it('takes a batch that arrives as bytes', async () => {
    const { bare, heard, ended } = facing()
    bare.send(new TextEncoder().encode(wire(HELLO, { seq: 1, frame: tell('as bytes ✓') })))
    await turn()
    expect(told(heard)).toEqual(['as bytes ✓'])
    expect(ended).toEqual([])
  })

  it('is closed by what carries it going, after what was sent before it went', async () => {
    const { bare, heard, ended } = facing()
    bare.send(wire(HELLO, { seq: 1, frame: tell('last') }))
    bare.close()
    expect(ended).toEqual([])
    await turn()
    expect(told(heard)).toEqual(['last'])
    expect(ended).toEqual([{ why: 'closed' }])
  })
})

describe('one write a turn', () => {
  /** What carries a link, noting each text handed to it. */
  const counted = () => {
    const [left, right] = memoryPair()
    const texts: string[] = []
    const send = left.send
    left.send = (text) => { texts.push(text as string); send(text) }
    return { left, right, texts }
  }

  it('sends a thousand frames said in one turn as one text, and they arrive in order', async () => {
    const { left, right, texts } = counted()
    const a = link(left)
    const heard: Frame[] = []
    link(right).onFrame((frame) => { heard.push(frame) })
    const sent = Array.from({ length: 1000 }, (_, at) => tell(at))
    for (const frame of sent) a.send(frame)
    await turn()
    expect(texts).toHaveLength(1)
    expect(heard).toEqual(sent)
  })

  it('leaves no gap where a frame in the middle was refused', async () => {
    const { left, right, texts } = counted()
    const a = link(left)
    const heard: Frame[] = []
    const ended: Ending[] = []
    const b = link(right)
    b.onFrame((frame) => { heard.push(frame) })
    b.onEnd((ending) => { ended.push(ending) })
    for (let at = 0; at < 1000; at++) {
      if (at === 500) expect(() => a.send(tell({ big: 1n }))).toThrow(TypeError)
      else a.send(tell(at))
    }
    await turn()
    a.send(tell('next turn'))
    await turn()
    expect(texts).toHaveLength(2)
    expect(told(heard)).toEqual([...Array.from({ length: 1000 }, (_, at) => at).filter((at) => at !== 500), 'next turn'])
    expect(ended).toEqual([])
  })

  it('sends what is said in another turn as another text, when the link is given what says when a turn ends', async () => {
    const [left, right] = memoryPair()
    const texts: string[] = []
    const send = left.send
    left.send = (text) => { texts.push(text as string); send(text) }
    const turns: Array<() => void> = []
    const a = link(left, { later: (run) => { turns.push(run) } })
    const heard: Frame[] = []
    link(right).onFrame((frame) => { heard.push(frame) })
    a.send(tell(1))
    a.send(tell(2))
    turns.shift()!()
    a.send(tell(3))
    turns.shift()!()
    await turn()
    expect(texts.map((text) => (JSON.parse(text) as unknown[]).length)).toEqual([3, 1])
    expect(told(heard)).toEqual([1, 2, 3])
  })
})

describe('a batch', () => {
  it('is taken in order, and nothing in it after what ended the link', async () => {
    for (const [after, why] of [
      [{ bye: 'ended' }, { why: 'goodbye', bye: 'ended' }],
      [{ seq: 3, frame: tell('out of place') }, { why: 'out of order', expected: 2, got: 3 }],
    ] as const) {
      const { bare, heard, ended } = facing()
      bare.send(wire(HELLO, { seq: 1, frame: tell('first') }, after, { seq: 2, frame: tell('after the end') }))
      await turn()
      expect(told(heard)).toEqual(['first'])
      expect(ended).toEqual([why])
    }
  })
})

describe('hello', () => {
  it('is the first thing each end says', async () => {
    const [bare, right] = memoryPair()
    const texts: string[] = []
    bare.onData((text) => { texts.push(text as string) })
    link(right).send(tell('after'))
    await turn()
    expect(texts.map((text) => JSON.parse(text))).toEqual([[saidHello, { seq: 1, frame: tell('after') }]])
  })

  it('refuses an end that says another number, naming both', async () => {
    const { bare, heard, ended } = facing()
    bare.send(wire({ ...HELLO, link: 2 }, { seq: 1, frame: tell('from another link') }))
    await turn()
    expect(heard).toEqual([])
    expect(ended).toEqual([{ why: 'version', mine: 1, theirs: 2 }])
  })

  it('is waited for: a frame from an end that has not said it is not taken', async () => {
    const { bare, heard, ended } = facing()
    const text = wire({ seq: 1, frame: tell('unannounced') })
    bare.send(text)
    await turn()
    expect(heard).toEqual([])
    expect(ended).toEqual([{ why: 'not a frame', size: text.length }])
  })

  it('takes no number: the first frame after it is the first', async () => {
    await everyOrder((schedule) => {
      const { a, b, heard, ended } = joined(schedule)
      a.send(tell('first'))
      b.send(tell('first back'))
      return () => {
        expect([told(heard.b), told(heard.a)]).toEqual([['first'], ['first back']])
        expect([ended.a, ended.b]).toEqual([[], []])
      }
    })
  })
})

describe('goodbye', () => {
  for (const bye of ['restarting', 'ended'] as const) {
    it(`ends the other end saying it was ${bye}, after everything sent before it`, async () => {
      await everyOrder((schedule) => {
        const { a, b, heard, ended } = joined(schedule)
        a.send(tell('before'))
        b.send(tell('crossing'))
        schedule.does('a', ['says goodbye', () => { a.send(tell('last')); a.close(bye) }])
        return () => {
          expect(told(heard.b)).toEqual(['before', 'last'])
          expect(ended.b).toEqual([{ why: 'goodbye', bye }])
          expect(ended.a).toEqual([{ why: 'closed' }])
        }
      })
    })
  }

  it('is not said by an end that only closes, or by one already closed', async () => {
    await everyOrder((schedule) => {
      const { a, b, ended } = joined(schedule)
      schedule.does('a', ['closes', () => { a.close() }], ['says goodbye late', () => { a.close('ended') }])
      schedule.does('b', ['sends', () => { b.send(tell('crossing')) }])
      return () => {
        expect([ended.a, ended.b]).toEqual([[{ why: 'closed' }], [{ why: 'closed' }]])
      }
    })
  })
})

describe('what the other end says it took', () => {
  it('ends the link when it is more than was sent, or less than it said before', async () => {
    for (const taken of [[3], [2, 1]]) {
      const [bare, right] = memoryPair()
      const a = link(right)
      const ended: Ending[] = []
      a.onEnd((ending) => { ended.push(ending) })
      a.send(tell(1))
      a.send(tell(2))
      bare.send(hello)
      for (const said of taken) bare.send(wire({ taken: said }))
      await turn()
      expect([taken, ended]).toEqual([taken, [{ why: 'not a frame', size: wire({ taken: taken.at(-1) }).length }]])
    }
  })
})

describe('what arrives as a frame', () => {
  it('ends the link when it is not one of the frames there are, saying how many bytes and not what', async () => {
    const failure = { kind: 'gone', message: 'It went' }
    for (const frame of [
      { kind: 'bytes', id: 1 },
      { kind: 'tell', event: 1 },
      { kind: 'tell', to: 7, event: 1 },
      { kind: 'ask', to: 'x', name: 'ASK', args: {} },
      { kind: 'ask', id: 0, to: 'x', name: 'ASK', args: {} },
      { kind: 'ask', id: 1, to: 'x', name: 7, args: {} },
      { kind: 'ask', id: 1, name: 'ASK', args: {} },
      { kind: 'left', id: -1 },
      { kind: 'left', id: 1.5 },
      { kind: 'left', id: '1' },
      { kind: 'progress', id: 2 ** 53, update: 1 },
      { kind: 'answer', outcome: { ok: true } },
      { kind: 'follow', id: 1, feature: 'x', args: {} },
      { kind: 'follow', id: 1, feature: 7, view: 'list', args: {} },
      { kind: 'shown', id: null, update: 1 },
      { kind: 'unfollow' },
      { kind: 'over', id: 1 },
      { kind: 'over', id: 1, failure: 'gone' },
      { kind: 'over', id: 1, failure: { kind: 'gone' } },
      { kind: 'over', id: 1, failure: { kind: 7, message: 'It went' } },
      { kind: 'over', id: 0, failure },
    ]) {
      const { bare, heard, ended } = facing()
      const text = wire({ seq: 1, frame })
      bare.send(hello)
      bare.send(text)
      await turn()
      expect([frame, heard]).toEqual([frame, []])
      expect([frame, ended]).toEqual([frame, [{ why: 'not a frame', size: text.length }]])
    }
  })

  it('is handed on as the frame it is and nothing else, with what it carries for a system left as it came', async () => {
    const { bare, heard, ended } = facing()
    const carried = [null, 0, 'text', [1, { deep: [true] }], { kind: 'tell', id: 'not a frame\'s own' }]
    const frames: Frame[] = [
      ...carried.map((event): Frame => ({ kind: 'tell', to: 'x', event })),
      ...carried.map((outcome, at): Frame => ({ kind: 'answer', id: at + 1, outcome })),
      { kind: 'ask', id: 1, to: 'x', name: 'ASK', args: carried },
      { kind: 'left', id: 1 },
      { kind: 'progress', id: 1, update: carried },
      { kind: 'follow', id: 1, feature: 'x', view: 'list', args: carried },
      { kind: 'shown', id: 1, update: carried },
      { kind: 'unfollow', id: 1 },
      { kind: 'over', id: 1, failure: { kind: 'gone', message: 'It went' } },
    ]
    bare.send(wire(HELLO, ...frames.map((frame, at) => ({ seq: at + 1, frame: { ...frame, more: 'than a frame has' } })), { seq: frames.length + 1, frame: { kind: 'tell', to: 'x' } }))
    await turn()
    expect(heard).toEqual([...frames, { kind: 'tell', to: 'x', event: undefined }])
    expect(heard.some((frame) => 'more' in frame)).toBe(false)
    expect(ended).toEqual([])
  })
})

describe('a size', () => {
  const bytes = (text: string): number => new TextEncoder().encode(text).length

  it('is in bytes, of text as it crosses: a frame as a tap is told of it, at both ends', async () => {
    const [left, right] = memoryPair()
    const a = link(left)
    const b = link(right)
    const out: number[] = []
    const in_: number[] = []
    a.onTraffic((traffic) => { out.push(traffic.size) })
    b.onTraffic((traffic) => { in_.push(traffic.size) })
    const frame = tell('✓ é 𝄞 \ud800 plain')
    a.send(frame, { cause: 'step ✓' })
    a.send(tell('plain'))
    await turn()
    const sizes = [bytes(JSON.stringify({ seq: 1, frame, cause: 'step ✓' })), bytes(JSON.stringify({ seq: 2, frame: tell('plain') }))]
    expect(sizes[0]).toBeGreaterThan(JSON.stringify({ seq: 1, frame, cause: 'step ✓' }).length)
    expect([out, in_]).toEqual([sizes, sizes])
  })

  it('is in bytes where what arrived was not a frame, as text or as bytes', async () => {
    const text = '["✓✓✓"'
    for (const message of [text, new TextEncoder().encode(text)]) {
      const { bare, ended } = facing()
      bare.send(hello)
      bare.send(message)
      await turn()
      expect(ended).toEqual([{ why: 'not a frame', size: bytes(text) }])
    }
  })

  it('is in bytes where what is kept is counted against its mark', () => {
    const [left] = memoryPair()
    // Forty characters, and more than a hundred bytes.
    const a = link(left, { bound: { kept: { frames: 100, size: 100 } } })
    a.send(tell('✓'.repeat(40)))
    a.send(tell('waits'))
    expect([a.kept(), a.waiting()]).toEqual([1, 1])
  })

  it('is in bytes where what waits is counted against its bound', () => {
    const [left] = memoryPair()
    const a = link(left, { bound: { kept: { frames: 1, size: 1 << 20 }, waiting: { frames: 100, size: 100 } } })
    const ended: Ending[] = []
    a.onEnd((ending) => { ended.push(ending) })
    a.send(tell('numbered'))
    // Forty-five characters and sixty-five bytes: two of it are past a hundred bytes, and not past a hundred characters.
    const waits = tell('✓'.repeat(10))
    a.send(waits)
    expect(ended).toEqual([])
    a.send(waits)
    expect(ended).toEqual([{ why: 'overrun', waiting: { frames: 2, size: 2 * bytes(JSON.stringify(waits)) }, bound: { frames: 100, size: 100 } }])
  })
})

describe('a frame larger than a frame may be', () => {
  const around = JSON.stringify(tell('')).length

  it('is refused where it is sent, alone: the link goes on, and nothing is missing before the next', async () => {
    const [left, right] = memoryPair()
    const a = link(left, { bound: { frame: 1024 } })
    const heard: Frame[] = []
    link(right).onFrame((frame) => { heard.push(frame) })
    const ended: Ending[] = []
    a.onEnd((ending) => { ended.push(ending) })
    const fits = tell('x'.repeat(1024 - around))
    a.send(fits)
    let thrown: unknown
    try { a.send(tell('x'.repeat(1024 - around + 1))) } catch (error) { thrown = error }
    // Nothing it says holds what the frame did.
    expect(thrown).toBeInstanceOf(RangeError)
    expect(thrown).toEqual(new RangeError('A frame is larger than may be sent'))
    // Its cause is counted with it, and both in bytes: four hundred characters here are twelve hundred bytes.
    expect(() => a.send(fits, { cause: 'c' })).toThrow(RangeError)
    expect(() => a.send(tell('✓'.repeat(400)))).toThrow(RangeError)
    expect(() => a.send(tell('small'), { cause: '✓'.repeat(400) })).toThrow(RangeError)
    a.send(tell('after'))
    await turn()
    expect(heard).toEqual([fits, tell('after')])
    expect(ended).toEqual([])
  })

  it('is found where it is prepared, as it would be where it is sent, with nothing sent', async () => {
    const [left, right] = memoryPair()
    const a = link(left, { bound: { frame: 1024 } })
    const heard: Frame[] = []
    link(right).onFrame((frame) => { heard.push(frame) })
    expect(() => a.prepare(tell('x'.repeat(1024 - around + 1)))).toThrow(RangeError)
    expect(() => a.prepare(tell('small'), { cause: 'x'.repeat(1024) })).toThrow(RangeError)
    expect(() => a.prepare(tell({ big: 1n }))).toThrow(TypeError)
    expect(a.prepare(tell('x'.repeat(1024 - around)))).toEqual({ prepared: 'tell' })
    await turn()
    expect(heard).toEqual([])
  })

  it('may be 64 MiB unless told, and is never told to be less than 1024 bytes', () => {
    const a = link(memoryPair()[0])
    const most = 64 * 1024 * 1024
    expect(() => a.prepare(tell('x'.repeat(most - around)))).not.toThrow()
    expect(() => a.prepare(tell('x'.repeat(most - around + 1)))).toThrow(RangeError)
    expect(() => link(memoryPair()[0], { bound: { frame: 1023 } })).toThrow(RangeError)
  })

  it('fails the one ask it was the answer to, and the next is answered', async () => {
    await everyOrder((schedule) => {
      const [left, right] = scheduledPair(schedule)
      const backend = desk({ ask: (asked) => { asked.ended({ ok: true, value: asked.args === 'large' ? 'x'.repeat(2000) : 'small' }) } })
      join(link(right, { bound: { frame: 1024 } }), backend.port)
      const toBackend = join(link(left), desk().port)
      const large = asking(toBackend, 'x', 'ASK', 'large')
      const small = asking(toBackend, 'x', 'ASK', 'small')
      return () => {
        expect(large.ended).toEqual([{ ok: false, failure: { kind: 'failed', message: 'A value could not be sent' } }])
        expect(small.ended).toEqual([{ ok: true, value: 'small' }])
      }
    })
  })

  it('is refused where it was said, when what a system says is held for its views', async () => {
    const [bare, there] = memoryPair()
    const texts: unknown[] = []
    bare.onData((text) => { texts.push(...JSON.parse(text as string) as unknown[]) })
    // A system whose view never says it has caught up: everything it says to the other end is held.
    const toOther = join(link(there, { bound: { frame: 1024 } }), desk({ follow: () => ({ caughtUp: () => {} }) }).port)
    bare.send(wire(HELLO, { seq: 1, frame: { kind: 'follow', id: 1, feature: 'x', view: 'list', args: {} } }))
    await turn()
    toOther.tell('x', 'held')
    expect(() => toOther.tell('x', 'y'.repeat(2000))).toThrow(RangeError)
    await turn()
    expect(texts.filter((said) => typeof said === 'object' && said !== null && 'seq' in said)).toEqual([])
  })
})

describe('a frame prepared', () => {
  it('is sent as it was when it was prepared, whatever becomes of it after, in the place it is sent', async () => {
    const [left, right] = memoryPair()
    const a = link(left)
    const heard: Array<{ frame: Frame; cause: string | undefined }> = []
    link(right).onFrame((frame, cause) => { heard.push({ frame, cause }) })
    const event = { said: 'first' }
    const ready = a.prepare(tell(event), { cause: 'when prepared' })
    event.said = 'changed'
    a.send(tell('before'))
    a.send(ready, { cause: 'when sent' })
    a.send(tell('after'))
    await turn()
    expect(heard).toEqual([{ frame: tell('before'), cause: undefined }, { frame: tell({ said: 'first' }), cause: 'when prepared' }, { frame: tell('after'), cause: undefined }])
  })

  it('is put into text once', async () => {
    const [left, right] = memoryPair()
    const a = link(left)
    link(right)
    let times = 0
    const ready = a.prepare(tell({ toJSON: () => { times++; return 'as text' } }))
    a.send(ready)
    await turn()
    expect(times).toBe(1)
  })

  it('is sent once, and by the link that prepared it', () => {
    const a = link(memoryPair()[0])
    const b = link(memoryPair()[0])
    const ready = a.prepare(tell(1))
    expect(() => b.send(ready)).toThrow(TypeError)
    a.send(ready)
    expect(() => a.send(ready)).toThrow(TypeError)
    expect(a.kept()).toBe(1)
  })

  it('is what a peer holds: what a system said is what crosses, though it changes while it is held, and is put into text once', async () => {
    const [bare, there] = memoryPair()
    const said: unknown[] = []
    bare.onData((text) => { said.push(...JSON.parse(text as string) as unknown[]) })
    // A view that says it has caught up when the spec has it say so: until then what the system says is held.
    let caughtUp: (() => void) | undefined
    const toOther = join(link(there), desk({ follow: () => ({ caughtUp: (then) => { caughtUp = then } }) }).port)
    bare.send(wire(HELLO, { seq: 1, frame: { kind: 'follow', id: 1, feature: 'x', view: 'list', args: {} } }))
    await turn()
    let times = 0
    const event = { said: 'first', toJSON() { times++; return { said: this.said } } }
    toOther.tell('x', event)
    event.said = 'changed'
    caughtUp!()
    await turn()
    expect(said.filter((one) => typeof one === 'object' && one !== null && 'seq' in one)).toEqual([{ seq: 1, frame: { kind: 'tell', to: 'x', event: { said: 'first' } } }])
    expect(times).toBe(1)
  })
})

describe('what carries a link taking no message longer than it says', () => {
  /** One end in memory that takes no message longer than `most`, noting each it is handed and whether it was closed. */
  const limited = (most: number) => {
    const [left, right] = memoryPair()
    const texts: string[] = []
    const noted = { closed: 0 }
    const narrow: Transport = { ...left, most, send: (message) => { texts.push(message as string); left.send(message) }, close: () => { noted.closed++; left.close() } }
    return { narrow, right, texts, noted }
  }
  const bytes = (text: string): number => new TextEncoder().encode(text).length
  /** A frame may be 1024 bytes, so what carries the link takes 1090 at least: the frame, what is put around it, and the batch's two. */
  const bound = { frame: 1024 }
  const LEAST = 1024 + 64 + 2
  /** Frames past one byte a character, so that it is bytes the texts are cut by. */
  const frames = (count: number): Frame[] => Array.from({ length: count }, (_, at) => tell(`✓é ${'x'.repeat(100 + at)}`))

  it('is handed a turn\'s frames as more than one text, none longer, and they arrive in order', async () => {
    const { narrow, right, texts } = limited(1400)
    const a = link(narrow, { bound })
    const heard: Frame[] = []
    const ended: Ending[] = []
    const b = link(right, { bound })
    b.onFrame((frame) => { heard.push(frame) })
    b.onEnd((ending) => { ended.push(ending) })
    const sent = frames(40)
    for (const frame of sent) a.send(frame, { cause: 'é' })
    a.close('ended')
    await turn()
    expect(heard).toEqual(sent)
    expect(ended).toEqual([{ why: 'goodbye', bye: 'ended' }])
    expect(texts.length).toBeGreaterThan(1)
    expect(Math.max(...texts.map(bytes))).toBeLessThanOrEqual(1400)
    // The hello is first, in the first, and the goodbye last, in the last.
    expect((JSON.parse(texts[0]!) as unknown[])[0]).toEqual({ ...saidHello, most: 1400 })
    expect((JSON.parse(texts.at(-1)!) as unknown[]).at(-1)).toEqual({ bye: 'ended' })
  })

  it('is handed nothing longer, and nothing cut sooner than it had to be, whatever length it takes', () => {
    const sent = frames(12)
    for (let most = LEAST; most <= LEAST + 300; most++) {
      const texts: string[] = []
      const turns: Array<() => void> = []
      const a = link({ most, send: (message) => { texts.push(message as string) }, onData: () => {}, onClose: () => {}, close: () => {} }, { bound, later: (run) => { turns.push(run) } })
      for (const frame of sent) a.send(frame, { cause: '✓' })
      for (const run of turns) run()
      const crossed = texts.flatMap((text) => JSON.parse(text) as Array<{ frame?: Frame }>)
      expect([most, crossed.slice(1).map((one) => one.frame)]).toEqual([most, sent])
      expect([most, Math.max(...texts.map(bytes)) <= most]).toEqual([most, true])
      // As few as it takes: no two that follow one another would have fitted in one.
      for (let at = 1; at < texts.length; at++) expect([most, bytes(texts[at - 1]!) + bytes(texts[at]!) - 1 > most]).toEqual([most, true])
    }
  })

  it('is handed one text for a turn that fits in one', async () => {
    const { narrow, texts } = limited(1400)
    const a = link(narrow, { bound })
    a.send(tell(1))
    a.send(tell(2))
    await turn()
    expect(texts).toHaveLength(1)
  })

  it('is handed what was kept in as many texts as it takes, on a connection that comes back', async () => {
    const a = link(undefined, { bound })
    // Met on a connection the other end never says it took anything on: everything sent is kept.
    const [first, there] = memoryPair()
    const said: Array<{ session: string }> = []
    first.onData((text) => { said.push(...JSON.parse(text as string) as Array<{ session: string }>) })
    a.carry(there)
    first.send(hello)
    await turn()
    const sent = frames(40)
    for (const frame of sent) a.send(frame)
    await turn()
    expect(a.kept()).toBe(40)
    const { narrow, right, texts } = limited(1400)
    a.carry(narrow)
    right.send(wire({ ...HELLO, resumes: said[0]!.session }))
    await turn()
    expect(texts.length).toBeGreaterThan(2)
    expect(Math.max(...texts.map(bytes))).toBeLessThanOrEqual(1400)
    const crossed = texts.flatMap((text) => JSON.parse(text) as Array<{ seq?: number; frame?: Frame }>).filter((one) => one.seq !== undefined)
    expect(crossed.map((one) => one.seq)).toEqual(sent.map((_, at) => at + 1))
    expect(crossed.map((one) => one.frame)).toEqual(sent)
  })

  it('does not carry a link at all when it takes no message as long as a frame the link may send: found as it is handed over, and closed', () => {
    const wide = limited(LEAST)
    expect(() => link(wide.narrow, { bound })).not.toThrow()
    const once = limited(LEAST - 1)
    expect(() => link(once.narrow, { bound })).toThrow(RangeError)
    expect(once.noted.closed).toBe(1)
    // Handed to a link, and handed to what accepts connections.
    const a = link(undefined, { bound })
    const handed = limited(LEAST - 1)
    expect(() => a.carry(handed.narrow)).toThrow(RangeError)
    expect(handed.noted.closed).toBe(1)
    const arriving = limited(LEAST - 1)
    expect(() => accept(() => {}, { bound })(arriving.narrow)).toThrow(RangeError)
    expect(arriving.noted.closed).toBe(1)
    // With the 64 MiB a frame may be unless told, 1090 bytes is nowhere near.
    expect(() => link(limited(LEAST).narrow)).toThrow(RangeError)
    // The first of a link that opens its own.
    const opening = limited(LEAST - 1)
    expect(() => link(() => opening.narrow, { bound, reopen: { clock: { after: () => () => {} } } })).toThrow(RangeError)
  })

  it('is counted as a connection that did not hold, and what was wrong handed on, where a link opens it for itself later', () => {
    const waits: Array<{ ms: number; run(): void }> = []
    const thrown: unknown[] = []
    let narrow = false
    const opened: Array<ReturnType<typeof limited>> = []
    link(() => { const end = limited(narrow ? LEAST - 1 : LEAST); opened.push(end); return end.narrow }, { bound, reopen: { clock: { after: (ms, run) => { waits.push({ ms, run }); return () => {} } } }, thrown: (error) => { thrown.push(error) } })
    narrow = true
    opened[0]!.narrow.close()
    opened[0]!.right.close()
    waits.at(-1)!.run()
    waits.at(-1)!.run()
    expect(waits.map((wait) => wait.ms)).toEqual([100, 200, 400])
    expect(thrown).toHaveLength(2)
    expect(thrown[0]).toBeInstanceOf(RangeError)
    expect(opened.slice(1).map((end) => end.noted.closed)).toEqual([1, 1])
  })

  it('is asked through what accepts connections, as is how much it has not written', async () => {
    const made: Array<ReturnType<typeof link>> = []
    const take = accept((one) => { made.push(one) }, { bound: { ...bound, kept: { frames: 1000, size: 100_000 } } })
    const { narrow, right, texts } = limited(1400)
    let unwritten = 0
    take({ ...narrow, waiting: () => unwritten })
    const heard: Frame[] = []
    link(right, { bound }).onFrame((frame) => { heard.push(frame) })
    await turn()
    const sent = frames(40)
    for (const frame of sent) made[0]!.send(frame)
    await turn()
    expect(heard).toEqual(sent)
    expect(Math.max(...texts.map(bytes))).toBeLessThanOrEqual(1400)
    unwritten = 500_000
    made[0]!.send(tell('waits'))
    expect(made[0]!.waiting()).toBe(1)
  })
})

describe('the longest message an end takes', () => {
  const bound = { frame: 1024 }
  const LEAST = 1024 + 64 + 2
  const bytes = (text: string): number => new TextEncoder().encode(text).length
  const frames = (count: number): Frame[] => Array.from({ length: count }, (_, at) => tell(`✓é ${'x'.repeat(100 + at)}`))
  /** A link on a transport that takes any length, facing a bare end, with each text the link sends. */
  const facingBare = () => {
    const [bare, right] = memoryPair()
    const texts: string[] = []
    bare.onData((text) => { texts.push(text as string) })
    return { bare, right, texts }
  }

  it('is said in its hello, where what carries it has one, and not where it has none', async () => {
    const { right, texts } = facingBare()
    link({ ...right, most: 5000 }, { bound })
    const plain = facingBare()
    link(plain.right, { bound })
    await turn()
    expect(JSON.parse(texts[0]!)).toEqual([{ ...saidHello, most: 5000 }])
    expect(JSON.parse(plain.texts[0]!)).toEqual([saidHello])
  })

  it('is kept to by the other end, once it has said so: a batch is cut to the shorter of what the two take', async () => {
    const { bare, right, texts } = facingBare()
    const a = link({ ...right, most: 5000 }, { bound })
    bare.send(wire({ ...HELLO, most: 1400 }))
    await turn()
    const sent = frames(40)
    for (const frame of sent) a.send(frame)
    await turn()
    const after = texts.slice(1)
    expect(after.length).toBeGreaterThan(1)
    expect(Math.max(...after.map(bytes))).toBeLessThanOrEqual(1400)
    for (let at = 1; at < after.length; at++) expect(bytes(after[at - 1]!) + bytes(after[at]!) - 1).toBeGreaterThan(1400)
    expect(after.flatMap((text) => JSON.parse(text) as Array<{ frame: Frame }>).map((one) => one.frame)).toEqual(sent)
    // And to its own, where that is the shorter.
    const other = facingBare()
    const b = link({ ...other.right, most: 1400 }, { bound })
    other.bare.send(wire({ ...HELLO, most: 5000 }))
    await turn()
    for (const frame of sent) b.send(frame)
    await turn()
    expect(Math.max(...other.texts.map(bytes))).toBeLessThanOrEqual(1400)
  })

  it('ends the link of an end that opened the connection, saying both, when it is less than a frame that end may send', async () => {
    for (const [most, ending] of [[LEAST, []], [LEAST - 1, [{ why: 'too narrow', most: LEAST - 1, frame: 1024 }]]] as const) {
      const { bare, right, texts } = facingBare()
      const a = link(right, { bound })
      const ended: Ending[] = []
      a.onEnd((end) => { ended.push(end) })
      bare.send(wire({ ...HELLO, most }))
      await turn()
      expect([most, ended]).toEqual([most, ending])
      // The other end is told, so that it does not wait.
      expect([most, texts.flatMap((text) => JSON.parse(text) as unknown[]).some((said) => typeof said === 'object' && said !== null && 'lost' in said)]).toEqual([most, ending.length > 0])
    }
  })

  it('is not a hello at all when it is not a length', async () => {
    for (const most of [0, -1, 1.5, '1400', null]) {
      const { bare, right } = facingBare()
      const ended: Ending[] = []
      link(right, { bound }).onEnd((end) => { ended.push(end) })
      const text = wire({ ...HELLO, most })
      bare.send(text)
      await turn()
      expect([most, ended]).toEqual([most, [{ why: 'not a frame', size: text.length }]])
    }
  })
})

describe('closing', () => {
  it('sends what waited for room before it closes, in order, and a goodbye last', async () => {
    const [left, right] = memoryPair()
    const a = link(left, { bound: { kept: { frames: 1, size: 1 << 20 } } })
    const b = link(right)
    const heard: Frame[] = []
    const ended: Ending[] = []
    b.onFrame((frame) => { heard.push(frame) })
    b.onEnd((ending) => { ended.push(ending) })
    for (const event of [1, 2, 3]) a.send(tell(event))
    expect(a.waiting()).toBe(2)
    a.close('ended')
    await turn()
    expect(told(heard)).toEqual([1, 2, 3])
    expect(ended).toEqual([{ why: 'goodbye', bye: 'ended' }])
  })

  it('sends what waited to meet the other end, from an end that has never met anybody, and a goodbye last', async () => {
    const [bare, right] = memoryPair()
    const texts: unknown[] = []
    bare.onData((text) => { texts.push(JSON.parse(text as string)) })
    // A link that can come back numbers nothing until the other end has said hello.
    const a = link()
    a.carry(right)
    for (const event of [1, 2]) a.send(tell(event))
    expect(a.waiting()).toBe(2)
    a.close('ended')
    await turn()
    expect(texts).toEqual([[saidHello, { seq: 1, frame: tell(1) }, { seq: 2, frame: tell(2) }, { bye: 'ended' }]])
  })

  it('is taken whole by what accepts connections: a window that says something and closes at once is heard', async () => {
    const heard: Frame[] = []
    const ended: Ending[] = []
    const take = accept((one) => { one.onFrame((frame) => { heard.push(frame) }); one.onEnd((ending) => { ended.push(ending) }) })
    const [left, right] = memoryPair()
    take(right)
    const window = link()
    window.carry(left)
    window.send(tell('all it had to say'))
    window.close('ended')
    await turn()
    expect(told(heard)).toEqual(['all it had to say'])
    expect(ended).toEqual([{ why: 'goodbye', bye: 'ended' }])
  })

  it('says goodbye and lets go of what waited, on a connection where an end it met before has not been met again', async () => {
    const a = link()
    const [first, there] = memoryPair()
    a.carry(there)
    first.send(hello)
    await turn()
    first.close()
    await turn()
    const [bare, right] = memoryPair()
    const texts: unknown[] = []
    bare.onData((text) => { texts.push(JSON.parse(text as string)) })
    a.carry(right)
    a.send(tell('waits to meet again'))
    a.close('ended')
    await turn()
    // What it sent before may be out of step with what the other end took: nothing more is numbered.
    expect(texts).toEqual([[{ ...saidHello, resumes: HELLO.session }, { bye: 'ended' }]])
  })
})

describe('a transport that throws where it is handed something to send', () => {
  it('is a connection that has gone: the link ends closed, when it is the only one it has', async () => {
    let closed = 0
    const thrown: unknown[] = []
    const a = link({ send: () => { throw new Error('cannot send') }, onData: () => {}, onClose: () => {}, close: () => { closed++ } }, { thrown: (error) => { thrown.push(error) } })
    const ended: Ending[] = []
    a.onEnd((ending) => { ended.push(ending) })
    a.send(tell(1))
    await turn()
    expect(ended).toEqual([{ why: 'closed' }])
    expect(closed).toBe(1)
    // None of the transports here throws: what one did is handed on.
    expect(thrown).toEqual([new Error('cannot send')])
  })

  it('is a connection that has gone: what it was handed is sent again on the next, once, in order', async () => {
    const b = link()
    const heard: Frame[] = []
    b.onFrame((frame) => { heard.push(frame) })
    let failing = false
    let opened = 0
    const closed: number[] = []
    const a = link(() => {
      const [left, right] = memoryPair()
      const at = opened++
      b.carry(right)
      return { ...left, send: (message) => { if (failing) { failing = false; throw new Error('cannot send') } left.send(message) }, close: () => { closed.push(at); left.close() } }
    // Opened again a turn after it is asked, however long was asked for.
    }, { reopen: { clock: { after: (_, run) => { let off = false; setImmediate(() => { if (!off) run() }); return () => { off = true } } } }, thrown: (error) => { thrown.push(error) } })
    const thrown: unknown[] = []
    const ended: Ending[] = []
    a.onEnd((ending) => { ended.push(ending) })
    try {
      a.send(tell(1))
      await turn()
      expect(told(heard)).toEqual([1])
      failing = true
      a.send(tell(2))
      a.send(tell(3))
      for (let turns = 0; turns < 3; turns++) await turn()
      a.send(tell(4))
      await turn()
      expect(told(heard)).toEqual([1, 2, 3, 4])
      expect([opened, closed, ended]).toEqual([2, [0], []])
      expect(a.kept()).toBe(0)
      expect(thrown).toEqual([new Error('cannot send')])
    } finally { a.close() }
  })
})

describe('how many bytes a text is', () => {
  it('is what it is as UTF-8, whatever it holds', () => {
    for (const text of ['', 'plain', 'é', '✓', '𝄞', 'a𝄞b✓cé', '\ud800', '\udc00', '\ud800x', '\udc00\ud800', '𝄞\ud834', '߿ࠀ￿']) {
      expect([text, bytesOf(text)]).toEqual([text, new TextEncoder().encode(text).length])
    }
  })
})

describe('a WebSocket that is still opening', () => {
  it('says what waits for it to open in bytes', () => {
    const ws = { readyState: 0, bufferedAmount: 3, binaryType: '', send: () => {}, close: () => {}, addEventListener: () => {} }
    const carried = socket(ws)
    carried.send('✓✓')
    carried.send(new Uint8Array(4))
    expect(carried.waiting!()).toBe(3 + 6 + 4)
  })
})
