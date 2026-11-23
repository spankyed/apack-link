import { describe, expect, it } from 'vitest'
import { accept, dial, memoryPair, type Clock, type Ending, type Link, type Message, type Transport } from '../src/index.ts'
import { everyOrder, holds, laneClock, same, sample, type Schedule } from '../src/testing/index.ts'

const turn = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })
/** A clock that keeps no time: what is asked for runs a turn later, however long was asked for. */
const turns: Clock = { after: (_, run) => { let off = false; setImmediate(() => { if (!off) run() }); return () => { off = true } } }
const until = async (done: () => boolean): Promise<void> => { while (!done()) await turn() }
const rest = async (): Promise<void> => { for (let i = 0; i < 20; i++) await turn() }

/** A backend that keeps, in order, each session it was handed and each one that ended, by whose it was. */
const backend = () => {
  const told: string[] = []
  const links: Link[] = []
  const taking = accept<string>((link, owner) => {
    const name = `${owner} ${links.push(link)}`
    told.push(`began ${name}`)
    link.onEnd((ending) => { told.push(`ended ${name}: ${ending.why}`) })
  })
  return { ...taking, told, links }
}
type Backend = ReturnType<typeof backend>

/** A window: an end that dials, each of its connections taken as `owner(n)` says the nth is. */
const window = (at: Backend, owner: (connection: number) => string) => {
  const ended: Ending[] = []
  let connections = 0
  let current: Transport | undefined
  const link = dial(() => {
    const [left, right] = memoryPair()
    current = left
    at.take(right, owner(++connections))
    return left
  }, { reopen: { clock: turns } })
  link.onEnd((ending) => { ended.push(ending) })
  return { link, ended, drop: () => { current!.close() }, get connections() { return connections } }
}

describe('a session has an owner', () => {
  it('hands a new session over with whose it is', async () => {
    const at = backend()
    window(at, () => 'a')
    window(at, () => 'b')
    await until(() => at.told.length === 2)
    expect(at.told).toEqual(['began a 1', 'began b 2'])
  })

  it('is gone on with by its owner, on another connection', async () => {
    const at = backend()
    const a = window(at, () => 'a')
    await until(() => at.told.length === 1)
    a.drop()
    await until(() => a.connections === 2)
    await rest()
    expect(at.told).toEqual(['began a 1'])
    expect(a.ended).toEqual([])
  })

  it('is not gone on with by another owner: that one is told it is lost, and the session ends for nobody', async () => {
    const at = backend()
    // Its second connection is taken as somebody else's, saying the session it began as `a`.
    const a = window(at, (connection) => (connection === 1 ? 'a' : 'b'))
    await until(() => at.told.length === 1)
    a.drop()
    await until(() => a.ended.length === 1)
    await rest()
    expect(a.ended).toEqual([{ why: 'lost' }])
    expect(at.told).toEqual(['began a 1'])
  })

  it('ends the session an owner had when the owner begins another, before the new one is handed over', async () => {
    const at = backend()
    const before = window(at, () => 'a')
    await until(() => at.told.length === 1)
    window(at, () => 'a')
    await until(() => before.ended.length === 1)
    expect(at.told).toEqual(['began a 1', 'ended a 1: closed', 'began a 2'])
    // It is told not to come back, and opens nothing more.
    expect(before.ended).toEqual([{ why: 'goodbye', bye: 'ended' }])
    await rest()
    expect(before.connections).toBe(1)
  })

  it('keeps the session an owner has when a connection of its says one it had before', async () => {
    const at = backend()
    const before = window(at, () => 'a')
    await until(() => at.told.length === 1)
    // The page it was is still dialling as the new one begins: it is cut off, and comes back saying the old session.
    const [left, right] = memoryPair()
    const heard: Message[] = []
    left.onData((message) => { heard.push(message) })
    at.take(right, 'a')
    left.send(JSON.stringify([{ link: 1, session: 'one it had before', taken: 3, resumes: 'whatever' }]))
    await rest()
    expect(JSON.parse(heard[0] as string)[1]).toEqual({ lost: true })
    expect(at.told).toEqual(['began a 1'])
    expect(before.ended).toEqual([])
  })

  it('ends an owner\'s session when the host says the owner is gone, and leaves every other owner\'s', async () => {
    const at = backend()
    const a = window(at, () => 'a')
    const b = window(at, () => 'b')
    await until(() => at.told.length === 2)
    at.gone('a')
    await until(() => a.ended.length === 1)
    await rest()
    expect(a.ended).toEqual([{ why: 'goodbye', bye: 'ended' }])
    expect(at.told).toEqual(['began a 1', 'began b 2', 'ended a 1: closed'])
    expect(b.ended).toEqual([])
    expect(a.connections).toBe(1)
  })

  it('closes every connection of an owner that is gone, one that has said nothing included', async () => {
    const at = backend()
    const [left, right] = memoryPair()
    let closed = false
    left.onClose(() => { closed = true })
    at.take(right, 'a')
    at.gone('a')
    await rest()
    expect(closed).toBe(true)
    expect(at.told).toEqual([])
  })

  it('makes no session of what a connection says after its owner is gone', async () => {
    const at = backend()
    // What carries it hands over what had already arrived, after it was closed.
    let hear: (message: Message) => void = () => {}
    let closes = 0
    at.take({ send: () => {}, onData: (heard) => { hear = heard }, onClose: () => {}, close: () => { closes++ } }, 'a')
    at.gone('a')
    hear(JSON.stringify([{ link: 1, session: 'late', taken: 0 }]))
    // Said again, there is nothing of the owner left to close.
    at.gone('a')
    expect(closes).toBe(1)
    expect(at.told).toEqual([])
  })

  it('closes no connection that closed by itself', () => {
    const at = backend()
    let closed: () => void = () => {}
    let closes = 0
    at.take({ send: () => {}, onData: () => {}, onClose: (then) => { closed = then }, close: () => { closes++ } }, 'a')
    closed()
    at.gone('a')
    expect(closes).toBe(0)
  })

  it('tells an owner that goes on with a session the host closed that it is lost', async () => {
    const at = backend()
    const a = window(at, () => 'a')
    await until(() => at.told.length === 1)
    // Closed with no goodbye, the window is told nothing: it opens another connection, to go on.
    at.links[0]!.close()
    await until(() => a.ended.length === 1)
    expect(a.ended).toEqual([{ why: 'lost' }])
    expect(at.told).toEqual(['began a 1', 'ended a 1: closed'])
  })

  it('begins no session for an owner said to be gone as the one it had ended', async () => {
    const told: string[] = []
    const taking = accept<string>((link, owner) => {
      told.push(`began ${owner}`)
      link.onEnd(() => { taking.gone(owner) })
    })
    const at = { ...taking, told, links: [] }
    window(at, () => 'a')
    await until(() => told.length === 1)
    const [left, right] = memoryPair()
    let closed = false
    left.onClose(() => { closed = true })
    taking.take(right, 'a')
    left.send(JSON.stringify([{ link: 1, session: 'another', taken: 0 }]))
    await rest()
    expect(closed).toBe(true)
    expect(told).toEqual(['began a'])
  })

  it('keeps nothing of an owner that is gone: taken again, it is one met for the first time', async () => {
    const at = backend()
    const before = window(at, () => 'a')
    await until(() => at.told.length === 1)
    at.gone('a')
    at.gone('a')
    at.gone('nobody')
    await until(() => before.ended.length === 1)
    const after = window(at, () => 'a')
    await until(() => at.told.length === 3)
    await rest()
    expect(at.told).toEqual(['began a 1', 'ended a 1: closed', 'began a 2'])
    expect(after.ended).toEqual([])
  })

  it('lets an owner whose session ended by itself begin another, ending nothing twice', async () => {
    const at = backend()
    const before = window(at, () => 'a')
    await until(() => at.told.length === 1)
    before.link.close('ended')
    await until(() => at.told.length === 2)
    window(at, () => 'a')
    await until(() => at.told.length === 3)
    await rest()
    expect(at.told).toEqual(['began a 1', 'ended a 1: goodbye', 'began a 2'])
  })

  it('throws for a connection that takes no message as long as a link needs, having closed it', () => {
    const at = backend()
    let closes = 0
    expect(() => { at.take({ send: () => {}, onData: () => {}, onClose: () => {}, close: () => { closes++ }, most: 16 }, 'a') }).toThrow(RangeError)
    expect(closes).toBe(1)
    // Nothing of it is kept to be closed again.
    at.gone('a')
    expect(closes).toBe(1)
  })
})

/**
 * A window that does each of `does` in turn (drops its connection, reloads) and is then destroyed, and a host that
 * says it is gone once it was, each at any moment. No more sessions are kept than there are owners not gone, never
 * two for one owner, and none ends that its owner could still go on with.
 */
const comeAndGo = (does: ReadonlyArray<'drops' | 'reloads'>) => (schedule: Schedule) => {
  /** Each session the backend was handed and has not seen end. */
  const kept: Link[] = []
  let said = false
  /** Whether a hello is being taken: a session that ends then ended for the one that follows. */
  let taking = false
  let wrongly = 0
  const backend = accept<string>((link) => {
    kept.push(link)
    holds(!said, 'a session began for an owner said to be gone')
    holds(kept.length === 1, `an owner has one session, and has ${kept.length}`)
    link.onEnd(() => {
      kept.splice(kept.indexOf(link), 1)
      if (!said && !taking) wrongly++
    })
  })
  let pages = 0
  const page = () => {
    const lanes = [{ label: `page ${++pages} to backend` }, { label: `backend to page ${pages}` }] as const
    let current: Transport | undefined
    const link = dial(() => {
      const [left, right] = memoryPair((run) => schedule.later(lanes[0], run), (run) => schedule.later(lanes[1], run))
      current = left
      backend.take({ ...right, onData: (heard) => { right.onData((message) => { taking = true; try { heard(message) } finally { taking = false } }) } }, 'the window')
      return left
    }, { reopen: { clock: laneClock(schedule, lanes[0]) } })
    return { link, drop: () => { current!.close() } }
  }
  let now = page()
  const main = { label: 'main to backend' }
  schedule.does('the window',
    ...does.map((what) => [what, what === 'drops'
      ? () => { now.drop() }
      // The page it was goes, and with it what it dialled with: nothing says so to the backend.
      : () => { now.link.close(); now = page() }] as const),
    ['is destroyed', () => {
      now.link.close()
      schedule.later(main, () => { said = true; backend.gone('the window') })
    }],
  )
  return () => {
    same(wrongly, 0, 'sessions ended that their owner could still go on with')
    same(kept.length, 0, 'sessions kept for an owner that is gone')
  }
}

const named = (does: ReadonlyArray<string>): string => [...does, 'is destroyed'].join(', then ')

describe('an owner coming and going, under every order', () => {
  for (const does of [[], ['drops'], ['reloads']] as const) {
    it(`keeps one session at most, none once it is gone, and ends none it could go on with: ${named(does)}`, async () => {
      expect(await everyOrder(comeAndGo(does), { limit: 2_000_000 })).toBeGreaterThan(1)
    }, 600_000)
  }
})

// Two things done before it is destroyed are more orders than can all be run.
describe('an owner coming and going, under orders drawn from a seed', () => {
  for (const does of [['drops', 'reloads'], ['reloads', 'drops'], ['reloads', 'reloads']] as const) {
    it(`keeps one session at most, none once it is gone, and ends none it could go on with: ${named(does)}`, async () => {
      const ran = await sample(comeAndGo(does), { seed: 23, runs: 20_000 })
      expect(ran.failure).toBeUndefined()
    }, 600_000)
  }
})
