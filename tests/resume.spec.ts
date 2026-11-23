import { describe, expect, it } from 'vitest'
import { accept, join, dial, listen, memoryPair, type Clock, type Ending, type Frame, type Link, type Message, type Outcome, type Transport } from '../src/index.ts'
import { asking, desk, droppingMemoryEnds, everyOrder, laneClock, resume, underModel, type Model, type Desk, type Schedule } from '../src/testing/index.ts'
import { msgpack } from './support/msgpack.ts'

describe('resuming, over memory', () => {
  for (const scenario of resume) {
    it(scenario.name, async () => {
      // When a connection is found to have held is one more thing in the order: a few of these are past everyOrder's usual limit.
      expect(await everyOrder((schedule) => underModel((held) => scenario.play(schedule, droppingMemoryEnds(schedule, { unreachable: scenario.unreachable ?? 0 }, held))), { limit: 500_000 })).toBeGreaterThan(1)
    }, 300_000)
  }
})

describe('resuming, over memory, in msgpack', () => {
  for (const scenario of resume) {
    it(scenario.name, async () => {
      expect(await everyOrder((schedule) => underModel((held) => scenario.play(schedule, droppingMemoryEnds(schedule, { codec: msgpack, unreachable: scenario.unreachable ?? 0 }, held)), { codec: msgpack }), { limit: 500_000 })).toBeGreaterThan(1)
    }, 300_000)
  }
})

describe('accepting connections', () => {
  const turn = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })
  /** A clock that keeps no time: what is asked for runs a turn later, however long was asked for. */
  const turns: Clock = { after: (_, run) => { let off = false; setImmediate(() => { if (!off) run() }); return () => { off = true } } }
  const until = async (done: () => boolean): Promise<void> => { while (!done()) await turn() }

  it('makes a link for a new session, and hands a known one back to its link', async () => {
    // The backend answers when it is asked, on whichever link it is handed.
    const backend = desk({ ask: (asked) => { asked.ended({ ok: true, value: asked.args }) } })
    const made: Link[] = []
    const take = accept((one) => { made.push(one); join(one, backend.port) })
    let current: Transport | undefined
    const window = dial(() => {
      const [left, right] = memoryPair()
      current = left
      take(right)
      return left
    }, { reopen: { clock: turns } })
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
    const window = dial(memoryPair()[0])
    void window
    const [left, right] = memoryPair()
    accept((one) => { made.push(one) })(right)
    const texts: unknown[] = []
    left.onData((text) => { texts.push(JSON.parse(text as string)) })
    // Having taken nothing is no better: it is going on with something this end never was.
    left.send(JSON.stringify([{ link: 1, session: 'from before', taken: 0, resumes: 'a backend from before' }]))
    await turn()
    expect(made).toEqual([])
    expect(texts).toEqual([[{ link: 1, session: expect.any(String), taken: 0 }, { lost: true }]])
  })

  for (const [what, said, answer] of [
    ['is not anything a link says', '[7]', []],
    ['is not a batch', '{ not json', []],
    ['is a frame with no hello before it', JSON.stringify([{ seq: 1, frame: { kind: 'tell', to: 'x', event: 1 } }]), []],
    ['is a hello of another link', JSON.stringify([{ link: 2, session: 'w', taken: 0 }]), [[{ link: 1, session: expect.any(String), taken: 0 }]]],
    ['is a first hello that says it took something', JSON.stringify([{ link: 1, session: 'w', taken: 2 }]), [[{ link: 1, session: expect.any(String), taken: 0 }, { lost: true }]]],
  ] as const) {
    it(`makes no link for a connection whose first word ${what}, and closes it`, async () => {
      const made: Link[] = []
      const [left, right] = memoryPair()
      accept((one) => { made.push(one) })(right)
      const texts: unknown[] = []
      let closed = 0
      left.onData((text) => { texts.push(JSON.parse(text as string)) })
      left.onClose(() => { closed++ })
      left.send(said)
      await turn()
      expect([made, closed]).toEqual([[], 1])
      // Told what it would otherwise wait to hear: which link this is, and that there is no session to go on with.
      expect(texts).toEqual(answer)
    })
  }

  it('keeps a window on its link when another connection says the window\'s session and a hello that does not fit', async () => {
    const backend = desk()
    const made: Link[] = []
    const ended: Ending[] = []
    const take = accept((one) => { made.push(one); one.onEnd((ending) => { ended.push(ending) }); join(one, backend.port) })
    const [left, right] = memoryPair()
    // What the window says first is its session: anything it connects to is told it.
    let session = ''
    take({ ...right, onData: (heard) => { right.onData((message) => { session ||= (JSON.parse(message as string) as Array<{ session: string }>)[0]!.session; heard(message) }) } })
    const window = dial(left)
    const windowEnded: Ending[] = []
    window.onEnd((ending) => { windowEnded.push(ending) })
    const toBackend = join(window, desk().port)
    await turn()
    for (const hello of [{ taken: 5 }, { taken: 0, resumes: 'a guess' }, { taken: 5, resumes: 'a guess' }]) {
      const [stranger, there] = memoryPair()
      let closed = 0
      stranger.onClose(() => { closed++ })
      take(there)
      stranger.send(JSON.stringify([{ link: 1, session, ...hello }, { seq: 1, frame: { kind: 'tell', to: 'x', event: 'from a stranger' } }]))
      await turn()
      expect(closed).toBe(1)
    }
    toBackend.tell('x', 'from the window')
    await turn()
    expect(backend.told.map((one) => one.event)).toEqual(['from the window'])
    expect([made.length, ended, windowEnded]).toEqual([1, [], []])
  })

  it('ends a window that comes back to a backend that does not know it, saying so', async () => {
    let take = accept(() => {})
    let current: Transport | undefined
    const window = dial(() => {
      const [left, right] = memoryPair()
      current = left
      take(right)
      return left
    }, { reopen: { clock: turns } })
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
  const dialling = (schedule: Schedule, held: Model, unreachable = 0) => {
    const there = { label: 'window to backend' }
    const back = { label: 'backend to window' }
    const backends: Desk[] = []
    const made: Link[] = []
    let take!: (transport: Transport) => void
    /** A backend from nothing: it knows no session from before. */
    const start = (): void => {
      const backend = desk({ ask: (asked) => { asked.ended({ ok: true, value: asked.args }) } })
      backends.push(backend)
      take = accept((one) => { made.push(one); join(held.end(one, `backend ${made.length}`), backend.port) })
    }
    start()
    let current: Transport | undefined
    let dials = 0
    const window = held.end(dial(() => {
      const [left, right] = memoryPair((run) => schedule.later(there, run), (run) => schedule.later(back, run))
      current = left
      if (++dials <= unreachable) right.close()
      else take(right)
      return left
    }, { reopen: { clock: laneClock(schedule, there) } }), 'window')
    const ended: Ending[] = []
    window.onEnd((ending) => { ended.push(ending) })
    const ask = asking(join(window, desk().port), 'x', 'ASK', 'one')
    return { ended, ask, backends, made, start, drop: () => { current?.close() }, dials: () => dials }
  }

  it('a window that dials before its backend listens is answered once it does, once', async () => {
    await everyOrder((schedule) => underModel((held) => {
      const { ended, ask, backends, made, dials } = dialling(schedule, held, 2)
      return () => {
        expect(ended).toEqual([])
        expect(ask.ended).toEqual([{ ok: true, value: 'one' }])
        expect(backends[0]!.asks).toHaveLength(1)
        expect([dials(), made.length]).toEqual([3, 1])
      }
    }))
  })

  it('a connection that drops at any moment, a hello of either end lost with it, is picked up: the ask is answered once', async () => {
    const orderings = await everyOrder((schedule) => underModel((held) => {
      const { ended, ask, backends, made, drop } = dialling(schedule, held)
      schedule.does('the network', ['drops', drop])
      return () => {
        expect(ended).toEqual([])
        expect(ask.ended).toEqual([{ ok: true, value: 'one' }])
        expect(backends[0]!.asks).toHaveLength(1)
        expect(made).toHaveLength(1)
      }
    }))
    expect(orderings).toBeGreaterThan(1)
  })

  it('a backend that restarts at any moment is asked at most once, old and new together, and a window that had met the old one is lost', async () => {
    const outcomes = new Set<string>()
    // The old backend goes without closing its links, as a process does: a window lost for it is lost with every link still there.
    await everyOrder((schedule) => underModel((held) => {
      const { ended, ask, backends, start, drop } = dialling(schedule, held)
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
    }, { may: ['lost'], unfinished: true }))
    // Every way it can go is one of these, and each of them comes about in some order.
    expect([...outcomes].sort()).toEqual(['lost, asked 1 and 0, answered', 'lost, asked 1 and 0, not answered', 'went on, asked 0 and 1, answered'])
  })
})

describe('a hello', () => {
  const turn = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })
  /** A link handed connections, facing a bare end that says what the spec has it say. */
  const handed = () => {
    const backend = listen()
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

  it('says nothing on a connection until a hello has arrived on it, and then which session it is going on with', async () => {
    const { connect } = handed()
    const first = connect()
    await turn()
    expect(first.texts).toEqual([])
    first.say({ link: 1, session: 'w', taken: 0 })
    await turn()
    // It had met nobody when it answered.
    expect(first.texts).toEqual([[{ link: 1, session: expect.any(String), taken: 0 }]])
    first.bare.close()
    await turn()
    const second = connect()
    await turn()
    expect(second.texts).toEqual([])
    second.say({ link: 1, session: 'w', taken: 0, resumes: session(first.texts) })
    await turn()
    expect(second.texts).toEqual([[{ link: 1, session: session(first.texts), taken: 0, resumes: 'w' }]])
  })

  it('from an end that never heard this one answer is gone on with: what it has not taken is sent again, in order', async () => {
    const { backend, ended, heard, connect } = handed()
    const first = connect()
    first.say({ link: 1, session: 'w', taken: 0 })
    backend.send({ kind: 'tell', to: 'x', event: 'not heard' })
    await turn()
    // The first connection went before anything of this end's arrived: the other end has met nobody, and says so.
    first.bare.close()
    await turn()
    const second = connect()
    second.say({ link: 1, session: 'w', taken: 0 })
    await turn()
    second.say({ seq: 1, frame: { kind: 'tell', to: 'y', event: 'from w' } })
    await turn()
    expect(ended).toEqual([])
    expect(heard).toEqual([{ kind: 'tell', to: 'y', event: 'from w' }])
    expect(second.texts.flat()).toEqual([
      { link: 1, session: session(first.texts), taken: 0, resumes: 'w' },
      { seq: 1, frame: { kind: 'tell', to: 'x', event: 'not heard' } },
      { taken: 1 },
    ])
  })
})

describe('a link handed a connection while it is on one where the other end has been met', () => {
  const turn = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })
  const tell = (event: unknown): Frame => ({ kind: 'tell', to: 'x', event })
  /** A link handed connections, met on a first one, with what it hears and how it ends. */
  const met = async () => {
    const backend = listen()
    const ended: Ending[] = []
    const heard: Frame[] = []
    backend.onEnd((ending) => { ended.push(ending) })
    backend.onFrame((frame) => { heard.push(frame) })
    const connect = () => {
      const [bare, there] = memoryPair()
      const texts: unknown[][] = []
      let closed = 0
      bare.onData((text) => { texts.push(JSON.parse(text as string) as unknown[]) })
      bare.onClose(() => { closed++ })
      backend.carry(there)
      return { bare, texts, closed: () => closed, say: (...said: unknown[]) => { bare.send(JSON.stringify(said)) } }
    }
    const first = connect()
    first.say({ link: 1, session: 'w', taken: 0 })
    await turn()
    const mine = (first.texts[0]![0] as { session: string }).session
    return { backend, ended, heard, connect, first, mine }
  }

  it('says nothing on the new one, and goes on taking and sending on the one it has, until a hello arrives on the new one', async () => {
    const { backend, ended, heard, connect, first } = await met()
    const second = connect()
    first.say({ seq: 1, frame: tell('on the first') })
    backend.send(tell('to the first'))
    await turn()
    expect(second.texts).toEqual([])
    expect(heard).toEqual([tell('on the first')])
    expect(first.texts.flat()).toContainEqual({ seq: 1, frame: tell('to the first') })
    expect([ended, first.closed(), second.closed()]).toEqual([[], 0, 0])
  })

  it('goes over to the new one when a hello that fits arrives on it: what the other end has not taken is sent again there, once, and nothing is taken twice', async () => {
    const { backend, ended, heard, connect, first, mine } = await met()
    first.say({ seq: 1, frame: tell('taken on the first') })
    backend.send(tell('not taken'))
    await turn()
    const second = connect()
    second.say({ link: 1, session: 'w', taken: 0, resumes: mine }, { seq: 2, frame: tell('on the second') })
    await turn()
    expect(first.closed()).toBe(1)
    expect(heard).toEqual([tell('taken on the first'), tell('on the second')])
    // Its hello there says what it had taken by then, the first connection's frame included.
    expect(second.texts.flat()).toEqual([
      { link: 1, session: mine, taken: 1, resumes: 'w' },
      { seq: 1, frame: tell('not taken') },
      { taken: 2 },
    ])
    expect(ended).toEqual([])
  })

  for (const [what, hello, told] of [
    ['from another session', { link: 1, session: 'another window', taken: 0 }, true],
    ['going on with a session that is not this one', { link: 1, session: 'w', taken: 0, resumes: 'another backend' }, true],
    ['that says it took what was never sent', { link: 1, session: 'w', taken: 7, resumes: 'MINE' }, true],
    ['that has met nobody and says it took something', { link: 1, session: 'w', taken: 1 }, true],
    ['of another link', { link: 2, session: 'w', taken: 0 }, 'which link'],
    ['that takes no message as long as a frame may be', { link: 1, session: 'w', taken: 0, resumes: 'MINE', most: 1000 }, true],
    ['that is not a hello', { seq: 1, frame: { kind: 'tell', to: 'x', event: 'unannounced' } }, false],
    ['that is not anything a link says', 7, false],
  ] as const) {
    it(`turns the new one away for a hello ${what}, and goes on as it was on the one it has`, async () => {
      const { backend, ended, heard, connect, first, mine } = await met()
      const second = connect()
      second.say(typeof hello === 'object' && 'resumes' in hello && hello.resumes === 'MINE' ? { ...hello, resumes: mine } : hello, { seq: 1, frame: tell('from whoever it is') })
      await turn()
      expect(second.closed()).toBe(1)
      // Told the session is lost where it would otherwise wait on it, behind a hello that names no session;
      // another link, which link this is, so that it ends saying both; and what is not a link's, nothing.
      const named = { link: 1, session: '', taken: 0 }
      expect(second.texts).toEqual(told === true ? [[named, { lost: true }]] : told ? [[named]] : [])
      // Nothing of the session it is in: not its own, and not the one it talks to.
      expect(JSON.stringify(second.texts)).not.toMatch(new RegExp(`${mine}|"w"`))
      first.say({ seq: 1, frame: tell('on the first') })
      backend.send(tell('to the first'))
      await turn()
      expect(heard).toEqual([tell('on the first')])
      expect(first.texts.flat()).toContainEqual({ seq: 1, frame: tell('to the first') })
      expect([ended, first.closed()]).toEqual([[], 0])
    })
  }

  it('says what it took once on the one it goes over to, in its hello, when nothing more has arrived', async () => {
    const { connect, first, mine } = await met()
    first.say({ seq: 1, frame: tell('taken on the first') })
    await turn()
    const second = connect()
    second.say({ link: 1, session: 'w', taken: 0, resumes: mine })
    await turn()
    expect(second.texts).toEqual([[{ link: 1, session: mine, taken: 1, resumes: 'w' }]])
  })

  it('turns away a hello that fits in every way but one, when it has sent and been told what was taken', async () => {
    for (const [what, hello] of [
      ['says it has met nobody and took something that was sent', { taken: 3 }],
      ['wants what it said before it had taken', { taken: 1, resumes: 'MINE' }],
      ['says it took more than was sent', { taken: 5, resumes: 'MINE' }],
    ] as const) {
      const { backend, ended, connect, first, mine } = await met()
      for (const event of [1, 2, 3, 4]) backend.send(tell(event))
      await turn()
      first.say({ taken: 2 })
      await turn()
      expect([what, backend.kept()]).toEqual([what, 2])
      const second = connect()
      second.say({ link: 1, session: 'w', ...hello, ...('resumes' in hello ? { resumes: mine } : {}) })
      await turn()
      expect([what, second.closed(), second.texts.flat().at(-1), ended, first.closed(), backend.kept()]).toEqual([what, 1, { lost: true }, [], 0, 2])
      // One that says what is so is gone over to.
      const third = connect()
      third.say({ link: 1, session: 'w', taken: 3, resumes: mine })
      await turn()
      expect([what, third.closed(), first.closed(), backend.kept()]).toEqual([what, 0, 1, 1])
    }
  })

  it('keeps only the last it was handed waiting', async () => {
    const { connect, first, mine } = await met()
    const second = connect()
    const third = connect()
    await turn()
    expect([second.closed(), third.closed()]).toEqual([1, 0])
    third.say({ link: 1, session: 'w', taken: 0, resumes: mine })
    await turn()
    expect(first.closed()).toBe(1)
    expect(third.texts).toEqual([[{ link: 1, session: mine, taken: 0, resumes: 'w' }]])
  })

  it('closes the one that waits when it closes', async () => {
    const { backend, connect } = await met()
    const second = connect()
    backend.close()
    await turn()
    expect(second.closed()).toBe(1)
  })
})

describe('a link handed connections, on one where nobody has been met', () => {
  const turn = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })
  const tell = (event: unknown): Frame => ({ kind: 'tell', to: 'x', event })
  /** A link handed a connection, and the bare other end of it. */
  const handedOne = () => {
    const backend = listen()
    const ended: Ending[] = []
    const heard: Frame[] = []
    backend.onEnd((ending) => { ended.push(ending) })
    backend.onFrame((frame) => { heard.push(frame) })
    const [bare, there] = memoryPair()
    const texts: unknown[] = []
    let closed = 0
    bare.onData((text) => { texts.push(...JSON.parse(text as string) as unknown[]) })
    bare.onClose(() => { closed++ })
    backend.carry(there)
    return { backend, ended, heard, bare, texts, closed: () => closed }
  }

  for (const [what, said, told] of [
    ['a hello going on with a session that is not this one', JSON.stringify([{ link: 1, session: 'w', taken: 0, resumes: 'another backend' }]), true],
    ['a hello that says it took something, from an end that has met nobody', JSON.stringify([{ link: 1, session: 'w', taken: 3 }]), true],
    ['a hello of another link', JSON.stringify([{ link: 2, session: 'w', taken: 0 }]), false],
    ['something that is not a hello', JSON.stringify([{ seq: 1, frame: { kind: 'tell', to: 'x', event: 'unannounced' } }]), false],
    ['something that is not anything a link says', '[7]', false],
    ['text that is not a batch', '{ not json', false],
  ] as const) {
    it(`turns the connection away for ${what}, and is there for the next`, async () => {
      const { backend, ended, heard, bare, texts, closed } = handedOne()
      bare.send(said)
      await turn()
      expect([closed(), ended, heard]).toEqual([1, [], []])
      expect(texts.some((one) => typeof one === 'object' && one !== null && 'lost' in one)).toBe(told)
      // Whoever it does talk to is taken as ever.
      const [window, next] = memoryPair()
      backend.carry(next)
      window.send(JSON.stringify([{ link: 1, session: 'w', taken: 0 }, { seq: 1, frame: tell('from its window') }]))
      await turn()
      expect([ended, heard]).toEqual([[], [tell('from its window')]])
    })
  }
})

describe('an end that opened the connection', () => {
  const turn = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })

  for (const [what, said, ending] of [
    ['from another session than the one it was talking to', { link: 1, session: 'another backend', taken: 0, resumes: 'MINE' }, { why: 'lost' }],
    ['going on with a session that is not this one', { link: 1, session: 'backend', taken: 0, resumes: 'another window' }, { why: 'lost' }],
    ['that says it took what was never sent', { link: 1, session: 'backend', taken: 7, resumes: 'MINE' }, { why: 'lost' }],
    ['of another link', { link: 2, session: 'backend', taken: 0 }, { why: 'version', mine: 1, theirs: 2 }],
  ] as const) {
    it(`ends for a hello ${what}, on a connection after its first`, async () => {
      const bares: Array<{ bare: Transport; texts: unknown[] }> = []
      const waits: Array<() => void> = []
      const window = dial(() => {
        const [left, bare] = memoryPair()
        const texts: unknown[] = []
        bare.onData((text) => { texts.push(...JSON.parse(text as string) as unknown[]) })
        bares.push({ bare, texts })
        return left
      }, { reopen: { clock: { after: (_, run) => { waits.push(run); return () => {} } } } })
      const ended: Ending[] = []
      window.onEnd((end) => { ended.push(end) })
      bares[0]!.bare.send(JSON.stringify([{ link: 1, session: 'backend', taken: 0 }]))
      await turn()
      const mine = (bares[0]!.texts[0] as { session: string }).session
      bares[0]!.bare.close()
      await turn()
      waits.at(-1)!()
      bares[1]!.bare.send(JSON.stringify(['resumes' in said && said.resumes === 'MINE' ? { ...said, resumes: mine } : said]))
      await turn()
      expect(ended).toEqual([ending])
      expect(bares[1]!.texts.some((one) => typeof one === 'object' && one !== null && 'lost' in one)).toBe(ending.why === 'lost')
    })
  }
})

describe('a link handed connections', () => {
  const turn = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })

  it('takes nothing from a connection it has been handed another in place of', async () => {
    const backend = listen()
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
