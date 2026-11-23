// Opening a connection again: never in the turn the last one closed in, on a clock the link is handed when it has
// one, waiting longer for each connection in a row that met nobody, and on none of its own.
import { describe, expect, it } from 'vitest'
import { link, type Clock, type Message, type Transport } from '../src/index.ts'

const turn = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })
const until = async (done: () => boolean): Promise<void> => { while (!done()) await turn() }

/** A clock that notes how long it was asked to wait, and waits until the spec says. */
const notedClock = () => {
  const asked: number[] = []
  let waiting: (() => void) | undefined
  let calledOff = 0
  const clock: Clock = {
    after: (ms, run) => {
      asked.push(ms)
      waiting = run
      return () => { if (waiting === run) { waiting = undefined; calledOff++ } }
    },
  }
  return { clock, asked, calledOff: () => calledOff, pending: () => waiting !== undefined, pass: () => { const run = waiting; waiting = undefined; run?.() } }
}

/** What opens connections the spec holds the other end of: it says when each closes, and what arrives on it. */
const dialled = () => {
  const made: Array<{ close(): void; hello(): void; closed: number }> = []
  const open = (): Transport => {
    let closes: (() => void) | undefined
    let hears: ((message: Message) => void) | undefined
    const one = {
      closed: 0,
      close: () => { closes?.() },
      hello: () => { hears?.(JSON.stringify([{ link: 1, session: 'backend', taken: 0 }])) },
    }
    made.push(one)
    return { send: () => {}, onData: (heard) => { hears = heard }, onClose: (closed) => { closes = closed }, close: () => { one.closed++ } }
  }
  return { open, made }
}

describe('a link with a clock to open again on', () => {
  it('waits longer for each connection in a row that met nobody, up to the most, and starts over once it meets one', () => {
    const { clock, asked, pass } = notedClock()
    const { open, made } = dialled()
    link(open, { reopen: { clock, first: 100, most: 1000 } })
    for (let failed = 0; failed < 7; failed++) {
      made.at(-1)!.close()
      // Nothing is opened until the clock says.
      expect(made).toHaveLength(failed + 1)
      pass()
      expect(made).toHaveLength(failed + 2)
    }
    expect(asked).toEqual([100, 200, 400, 800, 1000, 1000, 1000])
    // One on which the other end said hello: the next is opened with no wait, and the count starts over.
    made.at(-1)!.hello()
    made.at(-1)!.close()
    pass()
    made.at(-1)!.close()
    pass()
    made.at(-1)!.close()
    expect(asked.slice(7)).toEqual([0, 100, 200])
  })

  it('waits a tenth of a second first and ten seconds at most, unless told', () => {
    const { clock, asked, pass } = notedClock()
    const { open, made } = dialled()
    link(open, { reopen: { clock } })
    for (let failed = 0; failed < 10; failed++) { made.at(-1)!.close(); pass() }
    expect(asked).toEqual([100, 200, 400, 800, 1600, 3200, 6400, 10_000, 10_000, 10_000])
  })

  it('opens nothing more once it has closed, and calls the wait off', () => {
    const { clock, pass, calledOff } = notedClock()
    const { open, made } = dialled()
    const a = link(open, { reopen: { clock } })
    made[0]!.close()
    a.close()
    expect(calledOff()).toBe(1)
    pass()
    expect(made).toHaveLength(1)
  })

  it('is handed a connection in place of the one it was waiting to open', () => {
    const { clock, pass, pending } = notedClock()
    const { open, made } = dialled()
    const a = link(open, { reopen: { clock } })
    made[0]!.close()
    const handed = dialled()
    a.carry(handed.open())
    expect(pending()).toBe(false)
    pass()
    expect(made).toHaveLength(1)
  })

  it('counts what could not be opened as a connection that met nobody, and hands on what was thrown', () => {
    const { clock, asked, pass } = notedClock()
    const { open, made } = dialled()
    const thrown: unknown[] = []
    let refusing = false
    link(() => { if (refusing) throw new Error('refused'); return open() }, { reopen: { clock }, thrown: (error) => { thrown.push(error) } })
    refusing = true
    made[0]!.close()
    pass()
    pass()
    refusing = false
    pass()
    expect(asked).toEqual([100, 200, 400])
    expect(thrown).toEqual([new Error('refused'), new Error('refused')])
    expect(made).toHaveLength(2)
  })
})

describe('a link with no clock', () => {
  it('opens one connection a turn at most, however fast they close, and none once it has closed', async () => {
    let opened = 0
    // Each of the first fifty connections closes as soon as it is asked to say when it has: enough to tell a link
    // that opens them all in one turn, and an end to it for one that does.
    const a = link(() => {
      opened++
      return { send: () => {}, onData: () => {}, onClose: (closed) => { if (opened < 50) closed() }, close: () => {} }
    })
    expect(opened).toBe(1)
    // Everything a turn can still do without the event loop turning is done, and nothing more has been opened.
    for (let hop = 0; hop < 1000; hop++) await Promise.resolve()
    expect(opened).toBe(1)
    // It does go on opening, as turns pass.
    await until(() => opened >= 5)
    a.close()
    const before = opened
    for (let turns = 0; turns < 5; turns++) await turn()
    expect(opened).toBe(before)
  })
})
