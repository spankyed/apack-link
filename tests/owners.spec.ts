import { once as eventOnce } from 'node:events'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { accept, dial, memoryPair, socket, timers, type Clock, type Ending, type Frame, type Link, type Message, type Transport } from '../src/index.ts'
import { auditIndependence, explore, type Schedule } from '@apackdev/orderings'
import { holds, laneClock, same, scheduledPair, trackedLink } from '../src/testing/index.ts'

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

  it('keeps nothing of a connection turned away even when its close does not fire onClose', () => {
    const at = backend()
    let onData: ((message: Message) => void) | undefined
    let closes = 0
    at.take({ send: () => {}, onData: (h) => { onData = h }, onClose: () => {}, close: () => { closes++; throw new Error('already shut') } }, 'a')
    onData!(JSON.stringify([7]))
    expect(closes).toBe(1)
    // Nothing more is heard on it, and gone does not close it again.
    onData!(JSON.stringify([{ link: 1, session: 'late', taken: 0 }]))
    at.gone('a')
    expect([closes, at.told]).toEqual([1, []])
  })

  it('turns the connection away as lost and hands the error to thrown when onLink throws, and closes once if gone was called first', async () => {
    let calls = 0
    const ended: Ending[] = []
    const thrown: unknown[] = []
    const taking = accept<string>((link, owner) => {
      link.onEnd((ending) => { ended.push(ending) })
      calls++
      if (calls === 1) throw new Error('onLink broke')
      if (calls === 2) { taking.gone(owner); throw new Error('threw after gone') }
      if (calls === 3) taking.gone(owner)
    }, { thrown: (error) => { thrown.push(error) } })

    // A reopening dialler whose onLink throws is told lost and stops reopening instead of spinning.
    let opens = 0
    const dialEnded: Ending[] = []
    const dialler = dial(() => {
      opens++
      const [left, right] = memoryPair()
      taking.take(right, 'a')
      return left
    }, { reopen: { clock: turns } })
    dialler.onEnd((ending) => { dialEnded.push(ending) })
    await until(() => dialEnded.length === 1)
    await rest()
    expect([opens, dialEnded, thrown]).toEqual([1, [{ why: 'lost' }], [new Error('onLink broke')]])

    // When onLink calls gone(owner) and then throws, the transport is closed once and nothing is sent after gone.
    let onData2: ((message: Message) => void) | undefined
    let closes2 = 0
    let sends2 = 0
    taking.take({ send: () => { sends2++ }, onData: (h) => { onData2 = h }, onClose: () => {}, close: () => { closes2++ } }, 'a')
    expect(() => onData2!(JSON.stringify([{ link: 1, session: 's2', taken: 0 }]))).not.toThrow()
    expect([closes2, sends2, thrown]).toEqual([1, 0, [new Error('onLink broke'), new Error('threw after gone')]])

    let onData3: ((message: Message) => void) | undefined
    let closes3 = 0
    taking.take({ send: () => {}, onData: (h) => { onData3 = h }, onClose: () => {}, close: () => { closes3++ } }, 'a')
    onData3!(JSON.stringify([{ link: 1, session: 's3', taken: 0 }]))
    expect([calls, closes3, ended]).toEqual([3, 1, [{ why: 'closed' }, { why: 'closed' }, { why: 'closed' }]])
  })

  it('turns away a hello arriving while an owner\'s session is being ended on reload', () => {
    const began: string[] = []
    const ended: string[] = []
    const interveningSent: Message[] = []
    let interveningClosed = 0
    let count = 0
    const taking = accept<string>((link) => {
      const id = `s${++count}`
      began.push(id)
      link.onEnd(() => {
        ended.push(id)
        if (id === 's1') {
          let onData: ((message: Message) => void) | undefined
          taking.take({ send: (m) => { interveningSent.push(m) }, onData: (h) => { onData = h }, onClose: () => {}, close: () => { interveningClosed++ } }, 'a')
          onData!(JSON.stringify([{ link: 1, session: 'intervening', taken: 0 }]))
        }
      })
    })
    const connect = (session: string) => {
      let onData: ((message: Message) => void) | undefined
      taking.take({ send: () => {}, onData: (h) => { onData = h }, onClose: () => {}, close: () => {} }, 'a')
      onData!(JSON.stringify([{ link: 1, session, taken: 0 }]))
    }
    connect('first')
    connect('second')
    // The intervening hello was turned away as lost; 's1' ended and 'second' became 's2' cleanly in one pass.
    expect(began).toEqual(['s1', 's2'])
    expect(ended).toEqual(['s1'])
    expect(interveningClosed).toBe(1)
    expect(interveningSent.map((m) => JSON.parse(m as string))).toEqual([[expect.objectContaining({ link: 1 }), { lost: true }]])
  })

  it('leaves no session for an owner said to be gone even if onEnd triggers a hello or re-entrant take', () => {
    let onData2: ((message: Message) => void) | undefined
    let closes2 = 0
    let closes3 = 0
    const began: string[] = []
    const ended: string[] = []
    let count = 0
    const taking = accept<string>((link) => {
      const id = `s${++count}`
      began.push(id)
      link.onEnd(() => {
        ended.push(id)
        if (id === 's1') {
          // A nested `gone` does not clear the leaving guard early, so neither a subsequent `take`+hello nor a hello
          // on an already-open connection can begin another session while `gone` is under way.
          taking.gone('a')
          let onData4: ((message: Message) => void) | undefined
          taking.take({ send: () => {}, onData: (h) => { onData4 = h }, onClose: () => {}, close: () => {} }, 'a')
          onData4?.(JSON.stringify([{ link: 1, session: 'after-nested-gone', taken: 0 }]))
          onData2?.(JSON.stringify([{ link: 1, session: 'reentrant', taken: 0 }]))
        }
      })
    })
    let onData1: ((message: Message) => void) | undefined
    taking.take({ send: () => {}, onData: (h) => { onData1 = h }, onClose: () => {}, close: () => {} }, 'a')
    // Already-open connection that tries to say hello during `onEnd` AND whose close fires a re-entrant `take`.
    taking.take({ send: () => {}, onData: (h) => { onData2 = h }, onClose: () => {}, close: () => { closes2++ } }, 'a')
    taking.take({
      send: () => {},
      onData: () => {},
      onClose: () => {},
      close: () => {
        taking.take({ send: () => {}, onData: () => {}, onClose: () => {}, close: () => { closes3++ } }, 'a')
      },
    }, 'a')
    onData1!(JSON.stringify([{ link: 1, session: 'first', taken: 0 }]))
    taking.gone('a')
    // No second session was begun, the open connection was turned away, and the re-entrant take was closed at once.
    expect(began).toEqual(['s1'])
    expect(ended).toEqual(['s1'])
    expect(closes2).toBe(1)
    expect(closes3).toBe(1)
  })
})

/**
 * A window that does each of `does` in turn (drops its connection, reloads) and is then destroyed, and a host that
 * says it is gone once it was, each at any moment. No more sessions are kept than there are owners not gone, never
 * two for one owner, and none ends that its owner could still go on with.
 */
const comeAndGo = (does: ReadonlyArray<'drops' | 'reloads'>) => (schedule: Schedule) => {
  const resBackend = schedule.resource('backend')
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
    const num = ++pages
    const resPage = schedule.resource(`page:${num}`)
    const lanes = [{ label: `page ${num} to backend` }, { label: `backend to page ${num}` }] as const
    let current: Transport | undefined
    const reopenClock = laneClock(schedule, lanes[0], { tracked: true })
    const link = trackedLink(dial(() => {
      schedule.write(resPage)
      schedule.write(resBackend)
      const [left, right] = scheduledPair(schedule, [`page ${num}`, 'backend'], {
        tracked: true,
        resources: [resPage, resBackend],
        lanes,
      })
      current = left
      backend.take({ ...right, onData: (heard) => { right.onData((message) => { taking = true; try { heard(message) } finally { taking = false } }) } }, 'the window')
      return left
    }, {
      reopen: {
        clock: {
          after: (ms, run) => reopenClock.after(ms, () => { schedule.write(resPage); run() }),
        },
      },
    }), schedule, resPage)
    return { link, drop: () => { current!.close() } }
  }
  let now = page()
  const main = { label: 'main to backend' }
  schedule.does({ label: 'the window', tracked: true },
    ...does.map((what) => [what, what === 'drops'
      ? () => { now.drop() }
      // The page it was goes, and with it what it dialled with: nothing says so to the backend.
      : () => { now.link.close(); now = page() }] as const),
    ['is destroyed', () => {
      now.link.close()
      schedule.later(main, () => { schedule.write(resBackend); said = true; backend.gone('the window') }, { tracked: true })
    }],
  )
  return () => {
    same(wrongly, 0, 'sessions ended that their owner could still go on with')
    same(kept.length, 0, 'sessions kept for an owner that is gone')
  }
}

const named = (does: ReadonlyArray<string>): string => [...does, 'is destroyed'].join(', then ')

describe('an owner coming and going, under every order', () => {
  for (const does of [[], ['drops'], ['reloads'], ['drops', 'reloads'], ['reloads', 'drops'], ['reloads', 'reloads']] as const) {
    it(`keeps one session at most, none once it is gone, and ends none it could go on with: ${named(does)}`, async () => {
      const scenario = comeAndGo(does)
      const ran = await explore(scenario, { limit: 200_000 })
      if (ran.failure) throw ran.failure.error
      expect(ran.complete).toBe(true)
      expect(ran.orderings).toBeGreaterThan(1)
      const audited = await auditIndependence(scenario, { seed: 23, runs: 20, swaps: 50 })
      expect(audited.violation).toBeUndefined()
    }, 600_000)
  }
})

describe('owners over real WebSockets', () => {
  let server: WebSocketServer
  let portNumber: number
  let currentHandler: ((ws: WebSocket, owner: string) => void) | undefined
  const tracked = new Set<WebSocket>()

  beforeAll(async () => {
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await eventOnce(server, 'listening')
    portNumber = (server.address() as { port: number }).port
    server.on('connection', (ws, req) => {
      tracked.add(ws)
      ws.on('close', () => { tracked.delete(ws) })
      const owner = new URL(req.url ?? '/', 'ws://127.0.0.1').searchParams.get('owner') ?? ''
      currentHandler?.(ws, owner)
    })
  })

  afterAll(async () => {
    for (const ws of tracked) ws.terminate()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  const openSocket = (owner: string, atPort = portNumber): WebSocket => {
    const ws = new WebSocket(`ws://127.0.0.1:${atPort}/?owner=${encodeURIComponent(owner)}`)
    tracked.add(ws)
    ws.on('close', () => { tracked.delete(ws) })
    return ws
  }

  it('resumes the same session after a forced socket drop with no lost or duplicated frames', async () => {
    const serverSockets: WebSocket[] = []
    const sessions: Array<{ owner: string; link: Link; heard: Frame[] }> = []
    const taking = accept<string>((link, owner) => {
      const entry = { owner, link, heard: [] as Frame[] }
      sessions.push(entry)
      link.onFrame((frame) => { entry.heard.push(frame) })
    })
    currentHandler = (ws, owner) => {
      serverSockets.push(ws)
      taking.take(socket(ws as never), owner)
    }
    const clientEnded: Ending[] = []
    const clientHeard: Frame[] = []
    let opens = 0
    const client = dial(() => {
      opens++
      return socket(openSocket('win-1') as never)
    }, { reopen: { clock: timers, first: 15, most: 50 } })
    client.onEnd((ending) => { clientEnded.push(ending) })
    client.onFrame((frame) => { clientHeard.push(frame) })

    client.send({ kind: 'tell', to: 'x', event: 'before-drop' })
    await until(() => sessions.length === 1 && sessions[0]!.heard.length === 1)
    sessions[0]!.link.send({ kind: 'tell', to: 'y', event: 'from-server-1' })
    await until(() => clientHeard.length === 1)

    // Forcefully drop the underlying TCP/WebSocket connection without a clean close handshake.
    serverSockets[0]!.terminate()
    client.send({ kind: 'tell', to: 'x', event: 'during-drop' })
    sessions[0]!.link.send({ kind: 'tell', to: 'y', event: 'from-server-2' })

    await until(() => sessions[0]!.heard.length === 2 && clientHeard.length === 2)
    expect(opens).toBeGreaterThanOrEqual(2)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.heard.map((f) => f.kind === 'tell' && f.event)).toEqual(['before-drop', 'during-drop'])
    expect(clientHeard.map((f) => f.kind === 'tell' && f.event)).toEqual(['from-server-1', 'from-server-2'])
    expect(clientEnded).toEqual([])

    taking.gone('win-1')
    await until(() => clientEnded.length === 1)
    expect(clientEnded).toEqual([{ why: 'goodbye', bye: 'ended' }])
  })

  it('handles owner reload, wrong-owner resume rejection, and gone() on both live and silent sockets', async () => {
    const events: string[] = []
    const taking = accept<string>((link, owner) => {
      const n = events.filter((e) => e.startsWith(`began ${owner}`)).length + 1
      events.push(`began ${owner}#${n}`)
      link.onEnd((ending) => { events.push(`ended ${owner}#${n}:${ending.why}`) })
    })
    currentHandler = (ws, owner) => { taking.take(socket(ws as never), owner) }

    const firstEnded: Ending[] = []
    let firstOpens = 0
    const first = dial(() => { firstOpens++; return socket(openSocket('reload-owner') as never) }, { reopen: { clock: timers, first: 15, most: 50 } })
    first.onEnd((ending) => { firstEnded.push(ending) })
    await until(() => events.includes('began reload-owner#1'))

    // Reload: a second link connects as the same owner, ending the first session cleanly before handing over the second.
    const secondEnded: Ending[] = []
    const second = dial(() => socket(openSocket('reload-owner') as never), { reopen: { clock: timers, first: 15, most: 50 } })
    second.onEnd((ending) => { secondEnded.push(ending) })
    await until(() => firstEnded.length === 1 && events.includes('began reload-owner#2'))
    expect(firstEnded).toEqual([{ why: 'goodbye', bye: 'ended' }])
    expect(events).toEqual(['began reload-owner#1', 'ended reload-owner#1:closed', 'began reload-owner#2'])

    // Another owner (bystander) stays unaffected when reload-owner is declared gone, AND a silent socket of reload-owner closes too.
    const otherEnded: Ending[] = []
    const other = dial(() => socket(openSocket('other-owner') as never), { reopen: { clock: timers, first: 15, most: 50 } })
    other.onEnd((ending) => { otherEnded.push(ending) })
    await until(() => events.includes('began other-owner#1'))

    const silent = openSocket('reload-owner')
    await eventOnce(silent, 'open')
    let silentClosed = false
    silent.on('close', () => { silentClosed = true })

    taking.gone('reload-owner')
    await until(() => secondEnded.length === 1 && silentClosed)
    expect(secondEnded).toEqual([{ why: 'goodbye', bye: 'ended' }])
    expect(otherEnded).toEqual([])
    // First client did not reopen after goodbye: ended.
    expect(firstOpens).toBe(1)

    taking.gone('other-owner')
    await until(() => otherEnded.length === 1)
  })

  it('handles close-while-opening and error-then-close ordering when dialling an unavailable port and later connecting', async () => {
    // Grab an ephemeral port and immediately close it so connections initially fail with ECONNREFUSED (error-then-close).
    const probe = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await eventOnce(probe, 'listening')
    const closedPort = (probe.address() as { port: number }).port
    await new Promise<void>((resolve) => probe.close(() => resolve()))

    const taking = accept<string>((link) => {
      link.onFrame((frame) => { link.send(frame) })
    })
    currentHandler = (ws, owner) => { taking.take(socket(ws as never), owner) }

    let attempts = 0
    const heard: Frame[] = []
    const thrown: unknown[] = []
    const client = dial(() => {
      attempts++
      // First two attempts hit the refused port (error-then-close); third hits the live server.
      const target = attempts <= 2 ? closedPort : portNumber
      return socket(openSocket('reopen-owner', target) as never)
    }, {
      reopen: { clock: timers, first: 15, most: 30 },
      thrown: (error) => { thrown.push(error) },
    })
    client.onFrame((frame) => { heard.push(frame) })
    client.send({ kind: 'tell', to: 'x', event: 'after-refused' })

    await until(() => heard.length === 1)
    expect(attempts).toBeGreaterThanOrEqual(3)
    expect(heard).toEqual([{ kind: 'tell', to: 'x', event: 'after-refused' }])
    expect(thrown).toEqual([])

    // Closing a dialled link while its WebSocket is still CONNECTING closes cleanly without throwing.
    const aborted = dial(() => socket(openSocket('abort-owner', closedPort) as never), {
      reopen: { clock: timers, first: 50, most: 100 },
      thrown: (error) => { thrown.push(error) },
    })
    const abortedEnded: Ending[] = []
    aborted.onEnd((ending) => { abortedEnded.push(ending) })
    aborted.close('ended')
    expect(abortedEnded).toEqual([{ why: 'closed' }])
    expect(thrown).toEqual([])

    taking.gone('reopen-owner')
    await rest()
  })
})
