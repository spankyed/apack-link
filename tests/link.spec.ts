import { describe, expect, it } from 'vitest'
import { bytesOf, link, memoryPair, socket, type Ending, type Frame } from '../src/index.ts'
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

describe('a frame larger than all that may wait', () => {
  it('ends the link overrun where it is sent, with room or without, and is not sent', async () => {
    const [left, right] = memoryPair()
    const a = link(left, { bound: { waiting: { frames: 100, size: 100 } } })
    const heard: Frame[] = []
    link(right).onFrame((frame) => { heard.push(frame) })
    const ended: Ending[] = []
    a.onEnd((ending) => { ended.push(ending) })
    a.send(tell('x'.repeat(60)))
    expect(ended).toEqual([])
    a.send(tell('x'.repeat(100)))
    expect(ended).toEqual([{ why: 'overrun', waiting: { frames: 1, size: JSON.stringify(tell('x'.repeat(100))).length }, bound: { frames: 100, size: 100 } }])
    await turn()
    expect(heard).toEqual([])
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

  it('says goodbye to an end it has not met, and lets go of what waited to meet it', async () => {
    const [bare, right] = memoryPair()
    const texts: unknown[] = []
    bare.onData((text) => { texts.push(JSON.parse(text as string)) })
    // A link that can come back numbers nothing until the other end has said hello.
    const a = link()
    a.carry(right)
    a.send(tell('waits to meet'))
    expect(a.waiting()).toBe(1)
    a.close('ended')
    await turn()
    expect(texts).toEqual([[saidHello, { bye: 'ended' }]])
    expect(a.waiting()).toBe(0)
  })
})

describe('a transport that throws where it is handed something to send', () => {
  it('is a connection that has gone: the link ends closed, when it is the only one it has', async () => {
    let closed = 0
    const a = link({ send: () => { throw new Error('cannot send') }, onData: () => {}, onClose: () => {}, close: () => { closed++ } })
    const ended: Ending[] = []
    a.onEnd((ending) => { ended.push(ending) })
    a.send(tell(1))
    await turn()
    expect(ended).toEqual([{ why: 'closed' }])
    expect(closed).toBe(1)
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
    }, { reopen: { clock: { after: (_, run) => { let off = false; setImmediate(() => { if (!off) run() }); return () => { off = true } } } } })
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
