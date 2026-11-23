import { describe, expect, it } from 'vitest'
import { accept, join, link, memoryPair, type Ending, type Frame, type Link, type Message, type Outcome, type Transport } from '../src/index.ts'
import { asking, desk, droppingMemoryEnds, everyOrder, laneClock, resume, type Desk, type Schedule } from '../src/testing/index.ts'

describe('resuming, over memory', () => {
  for (const scenario of resume) {
    it(scenario.name, async () => {
      expect(await everyOrder((schedule) => scenario.play(schedule, droppingMemoryEnds(schedule, { unreachable: scenario.unreachable ?? 0 })))).toBeGreaterThan(1)
    })
  }
})

describe('accepting connections', () => {
  const turn = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })
  const until = async (done: () => boolean): Promise<void> => { while (!done()) await turn() }

  it('makes a link for a new session, and hands a known one back to its link', async () => {
    // The backend answers when it is asked, on whichever link it is handed.
    const backend = desk({ ask: (asked) => { asked.ended({ ok: true, value: asked.args }) } })
    const made: Link[] = []
    const take = accept((one) => { made.push(one); join(one, backend.port) })
    let current: Transport | undefined
    const window = link(() => {
      const [left, right] = memoryPair()
      current = left
      take(right)
      return left
    })
    const ended: Ending[] = []
    window.onEnd((ending) => { ended.push(ending) })
    const toBackend = join(window, desk().port)
    const answered: Outcome[] = []
    toBackend.ask('x', 'ASK', 'before', () => {}, (outcome) => { answered.push(outcome) })
    await until(() => answered.length === 1)
    current!.close()
    toBackend.ask('x', 'ASK', 'after', () => {}, (outcome) => { answered.push(outcome) })
    await until(() => answered.length === 2)
    expect(ended).toEqual([])
    expect(answered).toEqual([{ ok: true, value: 'before' }, { ok: true, value: 'after' }])
    expect(backend.asks.map((asked) => asked.args)).toEqual(['before', 'after'])
    expect(made).toHaveLength(1)
  })

  it('tells a connection that would go on with a session it does not know that the session is lost', async () => {
    const made: Link[] = []
    const window = link(memoryPair()[0])
    void window
    const [left, right] = memoryPair()
    accept((one) => { made.push(one) })(right)
    const texts: unknown[] = []
    left.onData((text) => { texts.push(JSON.parse(text as string)) })
    left.send(JSON.stringify([{ link: 1, session: 'from before', taken: 3, resumes: 'a backend from before' }]))
    await turn()
    expect(made).toEqual([])
    expect(texts).toEqual([[{ link: 1, session: expect.any(String), taken: 0 }, { lost: true }]])
  })

  it('ends a window that comes back to a backend that does not know it, saying so', async () => {
    let take = accept(() => {})
    let current: Transport | undefined
    const window = link(() => {
      const [left, right] = memoryPair()
      current = left
      take(right)
      return left
    })
    const ended: Ending[] = []
    window.onEnd((ending) => { ended.push(ending) })
    await turn()
    // The backend restarts: what accepts connections now knows nothing of before.
    take = accept(() => {})
    current!.close()
    await until(() => ended.length > 0)
    expect(ended).toEqual([{ why: 'lost' }])
  })
})

describe('a window and a backend that accepts, under every order', () => {
  /** A window that dials and a backend that accepts, each direction a lane; the first `unreachable` dials reach nobody. */
  const dialling = (schedule: Schedule, unreachable = 0) => {
    const there = { label: 'window to backend' }
    const back = { label: 'backend to window' }
    const backends: Desk[] = []
    const made: Link[] = []
    let take!: (transport: Transport) => void
    /** A backend from nothing: it knows no session from before. */
    const start = (): void => {
      const backend = desk({ ask: (asked) => { asked.ended({ ok: true, value: asked.args }) } })
      backends.push(backend)
      take = accept((one) => { made.push(one); join(one, backend.port) })
    }
    start()
    let current: Transport | undefined
    let dials = 0
    const window = link(() => {
      const [left, right] = memoryPair((run) => schedule.later(there, run), (run) => schedule.later(back, run))
      current = left
      if (++dials <= unreachable) right.close()
      else take(right)
      return left
    }, { reopen: { clock: laneClock(schedule, there) } })
    const ended: Ending[] = []
    window.onEnd((ending) => { ended.push(ending) })
    const ask = asking(join(window, desk().port), 'x', 'ASK', 'one')
    return { ended, ask, backends, made, start, drop: () => { current?.close() }, dials: () => dials }
  }

  it('a window that dials before its backend listens is answered once it does, once', async () => {
    await everyOrder((schedule) => {
      const { ended, ask, backends, made, dials } = dialling(schedule, 2)
      return () => {
        expect(ended).toEqual([])
        expect(ask.ended).toEqual([{ ok: true, value: 'one' }])
        expect(backends[0]!.asks).toHaveLength(1)
        expect([dials(), made.length]).toEqual([3, 1])
      }
    })
  })

  it('a connection that drops at any moment, a hello of either end lost with it, is picked up: the ask is answered once', async () => {
    const orderings = await everyOrder((schedule) => {
      const { ended, ask, backends, made, drop } = dialling(schedule)
      schedule.does('the network', ['drops', drop])
      return () => {
        expect(ended).toEqual([])
        expect(ask.ended).toEqual([{ ok: true, value: 'one' }])
        expect(backends[0]!.asks).toHaveLength(1)
        expect(made).toHaveLength(1)
      }
    })
    expect(orderings).toBeGreaterThan(1)
  })

  it('a backend that restarts at any moment is asked at most once, old and new together, and a window that had met the old one is lost', async () => {
    const outcomes = new Set<string>()
    await everyOrder((schedule) => {
      const { ended, ask, backends, start, drop } = dialling(schedule)
      schedule.does('the backend', ['restarts', () => { start(); drop() }])
      return () => {
        const asked = backends.map((backend) => backend.asks.length)
        expect(asked[0]! + asked[1]!).toBeLessThanOrEqual(1)
        expect(ask.ended).toHaveLength(1)
        if (ended.length) {
          expect(ended).toEqual([{ why: 'lost' }])
          expect(asked[1]).toBe(0)
        } else expect([ask.ended, asked]).toEqual([[{ ok: true, value: 'one' }], [0, 1]])
        outcomes.add(`${ended.length ? 'lost' : 'went on'}, asked ${asked.join(' and ')}, ${ask.ended[0]!.ok ? 'answered' : 'not answered'}`)
      }
    })
    // Every way it can go is one of these, and each of them comes about in some order.
    expect([...outcomes].sort()).toEqual(['lost, asked 1 and 0, answered', 'lost, asked 1 and 0, not answered', 'went on, asked 0 and 1, answered'])
  })
})

describe('a hello', () => {
  const turn = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })
  /** A link handed connections, facing a bare end that says what the spec has it say. */
  const handed = () => {
    const backend = link()
    const ended: Ending[] = []
    const heard: Frame[] = []
    backend.onEnd((ending) => { ended.push(ending) })
    backend.onFrame((frame) => { heard.push(frame) })
    const connect = () => {
      const [bare, there] = memoryPair()
      const texts: unknown[][] = []
      bare.onData((text) => { texts.push(JSON.parse(text as string) as unknown[]) })
      backend.carry(there)
      return { bare, texts, say: (...said: unknown[]) => { bare.send(JSON.stringify(said)) } }
    }
    return { backend, ended, heard, connect }
  }
  const session = (texts: unknown[][]): string => (texts[0]![0] as { session: string }).session

  it('says which session it is going on with once it has met one, and not before', async () => {
    const { connect } = handed()
    const first = connect()
    await turn()
    expect(first.texts).toEqual([[{ link: 1, session: expect.any(String), taken: 0 }]])
    first.say({ link: 1, session: 'w', taken: 0 })
    await turn()
    const second = connect()
    await turn()
    expect(second.texts).toEqual([[{ link: 1, session: session(first.texts), taken: 0, resumes: 'w' }]])
  })

  it('from an end going on with another session than this one is lost', async () => {
    const { ended, connect } = handed()
    const first = connect()
    first.say({ link: 1, session: 'w', taken: 0, resumes: 'another backend' })
    await turn()
    expect(ended).toEqual([{ why: 'lost' }])
    expect(first.texts.flat().at(-1)).toEqual({ lost: true })
  })

  it('from an end that has met nobody and says it took something is lost', async () => {
    const { backend, ended, connect } = handed()
    const first = connect()
    first.say({ link: 1, session: 'w', taken: 0 })
    await turn()
    backend.send({ kind: 'tell', to: 'x', event: 1 })
    await turn()
    const second = connect()
    second.say({ link: 1, session: 'w', taken: 1 })
    await turn()
    expect(ended).toEqual([{ why: 'lost' }])
  })

  it('that wants what it said before it had taken is lost: it is no longer kept', async () => {
    const { backend, ended, connect } = handed()
    const first = connect()
    first.say({ link: 1, session: 'w', taken: 0 })
    await turn()
    for (const event of [1, 2]) backend.send({ kind: 'tell', to: 'x', event })
    await turn()
    first.say({ taken: 2 })
    await turn()
    expect(backend.kept()).toBe(0)
    const second = connect()
    await turn()
    second.say({ link: 1, session: 'w', taken: 1, resumes: session(second.texts) })
    await turn()
    expect(ended).toEqual([{ why: 'lost' }])
  })

  it('from an end that met this one, to this one that never heard it, is gone on with: nothing is sent twice', async () => {
    const { backend, ended, heard, connect } = handed()
    // The first connection went before anything of the other end's arrived.
    const first = connect()
    await turn()
    backend.send({ kind: 'tell', to: 'x', event: 'waits to meet' })
    const second = connect()
    second.say({ link: 1, session: 'w', taken: 0, resumes: session(first.texts) }, { seq: 1, frame: { kind: 'tell', to: 'y', event: 'from w' } })
    await turn()
    expect(ended).toEqual([])
    expect(heard).toEqual([{ kind: 'tell', to: 'y', event: 'from w' }])
    expect(second.texts.flat()).toEqual([
      { link: 1, session: session(first.texts), taken: 0 },
      { seq: 1, frame: { kind: 'tell', to: 'x', event: 'waits to meet' } },
      { taken: 1 },
    ])
  })
})

describe('a link handed connections', () => {
  const turn = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })

  it('is lost when it is handed a connection from another session than the one it was talking to', async () => {
    const backend = link()
    const ended: Ending[] = []
    backend.onEnd((ending) => { ended.push(ending) })
    const [first, there] = memoryPair()
    link(first)
    backend.carry(there)
    await turn()
    // Another window, a new session, on the same link.
    const [second, there2] = memoryPair()
    link(second)
    backend.carry(there2)
    await turn()
    expect(ended).toEqual([{ why: 'lost' }])
  })

  it('takes nothing from a connection it has been handed another in place of', async () => {
    const backend = link()
    const heard: Frame[] = []
    backend.onFrame((frame) => { heard.push(frame) })
    // A connection that goes on handing over what arrives after it was closed.
    let hand: ((message: Message) => void) | undefined
    const stale: Transport = { send: () => {}, onData: (heard_) => { hand = heard_ }, onClose: () => {}, close: () => {} }
    backend.carry(stale)
    hand!(JSON.stringify([{ link: 1, session: 'w', taken: 0 }]))
    const [fresh, there] = memoryPair()
    backend.carry(there)
    fresh.send(JSON.stringify([{ link: 1, session: 'w', taken: 0 }]))
    await turn()
    hand!(JSON.stringify([{ seq: 1, frame: { kind: 'tell', to: 'x', event: 'stale' } }]))
    fresh.send(JSON.stringify([{ seq: 1, frame: { kind: 'tell', to: 'x', event: 'fresh' } }]))
    await turn()
    expect(heard).toEqual([{ kind: 'tell', to: 'x', event: 'fresh' }])
  })
})
