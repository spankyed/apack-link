// The codec built in, and the pieces of the testing kit a spec of another end is written with: each does what its
// doc says, so that a scenario that passes says something.
import { describe, expect, it } from 'vitest'
import { asFrame, join, json, dial, listen, memoryPair, type Port, type Transport } from '../src/index.ts'
import { auditIndependence, everyOrder, explore } from '@apackdev/orderings'
import { asking, carried, desk, holds, laneClock, made, memoryEnds, same, scheduledPair, trackedJoin, trackedLink, watching } from '../src/testing/index.ts'

describe('json', () => {
  it('gives back what it was given, from text and from the same text as bytes', () => {
    const value = { a: [1, 'two', null, { three: true }], é: 'ü' }
    expect(json.decode(json.encode(value))).toEqual(value)
    expect(json.decode(new TextEncoder().encode(json.encode(value) as string))).toEqual(value)
  })

  it('joins encoded values as a list and as a record, which read back as the values', () => {
    const parts = [json.encode(1), json.encode({ b: 'c' })]
    expect(json.decode(json.list(parts))).toEqual([1, { b: 'c' }])
    expect(json.decode(json.record([['x', parts[0]!], ['a "quoted" name', parts[1]!]]))).toEqual({ x: 1, 'a "quoted" name': { b: 'c' } })
  })

  it('refuses a value JSON cannot hold, and text it did not make', () => {
    expect(() => json.encode(undefined)).toThrow()
    expect(() => json.encode(() => {})).toThrow()
    expect(() => json.encode(1n)).toThrow()
    expect(() => json.decode('{not json')).toThrow()
    expect(() => json.decode(new Uint8Array([0xff, 0xfe]))).toThrow()
  })
})

describe('asFrame', () => {
  it('gives back each of the nine frames with its own fields, and nothing else that came with it', () => {
    const failure = { kind: 'gone', message: 'No such view' }
    const frames = [
      { kind: 'tell', to: 't', event: { any: ['thing'] } },
      { kind: 'ask', id: 1, to: 't', name: 'N', args: null },
      { kind: 'progress', id: 1, update: 1 },
      { kind: 'answer', id: 1, outcome: { ok: true, value: 2 } },
      { kind: 'left', id: 1 },
      { kind: 'follow', id: 2, feature: 'f', view: 'v', args: [] },
      { kind: 'shown', id: 2, update: 'x' },
      { kind: 'unfollow', id: 2 },
      { kind: 'over', id: 2, failure },
    ]
    for (const frame of frames) expect(asFrame({ ...frame, extra: 'left behind' })).toEqual(frame)
    expect(asFrame({ kind: 'over', id: 2, failure: { ...failure, stack: 'left behind' } })).toEqual({ kind: 'over', id: 2, failure })
  })

  it('is nothing for what is not one of them', () => {
    for (const arrived of [
      null, 'tell', [], { kind: 'shout', id: 1 },
      { kind: 'tell', event: 1 }, { kind: 'ask', id: 1, to: 't', args: 1 }, { kind: 'follow', id: 1, feature: 'f', args: 1 },
      { kind: 'left', id: 0 }, { kind: 'left', id: 1.5 }, { kind: 'left', id: '1' },
      { kind: 'over', id: 1, failure: 'gone' }, { kind: 'over', id: 1, failure: { kind: 'gone' } },
    ]) expect(asFrame(arrived)).toBeUndefined()
  })
})

describe('same and holds', () => {
  it('pass what holds and throw, saying what was looked at, for what does not', () => {
    same({ a: [1, { b: null }] }, { a: [1, { b: null }] }, 'alike')
    holds(true, 'true')
    for (const [actual, expected] of [[{ a: 1 }, { a: 1, b: 2 }], [[1, 2], [2, 1]], [[], {}], [null, {}], [{ a: undefined }, { b: undefined }], [NaN, 0]] as const) {
      expect(() => same(actual, expected, 'the thing')).toThrow(/the thing/)
    }
    expect(() => holds(false, 'that one')).toThrow(/that one/)
  })
})

describe('two ends in memory', () => {
  it('are one that dials and one that listens: the second says nothing until the first has, so there is one order they meet in', async () => {
    expect(await everyOrder((schedule) => { memoryEnds(schedule); return () => {} })).toBe(1)
  })
})

describe('asking and watching', () => {
  const ends = (mine: Port): Port => {
    const [left, right] = memoryPair()
    join(listen(right), mine)
    return join(dial(left), desk().port)
  }

  it('note what an asker hears and how it ended, in order', async () => {
    const other = desk({ ask: (asked) => { asked.heard('half'); asked.ended({ ok: true, value: 'done' }) } })
    const ask = asking(ends(other.port), 'threads', 'CREATE', { topic: 'one' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(other.asks.map(({ to, name, args }) => ({ to, name, args }))).toEqual([{ to: 'threads', name: 'CREATE', args: { topic: 'one' } }])
    expect(ask.heard).toEqual(['half'])
    expect(ask.ended).toEqual([{ ok: true, value: 'done' }])
    expect(ask.log).toEqual(['heard', 'ended'])
  })

  it('note leaving, which reaches the system asked', async () => {
    const other = desk()
    const ask = asking(ends(other.port), 'threads', 'WAIT', null)
    await new Promise((resolve) => setTimeout(resolve, 0))
    ask.leave()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(ask.log).toEqual(['left'])
    expect(other.asks.map((asked) => asked.left)).toEqual([1])
  })

  it('note what a view is shown and its stopping, which reaches the system running it', async () => {
    const other = desk({ follow: (viewed) => { viewed.shown(['first']) } })
    const view = watching(ends(other.port), 'threads', 'list', { open: true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    other.views[0]!.shown(['first', 'second'])
    await new Promise((resolve) => setTimeout(resolve, 0))
    view.stop()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(view.shown).toEqual([['first'], ['first', 'second']])
    expect(view.log).toEqual(['shown', 'shown', 'stopped'])
    expect(other.views.map((viewed) => viewed.stopped)).toEqual([1])
  })

  it('note a view ending, with why', async () => {
    const other = desk({ follow: (viewed) => { viewed.over({ kind: 'gone', message: 'No such list' }) } })
    const view = watching(ends(other.port), 'threads', 'list', null)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(view.over).toEqual([{ kind: 'gone', message: 'No such list' }])
    expect(view.log).toEqual(['over'])
  })
})

describe('made', () => {
  it('shows each view the count when followed and each new count after, and calls back once caught up', async () => {
    await everyOrder((schedule) => {
      const things = made(schedule)
      const shown: unknown[] = []
      let caught = 0
      const viewed = { feature: 'f', view: 'count', args: null, shown: (update: unknown) => { shown.push(update) }, over: () => {}, stopped: 0 }
      const offered = things.follow(viewed)
      things.make()
      things.make()
      offered?.caughtUp?.(() => { caught++ }, true)
      return () => {
        // The count when followed, then each one made, in order, and the call back after the last.
        same(shown, [0, 1, 2], 'what the view was shown')
        same(caught, 1, 'times it called back')
        same(things.count, 2, 'how many were made')
        same(things.soon, [true], 'what it was asked with')
      }
    })
  })

  it('offers nothing to wait for when made without offers', async () => {
    await everyOrder((schedule) => {
      const things = made(schedule, { offers: false })
      const offered = things.follow({ feature: 'f', view: 'count', args: null, shown: () => {}, over: () => {}, stopped: 0 })
      return () => { holds(!offered?.caughtUp, 'no caughtUp is offered') }
    })
  })
})

describe('carried', () => {
  it('forwards most and waiting from the wrapped transports', async () => {
    await everyOrder((schedule) => {
      const [left, right] = memoryPair()
      let backlog = 42
      const a: Transport = { ...left, most: 4096, waiting: () => backlog }
      const b: Transport = { ...right }
      const [wrappedA, wrappedB] = carried(schedule, [a, b])
      return () => {
        same(wrappedA.most, 4096, 'most forwarded')
        same(wrappedA.waiting?.(), 42, 'waiting forwarded')
        backlog = 7
        same(wrappedA.waiting?.(), 7, 'waiting stays live')
        holds(!('most' in wrappedB) && !('waiting' in wrappedB), 'absent fields stay absent')
      }
    })
  })
})

describe('wakeup-tree DPOR tracking helpers', () => {
  it('collapses independent traffic across two tracked links and passes auditIndependence', async () => {
    const scenario = (schedule: Parameters<typeof memoryEnds>[0]) => {
      const link1 = memoryEnds(schedule, { tracked: true, names: ['a1', 'b1'] })
      const link2 = memoryEnds(schedule, { tracked: true, names: ['a2', 'b2'] })
      const seen1: number[] = []
      const seen2: number[] = []
      link1.b.onFrame((frame) => { if (frame.kind === 'tell') seen1.push(frame.event as number) })
      link2.b.onFrame((frame) => { if (frame.kind === 'tell') seen2.push(frame.event as number) })
      link1.a.send({ kind: 'tell', to: 'x', event: 1 })
      link1.a.send({ kind: 'tell', to: 'x', event: 2 })
      link2.a.send({ kind: 'tell', to: 'y', event: 10 })
      link2.a.send({ kind: 'tell', to: 'y', event: 20 })
      return () => {
        same(seen1, [1, 2], 'link1 delivered in order')
        same(seen2, [10, 20], 'link2 delivered in order')
      }
    }
    const reduced = await explore(scenario)
    expect(reduced).toEqual({ orderings: 1, complete: true, reduced: true })
    const unreduced = await explore(scenario, { reduce: false })
    expect(unreduced.orderings).toBeGreaterThan(reduced.orderings)

    const audited = await auditIndependence(scenario, { seed: 1, runs: 20, swaps: 50 })
    expect(audited.violation).toBeUndefined()
    expect(audited.checked).toBeGreaterThan(0)
  })

  it('attributes trackedJoin hold, caughtUp callbacks, and ask/follow/stop mutations to the end resource', async () => {
    const scenario = (schedule: Parameters<typeof memoryEnds>[0]) => {
      const resW = schedule.resource('window')
      const resB = schedule.resource('backend')
      const [left, right] = scheduledPair(schedule, ['window', 'backend'], { tracked: true, resources: [resW, resB] })
      const winLink = dial(left)
      const backLink = listen(right)
      const events: string[] = []
      const v1Lane = { label: 'view 1' }
      const v2Lane = { label: 'view 2' }
      const backendPort: Port = {
        tell: () => {},
        ask: (_to, _name, _args, _heard, ended) => {
          ended({ ok: true, value: 'ok' })
          return () => {}
        },
        follow: (_feature, view, _args, shown) => {
          shown(0)
          const lane = view === 'v1' ? v1Lane : v2Lane
          return {
            stop: () => {},
            caughtUp: (then) => { schedule.later(lane, () => { then() }, { tracked: true }) },
          }
        },
      }
      const winPort: Port = {
        tell: () => {},
        ask: () => () => {},
        follow: () => ({ stop: () => {} }),
      }
      const toBackend = trackedJoin(winLink, winPort, schedule, resW)
      trackedJoin(backLink, backendPort, schedule, resB)
      const f1 = toBackend.follow('f', 'v1', null, () => { events.push('v1') }, () => {})
      const f2 = toBackend.follow('f', 'v2', null, () => { events.push('v2') }, () => {})
      toBackend.ask('svc', 'GO', null, () => {}, (outcome) => { if (outcome.ok) events.push('answered') })
      schedule.does({ label: 'cleanup', tracked: true }, ['stops', () => { f1.stop(); f2.stop() }])
      return () => {
        holds(events.includes('answered'), 'ask answered after hold released')
      }
    }
    const explored = await explore(scenario)
    expect(explored.complete).toBe(true)
    const audited = await auditIndependence(scenario, { seed: 5, runs: 20, swaps: 50 })
    expect(audited.violation).toBeUndefined()
  })

  it('tracks trackedLink Listener.carry, kept/waiting reads, and laneClock cancel-vs-fire races', async () => {
    const firedStates = new Set<boolean>()
    const scenario = (schedule: Parameters<typeof memoryEnds>[0]) => {
      const resA = schedule.resource('a')
      const resB = schedule.resource('b')
      const [left, right] = scheduledPair(schedule, ['a', 'b'], { tracked: true, resources: [resA, resB] })
      const a = trackedLink(dial(left), schedule, resA)
      const b = trackedLink(listen(), schedule, resB)
      b.carry(right)
      let fired = false
      const timerLane = { label: 'timer' }
      const clock = laneClock(schedule, timerLane, { tracked: true })
      const cancel = clock.after(10, () => { fired = true })
      schedule.later({ label: 'canceller' }, () => {
        cancel()
        void a.kept()
        void a.waiting()
      }, { tracked: true })
      return () => { firedStates.add(fired) }
    }
    const explored = await explore(scenario)
    expect(explored.complete).toBe(true)
    expect([...firedStates].sort()).toEqual([false, true])
    const audited = await auditIndependence(scenario, { seed: 3, runs: 10, swaps: 20 })
    expect(audited.violation).toBeUndefined()
  })

  it('differentially matches unreduced states across trackedJoin async ask/view races, trackedLink listeners, and scheduledPair subscriptions', async () => {
    const checkDifferential = async (
      make: (states: Set<string>) => Parameters<typeof explore>[0],
    ): Promise<{ full: number; dpor: number; states: string[] }> => {
      const fullStates = new Set<string>()
      const dporStates = new Set<string>()
      const full = await explore(make(fullStates), { reduce: false })
      const dpor = await explore(make(dporStates), { reduce: true })
      expect(full.complete).toBe(true)
      expect(dpor.complete).toBe(true)
      expect([...dporStates].sort()).toEqual([...fullStates].sort())
      const audited = await auditIndependence(make(new Set<string>()), { seed: 7, runs: 20, swaps: 50 })
      expect(audited.violation).toBeUndefined()
      return { full: full.orderings, dpor: dpor.orderings, states: [...dporStates].sort() }
    }

    // 1. trackedJoin async ask (`heard` + `ended` from another tracked lane) racing backend link close.
    const askClose = await checkDifferential((states) => (schedule) => {
      const resW = schedule.resource('w')
      const resB = schedule.resource('b')
      const [left, right] = scheduledPair(schedule, ['w', 'b'], { tracked: true, resources: [resW, resB] })
      const winLink = dial(left)
      const backLink = listen(right)
      const progress: number[] = []
      let outcome = 'none'
      const backPort: Port = {
        tell: () => {},
        ask: (_to, _name, _args, heard, ended) => {
          const workLane = { label: 'async-ask' }
          schedule.later(workLane, () => { heard(1) }, { tracked: true })
          schedule.later(workLane, () => { ended({ ok: true, value: 42 }) }, { tracked: true })
          return () => {}
        },
        follow: () => ({ stop: () => {} }),
      }
      const winPort: Port = { tell: () => {}, ask: () => () => {}, follow: () => ({ stop: () => {} }) }
      const toBack = trackedJoin(winLink, winPort, schedule, resW)
      trackedJoin(backLink, backPort, schedule, resB)
      toBack.ask('svc', 'Q', null, (u) => { progress.push(u as number) }, (o) => { outcome = o.ok ? 'ok' : o.failure.kind })
      schedule.later({ label: 'closer' }, () => { trackedLink(backLink, schedule, resB).close('ended') }, { tracked: true })
      return () => { states.add(`${progress.join(',')}|${outcome}`) }
    })
    expect(askClose.states).toContain('1|ok')
    expect(askClose.states).toContain('|disconnected')
    expect(askClose.dpor).toBeLessThan(askClose.full)

    // 2. trackedJoin async follow (`shown` + `over` from another tracked lane) racing unfollow (`stop()`).
    const followRace = await checkDifferential((states) => (schedule) => {
      const resW = schedule.resource('w')
      const resB = schedule.resource('b')
      const [left, right] = scheduledPair(schedule, ['w', 'b'], { tracked: true, resources: [resW, resB] })
      const winLink = dial(left)
      const backLink = listen(right)
      const shown: number[] = []
      let over = 'none'
      const backPort: Port = {
        tell: () => {},
        ask: () => () => {},
        follow: (_f, _v, _a, onShown, onOver) => {
          const viewLane = { label: 'view-feed' }
          schedule.later(viewLane, () => { onShown(1) }, { tracked: true })
          schedule.later(viewLane, () => { onOver({ kind: 'gone', message: 'done' }) }, { tracked: true })
          return { stop: () => {} }
        },
      }
      const winPort: Port = { tell: () => {}, ask: () => () => {}, follow: () => ({ stop: () => {} }) }
      const toBack = trackedJoin(winLink, winPort, schedule, resW)
      trackedJoin(backLink, backPort, schedule, resB)
      const sub = toBack.follow('f', 'v', null, (u) => { shown.push(u as number) }, (f) => { over = f.kind })
      schedule.later({ label: 'stopper' }, () => { sub.stop() }, { tracked: true })
      return () => { states.add(`${shown.join(',')}|${over}`) }
    })
    expect(followRace.states).toContain('1|gone')
    expect(followRace.states).toContain('|none')

    // 3. trackedLink `onFrame`/`onEnd` attach & unsubscribe racing incoming delivery and close.
    const listenerRace = await checkDifferential((states) => (schedule) => {
      const resA = schedule.resource('a')
      const resB = schedule.resource('b')
      const [left, right] = scheduledPair(schedule, ['a', 'b'], { tracked: true, resources: [resA, resB] })
      const a = trackedLink(dial(left), schedule, resA)
      const b = trackedLink(listen(right), schedule, resB)
      let heard = 0
      let ended = 0
      const stopFrame = b.onFrame(() => { heard++ })
      const stopEnd = b.onEnd(() => { ended++ })
      a.send({ kind: 'tell', to: 'x', event: 1 })
      a.close('ended')
      schedule.later({ label: 'unsub' }, () => { stopFrame(); stopEnd() }, { tracked: true })
      return () => { states.add(`${heard},${ended}`) }
    })
    expect(listenerRace.states).toContain('0,0')
    expect(listenerRace.states).toContain('1,1')

    // 4. scheduledPair `onData`/`onClose` late attachment racing delivery on the same end.
    const transportAttach = await checkDifferential((states) => (schedule) => {
      const resA = schedule.resource('a')
      const resB = schedule.resource('b')
      const [left, right] = scheduledPair(schedule, ['a', 'b'], { tracked: true, resources: [resA, resB] })
      let received = 0
      let closed = 0
      left.send('ping')
      left.close()
      schedule.later({ label: 'attach' }, () => {
        right.onData(() => { received++ })
        right.onClose(() => { closed++ })
      }, { tracked: true })
      return () => { states.add(`${received},${closed}`) }
    })
    expect(transportAttach.states).toContain('0,0')
    expect(transportAttach.states).toContain('1,1')
  })
})
