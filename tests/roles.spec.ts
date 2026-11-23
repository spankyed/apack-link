// The two ends of a link are not alike. The one that dials says hello first on a connection, and ends for what it
// meets there. The one that listens says nothing on a connection until a hello that fits has arrived on it, and
// ends for nothing said before one.
import { describe, expect, it } from 'vitest'
import { dial, LINK, listen, memoryPair, type Ending, type Frame, type Link, type Message, type Transport } from '../src/index.ts'
import { setup } from '../src/core.ts'
import { everyOrder, scheduledPair } from '../src/testing/index.ts'

const turn = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })
const tell = (event: unknown): Frame => ({ kind: 'tell', to: 'x', event })

/** A connection whose other end the spec holds: what the link said on it, and what says something to the link. */
const bare = () => {
  const [mine, theirs] = memoryPair()
  const said: unknown[] = []
  let closed = 0
  mine.onData((message) => { said.push(...(JSON.parse(message as string) as unknown[])) })
  mine.onClose(() => { closed++ })
  return { transport: theirs, said, closed: () => closed, say: (...words: unknown[]) => { mine.send(JSON.stringify(words)) }, close: () => { mine.close() } }
}
const watched = (link: Link) => {
  const heard: Frame[] = []
  const ended: Ending[] = []
  link.onFrame((frame) => { heard.push(frame) })
  link.onEnd((ending) => { ended.push(ending) })
  return { heard, ended }
}
const hello = { link: LINK, session: 'the one that dials', taken: 0 }

describe('the end that dials', () => {
  it('says hello first, with what it has to say beside it where it is on one connection alone', async () => {
    const other = bare()
    dial(other.transport).send(tell('at once'))
    await turn()
    expect(other.said).toEqual([{ link: LINK, session: expect.any(String), taken: 0 }, { seq: 1, frame: tell('at once') }])
  })

  it('says hello first on each connection it opens, and nothing else until it is answered', async () => {
    const made: Array<ReturnType<typeof bare>> = []
    const waits: Array<() => void> = []
    const a = dial(() => { made.push(bare()); return made.at(-1)!.transport }, { reopen: { clock: { after: (_, run) => { waits.push(run); return () => {} } } } })
    a.send(tell('waits to be answered'))
    await turn()
    expect(made[0]!.said).toEqual([{ link: LINK, session: expect.any(String), taken: 0 }])
    made[0]!.close()
    await turn()
    waits.shift()!()
    await turn()
    expect(made[1]!.said).toEqual([{ link: LINK, session: expect.any(String), taken: 0 }])
    made[1]!.say({ link: LINK, session: 'the one that listens', taken: 0 })
    await turn()
    expect(made[1]!.said.slice(1)).toEqual([{ seq: 1, frame: tell('waits to be answered') }])
  })

  it('is not handed connections: it has nothing to be handed one with', () => {
    const a = dial(bare().transport)
    // @ts-expect-error an end that dials opens its connections, or is on one alone
    expect(a.carry).toBeUndefined()
  })
})

describe('the end that listens', () => {
  for (const [how, make] of [
    ['on one connection alone', (transport: Transport) => listen(transport)],
    ['handed its connections', (transport: Transport) => { const made = listen(); made.carry(transport); return made }],
  ] as const) {
    it(`${how}, says nothing until a hello has arrived, though it has something to send, and then answers and sends it`, async () => {
      const other = bare()
      const b = make(other.transport)
      const { heard, ended } = watched(b)
      b.send(tell('waits for a hello'))
      b.awaiting()
      await turn()
      await turn()
      expect([other.said, b.waiting()]).toEqual([[], 1])
      other.say(hello, { seq: 1, frame: tell('with the hello') })
      await turn()
      expect(other.said).toEqual([{ link: LINK, session: expect.any(String), taken: 0 }, { seq: 1, frame: tell('waits for a hello') }, { taken: 1 }])
      expect([heard, ended]).toEqual([[tell('with the hello')], []])
    })
  }

  for (const [what, first, told] of [
    ['something that is not a link\'s', 7, []],
    ['a frame with no hello before it', { seq: 1, frame: tell('unannounced') }, []],
    ['a hello of another link', { ...hello, link: LINK + 1 }, [{ link: LINK, session: expect.any(String), taken: 0 }]],
    ['a hello going on with a session that is not this one', { ...hello, resumes: 'somebody else' }, [{ link: LINK, session: expect.any(String), taken: 0 }, { lost: true }]],
    ['a hello that says it took what was never sent', { ...hello, taken: 3 }, [{ link: LINK, session: expect.any(String), taken: 0 }, { lost: true }]],
  ] as const) {
    it(`handed its connections, ends for nothing: ${what} is turned away, and the next connection is taken up`, async () => {
      const b = listen()
      const { heard, ended } = watched(b)
      const stranger = bare()
      b.carry(stranger.transport)
      stranger.say(first, { seq: 1, frame: tell('from a stranger') })
      await turn()
      // Told why where it would otherwise wait, and closed.
      expect([stranger.said, stranger.closed()]).toEqual([told, 1])
      expect([heard, ended]).toEqual([[], []])
      const other = bare()
      b.carry(other.transport)
      other.say(hello, { seq: 1, frame: tell('from who it talks to') })
      await turn()
      expect([heard, ended]).toEqual([[tell('from who it talks to')], []])
    })

    it(`on one connection alone, ends closed, and for nothing else, when ${what} is said on it`, async () => {
      const stranger = bare()
      const { heard, ended } = watched(listen(stranger.transport))
      stranger.say(first, { seq: 1, frame: tell('from a stranger') })
      await turn()
      expect([stranger.said, stranger.closed()]).toEqual([told, 1])
      expect([heard, ended]).toEqual([[], [{ why: 'closed' }]])
    })
  }

  it('on one connection alone, ends closed when it closes with nothing said on it', async () => {
    const other = bare()
    const { ended } = watched(listen(other.transport))
    other.close()
    await turn()
    expect(ended).toEqual([{ why: 'closed' }])
  })

  it('handed its connections, goes on when one closes with nothing said on it', async () => {
    const b = listen()
    const { ended } = watched(b)
    const first = bare()
    b.carry(first.transport)
    first.close()
    await turn()
    expect(ended).toEqual([])
  })

  it('says goodbye on a connection that waits, with what it had to send, where it has met nobody', async () => {
    const other = bare()
    const b = listen()
    b.carry(other.transport)
    b.send(tell('all it had to say'))
    b.close('ended')
    await turn()
    expect(other.said).toEqual([{ link: LINK, session: expect.any(String), taken: 0 }, { seq: 1, frame: tell('all it had to say') }, { bye: 'ended' }])
  })
})

describe('the two together', () => {
  it('meet in every order, the hello of the one that dials crossing first, and each hands the other what it sent', async () => {
    expect(await everyOrder((schedule) => {
      const [left, right] = scheduledPair(schedule)
      const crossed: string[] = []
      const noting = (transport: Transport, who: string): Transport => ({ ...transport, send: (message: Message) => { crossed.push(`${who}: ${String(message)}`); transport.send(message) } })
      const [a, b] = [dial(noting(left, 'a')), listen(noting(right, 'b'))]
      const [atA, atB] = [watched(a), watched(b)]
      schedule.does('a', ['sends', () => a.send(tell('from a'))])
      schedule.does('b', ['sends', () => b.send(tell('from b'))])
      return () => {
        expect(crossed[0]).toMatch(/^a: \[\{"link":1/)
        expect([atA.heard, atB.heard]).toEqual([[tell('from b')], [tell('from a')]])
        expect([atA.ended, atB.ended]).toEqual([[], []])
      }
    })).toBeGreaterThan(1)
  })

  it('two ends that both dial on one connection meet all the same: each takes the other\'s hello as the answer to its own', async () => {
    const [left, right] = memoryPair()
    const [a, b] = [dial(left), dial(right)]
    const [atA, atB] = [watched(a), watched(b)]
    a.send(tell('from a'))
    b.send(tell('from b'))
    await turn()
    expect([atA.heard, atB.heard, atA.ended, atB.ended]).toEqual([[tell('from b')], [tell('from a')], [], []])
  })
})

describe('how an end is set', () => {
  it('is not one that dials and is handed its connections, or listens and opens them', () => {
    expect(() => setup({ role: 'dials', connections: 'handed', session: 'x' })).toThrow(TypeError)
    expect(() => setup({ role: 'listens', connections: 'opened', session: 'x' })).toThrow(TypeError)
    for (const [role, connections] of [['dials', 'one'], ['dials', 'opened'], ['listens', 'one'], ['listens', 'handed']] as const) {
      expect(setup({ role, connections, session: 'x' })).toMatchObject({ role, connections })
    }
  })
})
