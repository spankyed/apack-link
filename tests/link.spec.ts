import { describe, expect, it } from 'vitest'
import { link, memoryPair, type Ending, type Frame } from '../src/index.ts'
import { everyOrder, scheduledPair, type Schedule } from '../src/testing/index.ts'

const turn = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })
const tell = (event: unknown): Frame => ({ kind: 'tell', to: 'x', event })
const told = (frames: readonly Frame[]): unknown[] => frames.map((frame) => frame.kind === 'tell' && frame.event)
const hello = JSON.stringify({ link: 1 })

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
      a.send(tell(1))
      b.send(tell(2))
      a.send(tell(3))
      b.send(tell(4))
      return () => {
        expect(told(heard.b)).toEqual([1, 3])
        expect(told(heard.a)).toEqual([2, 4])
        expect([ended.a, ended.b]).toEqual([[], []])
      }
    })
    // Three texts each way, the hello among them, in every order the two directions can take.
    expect(orderings).toBe(20)
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
    bare.send(JSON.stringify({ seq: 2, frame: tell('second') }))
    bare.send(JSON.stringify({ seq: 1, frame: tell('first') }))
    await turn()
    expect(heard).toEqual([])
    expect(ended).toEqual([{ why: 'out of order', expected: 1, got: 2 }])
  })

  it('closes when the same frame arrives twice, having handed it over once', async () => {
    const { bare, heard, ended } = facing()
    const text = JSON.stringify({ seq: 1, frame: tell('once') })
    bare.send(hello)
    bare.send(text)
    bare.send(text)
    await turn()
    expect(heard).toHaveLength(1)
    expect(ended).toEqual([{ why: 'out of order', expected: 2, got: 1 }])
  })

  it('closes when what arrives is not a frame, saying how long it was and not what it said', async () => {
    for (const text of ['{ not json', '7', 'null', JSON.stringify({ seq: 1 }), JSON.stringify({ seq: 1, frame: { id: 1 } })]) {
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
    const a = link({ send: (text) => { texts.push(text) }, onText: () => {}, onClose: () => {}, close: () => {} })
    a.send(tell('before'))
    a.close()
    a.send(tell('after'))
    a.close('ended')
    expect(texts.map((text) => JSON.parse(text))).toEqual([{ link: 1 }, { seq: 1, frame: tell('before') }])
  })

  it('is closed by what carries it going, after what was sent before it went', async () => {
    const { bare, heard, ended } = facing()
    bare.send(hello)
    bare.send(JSON.stringify({ seq: 1, frame: tell('last') }))
    bare.close()
    expect(ended).toEqual([])
    await turn()
    expect(told(heard)).toEqual(['last'])
    expect(ended).toEqual([{ why: 'closed' }])
  })
})

describe('hello', () => {
  it('is the first thing each end says', async () => {
    const [bare, right] = memoryPair()
    const texts: string[] = []
    bare.onText((text) => { texts.push(text) })
    link(right).send(tell('after'))
    await turn()
    expect(JSON.parse(texts[0]!)).toEqual({ link: 1 })
    expect(texts).toHaveLength(2)
  })

  it('refuses an end that says another number, naming both', async () => {
    const { bare, heard, ended } = facing()
    bare.send(JSON.stringify({ link: 2 }))
    bare.send(JSON.stringify({ seq: 1, frame: tell('from another link') }))
    await turn()
    expect(heard).toEqual([])
    expect(ended).toEqual([{ why: 'version', mine: 1, theirs: 2 }])
  })

  it('is waited for: a frame from an end that has not said it is not taken', async () => {
    const { bare, heard, ended } = facing()
    const text = JSON.stringify({ seq: 1, frame: tell('unannounced') })
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
