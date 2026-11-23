// Knowing the other end is there: a link given a window and a clock watches a quiet connection while it is owed
// something, and never otherwise. The clock is one the spec moves.
import { describe, expect, it } from 'vitest'
import { join, dial, listen, memoryPair, type Clock, type Ending, type Frame, type Message, type Outcome, type Transport } from '../src/index.ts'
import { desk } from '../src/testing/index.ts'

const turn = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })
const WINDOW = 1000

/** A clock that moves only when the spec moves it. */
const handClock = () => {
  let at = 0
  const timers = new Set<{ due: number; run: () => void }>()
  const clock: Clock = {
    after: (ms, run) => {
      const timer = { due: at + ms, run }
      timers.add(timer)
      return () => { timers.delete(timer) }
    },
  }
  return {
    clock,
    /** Moves the clock on, running what falls due, in order, and lets what that sends cross. */
    advance: async (ms: number): Promise<void> => {
      const until = at + ms
      for (;;) {
        const next = [...timers].sort((x, y) => x.due - y.due)[0]
        if (!next || next.due > until) break
        timers.delete(next)
        at = next.due
        next.run()
        await turn()
      }
      at = until
      await turn()
    },
  }
}

/** A window's link that opens a connection each time one closes, to a bare other end the spec speaks for. */
const watched = (clock: Clock) => {
  const sides: Array<{ texts: unknown[][]; bare: Transport }> = []
  const window = dial(() => {
    const [left, bare] = memoryPair()
    const side = { texts: [] as unknown[][], bare }
    bare.onData((message: Message) => { side.texts.push(JSON.parse(message as string) as unknown[]) })
    sides.push(side)
    return left
  // Opened again on the same clock: after a connection that met the other end, with no wait.
  }, { there: { window: WINDOW, clock }, reopen: { clock } })
  const ended: Ending[] = []
  window.onEnd((ending) => { ended.push(ending) })
  /** The other end, saying hello on the latest connection. */
  /** The other end, saying hello on the latest connection: once it has met the window, as going on with it. */
  let met: string | undefined
  const hello = (taken = 0): void => {
    sides.at(-1)!.bare.send(JSON.stringify([{ link: 1, session: 'backend', taken, ...(met === undefined ? {} : { resumes: met }) }]))
    met = (sides.at(-1)!.texts[0]?.[0] as { session: string } | undefined)?.session ?? met
  }
  const said = (): unknown[] => sides.flatMap((side) => side.texts.flat())
  return { window, sides, ended, hello, said }
}
const asks = (said: unknown[]): unknown[] => said.filter((one) => typeof one === 'object' && one !== null && 'there' in one)

describe('a link owed nothing', () => {
  it('sends nothing, however long it is quiet', async () => {
    const { clock, advance } = handClock()
    const end = watched(clock)
    end.hello()
    await turn()
    const before = end.said().length
    await advance(100 * WINDOW)
    expect(end.said().length).toBe(before)
    expect(end.sides).toHaveLength(1)
  })
})

describe('a link owed something that hears nothing', () => {
  it('asks whether the other end is there, and opens another connection after the window', async () => {
    const { clock, advance } = handClock()
    const end = watched(clock)
    end.hello()
    await turn()
    // Owed a `taken` for this, which never comes.
    end.window.send({ kind: 'tell', to: 'x', event: 1 })
    await turn()
    await advance(WINDOW / 2 - 1)
    expect(asks(end.said())).toEqual([])
    await advance(1)
    expect(asks(end.said())).toEqual([{ there: 1 }])
    expect(end.sides).toHaveLength(1)
    await advance(WINDOW / 2)
    expect(end.sides).toHaveLength(2)
    expect(end.ended).toEqual([])
  })

  it('does not take what it sends itself for the other end being there', async () => {
    const { clock, advance } = handClock()
    const end = watched(clock)
    end.hello()
    await turn()
    for (let at = 0; at < 3; at++) {
      end.window.send({ kind: 'tell', to: 'x', event: at })
      await advance(0.4 * WINDOW)
    }
    expect(asks(end.said())).toEqual([{ there: 1 }])
    expect(end.sides).toHaveLength(2)
  })

  it('is left alone when the other end says it is there', async () => {
    const { clock, advance } = handClock()
    const end = watched(clock)
    end.hello()
    await turn()
    end.window.send({ kind: 'tell', to: 'x', event: 1 })
    await turn()
    for (let windows = 0; windows < 10; windows++) {
      await advance(WINDOW / 2)
      const asked = asks(end.said()).at(-1) as { there: number }
      end.sides[0]!.bare.send(JSON.stringify([{ here: asked.there }]))
      await turn()
    }
    expect(end.sides).toHaveLength(1)
    expect(asks(end.said())).toHaveLength(10)
  })
})

describe('anything arriving', () => {
  it('starts the window again', async () => {
    const { clock, advance } = handClock()
    const end = watched(clock)
    end.hello()
    await turn()
    end.window.send({ kind: 'tell', to: 'x', event: 1 })
    await turn()
    for (let windows = 0; windows < 10; windows++) {
      await advance(0.4 * WINDOW)
      // A frame, not an answer to anything: it is enough that something came.
      end.sides[0]!.bare.send(JSON.stringify([{ seq: windows + 1, frame: { kind: 'tell', to: 'y', event: windows } }]))
      await turn()
    }
    expect(asks(end.said())).toEqual([])
    expect(end.sides).toHaveLength(1)
  })
})

describe('an ask outstanding for many windows', () => {
  it('is left alone while progress arrives, and nothing is given a time to answer in', async () => {
    const { clock, advance } = handClock()
    const [left, right] = memoryPair()
    const window = dial(left, { there: { window: WINDOW, clock } })
    const backend = listen(right)
    const ended: Ending[] = []
    window.onEnd((ending) => { ended.push(ending) })
    // The backend works for ten windows, saying how far it got every half window, then answers.
    const working = desk()
    join(backend, working.port)
    const answered: Outcome[] = []
    const heard: unknown[] = []
    join(window, desk().port).ask('imports', 'RUN', {}, (update) => { heard.push(update) }, (outcome) => { answered.push(outcome) })
    await turn()
    const asked = working.asks[0]!
    for (let half = 1; half <= 20; half++) {
      await advance(WINDOW / 2 - 1)
      asked.heard(half)
      await turn()
    }
    asked.ended({ ok: true, value: 'done' })
    await turn()
    expect(heard).toHaveLength(20)
    expect(answered).toEqual([{ ok: true, value: 'done' }])
    expect(ended).toEqual([])
  })

  it('is watched while it waits, and not once it is answered', async () => {
    const { clock, advance } = handClock()
    const end = watched(clock)
    end.hello()
    await turn()
    const answered: Outcome[] = []
    join(end.window, desk().port).ask('x', 'ASK', {}, () => {}, (outcome) => { answered.push(outcome) })
    await turn()
    // The ask was taken, so no `taken` is owed: an answer is.
    end.sides[0]!.bare.send(JSON.stringify([{ taken: 1 }]))
    await turn()
    await advance(WINDOW / 2)
    expect(asks(end.said())).toEqual([{ there: 1 }])
    end.sides[0]!.bare.send(JSON.stringify([{ seq: 1, frame: { kind: 'answer', id: 1, outcome: { ok: true, value: 1 } } satisfies Frame }]))
    await turn()
    expect(answered).toHaveLength(1)
    const before = asks(end.said()).length
    await advance(100 * WINDOW)
    expect(asks(end.said()).length).toBe(before)
    expect(end.sides).toHaveLength(1)
  })
})

describe('an ask that is owed and then is not, with nothing arriving', () => {
  it('has nothing asked for it', async () => {
    const { clock, advance } = handClock()
    const end = watched(clock)
    end.hello()
    await turn()
    // Refused where it was made: owed for a moment, and then not, and nothing crosses.
    const ended: Outcome[] = []
    join(end.window, desk().port).ask('x', 'ASK', { big: 1n }, () => {}, (outcome) => { ended.push(outcome) })
    expect(ended).toHaveLength(1)
    await advance(100 * WINDOW)
    expect(asks(end.said())).toEqual([])
  })
})

describe('an end that is asked whether it is there', () => {
  it('says it is, with the same number', async () => {
    const [bare, right] = memoryPair()
    listen(right)
    const texts: unknown[][] = []
    bare.onData((message) => { texts.push(JSON.parse(message as string) as unknown[]) })
    bare.send(JSON.stringify([{ link: 1, session: 's', taken: 0 }, { there: 7 }]))
    await turn()
    await turn()
    expect(texts.flat()).toContainEqual({ here: 7 })
  })
})
