import { describe, expect, it } from 'vitest'
import { link, memoryPair, type Ending, type Frame } from '../src/index.ts'
import { everyOrder, scheduledPair, type Schedule } from '../src/testing/index.ts'

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
      schedule.does('a', ['sends 1', () => a.send(tell(1))], ['sends 3', () => a.send(tell(3))])
      schedule.does('b', ['sends 2', () => b.send(tell(2))], ['sends 4', () => b.send(tell(4))])
      return () => {
        expect(told(heard.b)).toEqual([1, 3])
        expect(told(heard.a)).toEqual([2, 4])
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
