// What a link does is whole before anything it calls is called: a listener that closes or sends as it is handed a
// frame, and a transport that throws as the link ends, find it as that step left it.
import { describe, expect, it } from 'vitest'
import { dial, listen, memoryPair, type Ending, type Frame, type Message, type Transport } from '../src/index.ts'

const turn = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })
const tell = (event: unknown): Frame => ({ kind: 'tell', to: 'x', event })
const told = (frames: readonly Frame[]): unknown[] => frames.map((frame) => frame.kind === 'tell' && frame.event)

/** One end of a transport held by the spec: what the link sent on it, and what hands the link a message. */
const bare = (send?: (message: Message) => void) => {
  const hears: Array<(message: Message) => void> = []
  const closes: Array<() => void> = []
  const made = {
    sent: [] as string[],
    closed: 0,
    hand: (...said: unknown[]) => { for (const hear of hears) hear(JSON.stringify(said)) },
    transport: {
      send: (message) => { send?.(message); made.sent.push(String(message)) },
      onData: (hear) => { hears.push(hear) },
      onClose: (closed) => { closes.push(closed) },
      close: () => { made.closed++; for (const closed of closes.splice(0)) closed() },
    } satisfies Transport as Transport,
  }
  return made
}
const hello = { link: 1, session: 'the other end', taken: 0 }
const numbered = (seq: number, event: unknown) => ({ seq, frame: tell(event) })

describe('a listener that acts as it is handed a frame', () => {
  it('is handed nothing after the frame it closed the link on, though more came in the same message', async () => {
    const other = bare()
    const a = dial(other.transport)
    const heard: Frame[] = []
    const later: Frame[] = []
    a.onFrame((frame) => { heard.push(frame); if (frame.kind === 'tell' && frame.event === 2) a.close('ended') })
    a.onFrame((frame) => { later.push(frame) })
    other.hand(hello, numbered(1, 1), numbered(2, 2), numbered(3, 3), numbered(4, 4))
    await turn()
    // Every listener is handed the frame the link was closed on, and none anything after it.
    expect([told(heard), told(later)]).toEqual([[1, 2], [1, 2]])
    // It said it took two, and no more: what came after was not taken.
    expect(other.sent.join('')).toContain('{"taken":2}')
    expect(other.sent.join('')).not.toContain('{"taken":4}')
  })

  it('has what it sends numbered after what already waited, where the message it was handed in made room', async () => {
    const [left, right] = memoryPair()
    const a = dial(left, { bound: { kept: { frames: 1, size: 1024 } } })
    const b = listen(right)
    const heard: Frame[] = []
    b.onFrame((frame) => { heard.push(frame) })
    // The first is kept, and the second waits for it to be taken.
    a.send(tell('first'))
    a.send(tell('waited'))
    a.onFrame(() => { a.send(tell('sent as a frame was handed over')) })
    b.send(tell('from b'))
    await turn()
    await turn()
    expect(told(heard)).toEqual(['first', 'waited', 'sent as a frame was handed over'])
  })

  it('sends in the middle of a message, and is still handed the rest of it in order', async () => {
    const other = bare()
    const a = dial(other.transport)
    const heard: Frame[] = []
    a.onFrame((frame) => { heard.push(frame); a.send(tell(`after ${String(told([frame])[0])}`)) })
    other.hand(hello, numbered(1, 'one'), numbered(2, 'two'), numbered(3, 'three'))
    await turn()
    expect(told(heard)).toEqual(['one', 'two', 'three'])
    const sent = other.sent.flatMap((message) => JSON.parse(message) as Array<{ frame?: Frame }>).flatMap((said) => (said.frame ? told([said.frame]) : []))
    expect(sent).toEqual(['after one', 'after two', 'after three'])
  })
})

describe('a transport that throws as the link ends', () => {
  it('leaves the link ended for why it ended, and what was thrown handed on', async () => {
    // It takes the hello, and throws for the word that the session is lost.
    const other = bare((message) => { if (String(message).includes('"lost"')) throw new Error('cannot send') })
    const thrown: unknown[] = []
    const ended: Ending[] = []
    const a = dial(other.transport, { thrown: (error) => { thrown.push(error) } })
    a.onEnd((ending) => { ended.push(ending) })
    await turn()
    // A hello going on with a session that is not this end's: the session is lost.
    other.hand({ ...hello, resumes: 'somebody else' })
    await turn()
    expect(ended).toEqual([{ why: 'lost' }])
    expect(thrown).toEqual([new Error('cannot send')])
    expect(other.closed).toBeGreaterThan(0)
  })

  it('ends a link closed as its transport throws once, with what was thrown handed on', async () => {
    const other = bare((message) => { if (String(message).includes('"bye"')) throw new Error('cannot send') })
    const thrown: unknown[] = []
    const ended: Ending[] = []
    const a = dial(other.transport, { thrown: (error) => { thrown.push(error) } })
    a.onEnd((ending) => { ended.push(ending) })
    await turn()
    a.close('ended')
    await turn()
    expect(ended).toEqual([{ why: 'closed' }])
    expect(thrown).toEqual([new Error('cannot send')])
  })
})

describe('what a link is handed', () => {
  it('has what closing a transport threw, as the link ended, handed on', async () => {
    const other = bare()
    const thrown: unknown[] = []
    const ended: Ending[] = []
    const a = dial({ ...other.transport, close: () => { throw new Error('cannot close') } }, { thrown: (error) => { thrown.push(error) } })
    a.onEnd((ending) => { ended.push(ending) })
    a.close()
    await turn()
    expect(ended).toEqual([{ why: 'closed' }])
    expect(thrown).toEqual([new Error('cannot close')])
  })

  it('closes a transport handed to a link that has ended, whatever it is, and throws nothing', () => {
    const a = listen(undefined, { bound: { frame: 4096 }, part: 2048 })
    a.close()
    let closed = 0
    expect(() => a.carry({ ...bare().transport, most: 64, close: () => { closed++ } })).not.toThrow()
    expect(closed).toBe(1)
  })

  it('goes on watching a quiet connection while it is owed something, however often another thing owed is settled', async () => {
    const other = bare()
    const waits: Array<() => void> = []
    const clock = { after: (_: number, run: () => void) => { waits.push(run); return () => { waits.splice(waits.indexOf(run), 1) } } }
    const a = dial(other.transport, { there: { window: 100, clock } })
    other.hand(hello)
    const first = a.awaiting()
    a.awaiting()
    first()
    first()
    // Something arriving starts the window over, for as long as anything is owed.
    other.hand({ here: 0 })
    await turn()
    expect(waits.length).toBe(1)
  })
})

describe('a transport that throws as it is closed for another', () => {
  const throwing = () => {
    const made = bare()
    return { ...made, transport: { ...made.transport, close: () => { throw new Error('cannot close') } } }
  }

  it('does not keep a link from taking up the connection it is handed in place of one that waited', async () => {
    const thrown: unknown[] = []
    const a = listen(undefined, { thrown: (error) => { thrown.push(error) } })
    const heard: Frame[] = []
    a.onFrame((frame) => { heard.push(frame) })
    // Nobody has said hello on the first, so it only waits: the next takes its place.
    a.carry(throwing().transport)
    const next = bare()
    expect(() => a.carry(next.transport)).not.toThrow()
    next.hand(hello, numbered(1, 'on the next'))
    a.send(tell('out'))
    await turn()
    expect(told(heard)).toEqual(['on the next'])
    expect(next.sent.join('')).toContain('"session"')
    expect(next.sent.join('')).toContain('"out"')
    expect(thrown).toEqual([new Error('cannot close')])
  })

  it('does not lose the frames that came with the hello a waiting connection was taken up for', async () => {
    const thrown: unknown[] = []
    const a = listen(undefined, { thrown: (error) => { thrown.push(error) } })
    const heard: Frame[] = []
    a.onFrame((frame) => { heard.push(frame) })
    const first = throwing()
    a.carry(first.transport)
    first.hand(hello)
    await turn()
    const session = (JSON.parse(first.sent[0]!) as Array<{ session: string }>)[0]!.session
    // The link has met the other end on the first, so the next waits for a hello that fits.
    const next = bare()
    a.carry(next.transport)
    next.hand({ ...hello, resumes: session }, numbered(1, 'with the hello'), numbered(2, 'and after'))
    a.send(tell('out'))
    await turn()
    expect(told(heard)).toEqual(['with the hello', 'and after'])
    expect(next.sent.join('')).toContain('"out"')
    expect(next.sent.join('')).toContain('{"taken":2}')
    expect(thrown).toEqual([new Error('cannot close')])
  })
})

describe('what a link leaves on its clocks', () => {
  const manual = () => {
    const waits: Array<() => void> = []
    return { waits, clock: { after: (_: number, run: () => void) => { waits.push(run); return () => { const at = waits.indexOf(run); if (at >= 0) waits.splice(at, 1) } } } }
  }

  it('watches nothing once the connection it watched has gone', async () => {
    const { waits, clock } = manual()
    const a = listen(undefined, { there: { window: 100, clock } })
    const other = bare()
    a.carry(other.transport)
    other.hand(hello)
    a.awaiting()
    await turn()
    expect(waits.length).toBe(1)
    other.transport.close()
    expect(waits.length).toBe(0)
  })

  it('opens nothing more once it has ended, though what opened its last connection threw', async () => {
    const { waits, clock } = manual()
    const thrown: unknown[] = []
    let opened = 0
    const first = bare()
    const a: ReturnType<typeof dial> = dial(() => {
      if (++opened === 1) return first.transport
      a.close()
      throw new Error('could not open')
    }, { reopen: { clock }, thrown: (error) => { thrown.push(error) } })
    first.transport.close()
    expect(waits.length).toBe(1)
    waits.shift()!()
    await turn()
    expect(thrown).toEqual([new Error('could not open')])
    expect([opened, waits.length]).toEqual([2, 0])
  })
})
