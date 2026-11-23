// Opening a connection again: on the clock the link is handed and never without one, waiting longer for each
// connection in a row that did not hold, and at once after one that did.
import { describe, expect, it } from 'vitest'
import { link, timers, type Clock, type Message, type Transport } from '../src/index.ts'

/** A clock the spec moves: what falls due as it is moved on runs, in the order it falls due. */
const moved = () => {
  let at = 0
  const waiting = new Set<{ readonly due: number; readonly run: () => void }>()
  const clock: Clock = {
    after: (ms, run) => {
      const timer = { due: at + ms, run }
      waiting.add(timer)
      return () => { waiting.delete(timer) }
    },
  }
  return {
    clock,
    waiting: () => waiting.size,
    pass: (ms: number): void => {
      const until = at + ms
      for (;;) {
        const next = [...waiting].filter((timer) => timer.due <= until).sort((x, y) => x.due - y.due)[0]
        if (!next) break
        waiting.delete(next)
        at = next.due
        next.run()
      }
      at = until
    },
  }
}

/** What opens connections the spec holds the other end of: it says when each closes, and what arrives on it. */
const dialled = () => {
  const made: Array<{ close(): void; hello(): void }> = []
  const open = (): Transport => {
    let closes: (() => void) | undefined
    let hears: ((message: Message) => void) | undefined
    made.push({
      close: () => { closes?.() },
      hello: () => { hears?.(JSON.stringify([{ link: 1, session: 'backend', taken: 0}])) },
    })
    return { send: () => {}, onData: (heard) => { hears = heard }, onClose: (closed) => { closes = closed }, close: () => {} }
  }
  return { open, made }
}

/** The latest connection closes, and the next is opened when exactly `wait` has passed, not before. */
const closesAndWaits = (made: ReadonlyArray<{ close(): void }>, pass: (ms: number) => void, wait: number): void => {
  const before = made.length
  made.at(-1)!.close()
  expect(made).toHaveLength(before)
  if (wait > 0) {
    pass(wait - 1)
    expect([wait, made.length]).toEqual([wait, before])
    pass(1)
  } else pass(0)
  expect([wait, made.length]).toEqual([wait, before + 1])
}

describe('a link that opens its own connections', () => {
  it('is not made without a clock to open them on, and opens nothing', () => {
    const { open, made } = dialled()
    expect(() => link(open as never)).toThrow(TypeError)
    expect(() => link(open as never, {})).toThrow(TypeError)
    expect(made).toHaveLength(0)
  })

  it('waits longer for each connection in a row that met nobody, up to the most', () => {
    const { clock, pass } = moved()
    const { open, made } = dialled()
    link(open, { reopen: { clock, first: 100, most: 1000 } })
    for (const wait of [100, 200, 400, 800, 1000, 1000, 1000]) closesAndWaits(made, pass, wait)
  })

  it('waits a tenth of a second first and ten seconds at most, unless told', () => {
    const { clock, pass } = moved()
    const { open, made } = dialled()
    link(open, { reopen: { clock } })
    for (const wait of [100, 200, 400, 800, 1600, 3200, 6400, 10_000, 10_000]) closesAndWaits(made, pass, wait)
  })

  it('opens the next at once after a connection that held, and starts the count over', () => {
    const { clock, pass } = moved()
    const { open, made } = dialled()
    link(open, { reopen: { clock } })
    closesAndWaits(made, pass, 100)
    closesAndWaits(made, pass, 200)
    // Met, and up for as long as the wait before it: it has held.
    made.at(-1)!.hello()
    pass(200)
    closesAndWaits(made, pass, 0)
    closesAndWaits(made, pass, 100)
  })

  it('counts a connection that met the other end and went before it had held as one more that did not', () => {
    const { clock, pass } = moved()
    const { open, made } = dialled()
    link(open, { reopen: { clock } })
    // An end that says hello and goes, every time, is dialled no faster than one that is not there.
    for (const wait of [100, 200, 400]) {
      made.at(-1)!.hello()
      closesAndWaits(made, pass, wait)
    }
    // One short of as long as the wait before it.
    made.at(-1)!.hello()
    pass(399)
    closesAndWaits(made, pass, 800)
    // The first connection of all holds once it has been up for the first wait.
    const fresh = dialled()
    link(fresh.open, { reopen: { clock } })
    fresh.made[0]!.hello()
    pass(99)
    closesAndWaits(fresh.made, pass, 100)
  })

  it('does not take a connection to have held because it stayed up without the other end being met', () => {
    const { clock, pass } = moved()
    const { open, made } = dialled()
    link(open, { reopen: { clock } })
    pass(60_000)
    closesAndWaits(made, pass, 100)
  })

  it('opens nothing more once it has closed, and waits on nothing', () => {
    const { clock, pass, waiting } = moved()
    const { open, made } = dialled()
    const a = link(open, { reopen: { clock } })
    made[0]!.close()
    expect(waiting()).toBe(1)
    a.close()
    expect(waiting()).toBe(0)
    pass(60_000)
    expect(made).toHaveLength(1)
    // Nor while a connection it was finding out about is up.
    const held = dialled()
    const b = link(held.open, { reopen: { clock } })
    held.made[0]!.hello()
    expect(waiting()).toBe(1)
    b.close()
    expect(waiting()).toBe(0)
  })

  it('is handed a connection in place of the one it was waiting to open', () => {
    const { clock, pass, waiting } = moved()
    const { open, made } = dialled()
    const a = link(open, { reopen: { clock } })
    made[0]!.close()
    a.carry(dialled().open())
    expect(waiting()).toBe(0)
    pass(60_000)
    expect(made).toHaveLength(1)
  })

  it('counts what could not be opened as a connection that did not hold, and hands on what was thrown', () => {
    const { clock, pass } = moved()
    const { open, made } = dialled()
    const thrown: unknown[] = []
    let refusing = false
    link(() => { if (refusing) throw new Error('refused'); return open() }, { reopen: { clock }, thrown: (error) => { thrown.push(error) } })
    refusing = true
    made[0]!.close()
    // Refused after 100 and again after 200 more: the next is tried 400 after that.
    pass(300)
    expect(thrown).toEqual([new Error('refused'), new Error('refused')])
    refusing = false
    pass(399)
    expect(made).toHaveLength(1)
    pass(1)
    expect(made).toHaveLength(2)
  })
})

describe('the clock on timers', () => {
  it('runs what it is asked to, later, and not what was called off first', async () => {
    const ran: string[] = []
    timers.after(0, () => { ran.push('first') })
    timers.after(0, () => { ran.push('called off') })()
    expect(ran).toEqual([])
    await new Promise<void>((resolve) => { timers.after(1, resolve) })
    expect(ran).toEqual(['first'])
  })
})
