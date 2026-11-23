// What a link does is whole before anything it calls is called: a listener that closes or sends as it is handed a
// frame, and a transport that throws as the link ends, find it as that step left it.
import { describe, expect, it } from 'vitest'
import { link, memoryPair, type Ending, type Frame, type Message, type Transport } from '../src/index.ts'

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
    const a = link(other.transport)
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
    const a = link(left, { bound: { kept: { frames: 1, size: 1024 } } })
    const b = link(right)
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
    const a = link(other.transport)
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
    const a = link(other.transport, { thrown: (error) => { thrown.push(error) } })
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
    const a = link(other.transport, { thrown: (error) => { thrown.push(error) } })
    a.onEnd((ending) => { ended.push(ending) })
    await turn()
    a.close('ended')
    await turn()
    expect(ended).toEqual([{ why: 'closed' }])
    expect(thrown).toEqual([new Error('cannot send')])
  })
})
