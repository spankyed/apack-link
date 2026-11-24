// What a listener throws is never the link's: every frame of a batch is still taken, every listener still called,
// and what was thrown is handed on. A system at an end of a link is a listener, and is held to the same.
import { describe, expect, it } from 'vitest'
import { join, dial, listen, memoryPair, type Ending, type Frame, type Outcome } from '../src/index.ts'
import { everyOrder } from '@apackdev/orderings'
import { asking, desk, scheduledPair, watching } from '../src/testing/index.ts'

const turn = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })
const tell = (event: unknown): Frame => ({ kind: 'tell', to: 'x', event })
const told = (frames: readonly Frame[]): unknown[] => frames.map((frame) => frame.kind === 'tell' && frame.event)

describe('a listener that throws', () => {
  it('loses no frame of the batch, stops no other listener, and does not end the link', async () => {
    const [left, right] = memoryPair()
    const a = dial(left)
    const thrown: unknown[] = []
    const b = listen(right, { thrown: (error) => { thrown.push(error) } })
    const first: Frame[] = []
    const second: Frame[] = []
    const ended: Ending[] = []
    b.onFrame((frame) => { first.push(frame); if (frame.kind === 'tell' && frame.event === 1) throw new Error('on the first') })
    b.onFrame((frame) => { second.push(frame) })
    b.onEnd((ending) => { ended.push(ending) })
    // One turn, so one batch.
    for (const event of [1, 2, 3]) a.send(tell(event))
    await turn()
    a.send(tell(4))
    await turn()
    expect([told(first), told(second)]).toEqual([[1, 2, 3, 4], [1, 2, 3, 4]])
    expect(thrown).toEqual([new Error('on the first')])
    expect(ended).toEqual([])
    // What it took, it says it took: the other end keeps nothing.
    expect(a.kept()).toBe(0)
  })

  it('is thrown again in a turn of its own when the link is given nowhere to hand it', async () => {
    // What nothing catches, as Node tells of it: heard here in place of whoever else listens, for this one.
    const others = process.listeners('uncaughtException')
    process.removeAllListeners('uncaughtException')
    const uncaught: unknown[] = []
    process.on('uncaughtException', (error) => { uncaught.push(error) })
    try {
      const [left, right] = memoryPair()
      const a = dial(left)
      const b = listen(right)
      const heard: Frame[] = []
      b.onFrame((frame) => { heard.push(frame); throw new Error(`on ${String(heard.length)}`) })
      a.send(tell(1))
      a.send(tell(2))
      await turn()
      expect(told(heard)).toEqual([1, 2])
      expect(uncaught).toEqual([new Error('on 1'), new Error('on 2')])
    } finally {
      process.removeAllListeners('uncaughtException')
      for (const other of others) process.on('uncaughtException', other)
    }
  })

  it('where it is told a link ended, does not keep the others from being told', () => {
    const thrown: unknown[] = []
    const a = dial(memoryPair()[0], { thrown: (error) => { thrown.push(error) } })
    const ended: Ending[] = []
    a.onEnd(() => { throw new Error('at the end') })
    a.onEnd((ending) => { ended.push(ending) })
    expect(() => a.close()).not.toThrow()
    expect(ended).toEqual([{ why: 'closed' }])
    expect(thrown).toEqual([new Error('at the end')])
    // A listener added after the link has already ended goes to `thrown` as well.
    expect(() => a.onEnd(() => { throw new Error('after the end') })).not.toThrow()
    expect(thrown).toEqual([new Error('at the end'), new Error('after the end')])
  })

  it('hands on what the place it is handed to throws as well', async () => {
    const others = process.listeners('uncaughtException')
    process.removeAllListeners('uncaughtException')
    const uncaught: unknown[] = []
    process.on('uncaughtException', (error) => { uncaught.push(error) })
    try {
      const a = dial(memoryPair()[0], { thrown: () => { throw new Error('handing it on') } })
      a.onEnd(() => { throw new Error('at the end') })
      a.close()
      await turn()
      expect(uncaught).toEqual([new Error('handing it on')])
    } finally {
      process.removeAllListeners('uncaughtException')
      for (const other of others) process.on('uncaughtException', other)
    }
  })
})

describe('a system that throws', () => {
  /** Two joined ends on a schedule, with what each end's link was handed as thrown. */
  const ends = (schedule: Parameters<Parameters<typeof everyOrder>[0]>[0]) => {
    const [left, right] = scheduledPair(schedule)
    const thrown = { a: [] as unknown[], b: [] as unknown[] }
    const ended = { a: [] as Ending[], b: [] as Ending[] }
    const a = dial(left, { thrown: (error) => { thrown.a.push(error) } })
    const b = listen(right, { thrown: (error) => { thrown.b.push(error) } })
    a.onEnd((ending) => { ended.a.push(ending) })
    b.onEnd((ending) => { ended.b.push(ending) })
    return { a, b, thrown, ended }
  }

  it('where it is told, is told everything after, and the link goes on', async () => {
    await everyOrder((schedule) => {
      const { a, b, thrown, ended } = ends(schedule)
      const backend = desk({ tell: (_, event) => { if (event === 1) throw new Error('told 1') } })
      join(b, backend.port)
      const toBackend = join(a, desk().port)
      for (const event of [1, 2, 3]) toBackend.tell('x', event)
      schedule.does('the window', ['tells 4', () => toBackend.tell('x', 4)])
      return () => {
        expect(backend.told.map((one) => one.event)).toEqual([1, 2, 3, 4])
        expect(thrown.b).toEqual([new Error('told 1')])
        expect([ended.a, ended.b]).toEqual([[], []])
      }
    })
  })

  it('where it hears progress, an answer, a result or that a view is over, hears everything after', async () => {
    await everyOrder((schedule) => {
      const { a, b, thrown, ended } = ends(schedule)
      const backend = desk({
        ask: (asked) => { asked.heard('half'); asked.ended({ ok: true, value: asked.args }) },
        follow: (viewed) => { viewed.shown(1); viewed.over({ kind: 'done', message: 'No more' }) },
      })
      join(b, backend.port)
      const window = desk()
      const toBackend = join(a, window.port)
      const heard: string[] = []
      // Everything the window is handed for the first ask and the first view, it throws on.
      toBackend.ask('x', 'ASK', 'first',
        () => { heard.push('progress'); throw new Error('progress') },
        (outcome: Outcome) => { heard.push(`answer ${String(outcome.ok)}`); throw new Error('answer') })
      toBackend.follow('x', 'view', {},
        () => { heard.push('shown'); throw new Error('shown') },
        () => { heard.push('over'); throw new Error('over') })
      const after = asking(toBackend, 'x', 'ASK', 'second')
      const view = watching(toBackend, 'x', 'view', {})
      return () => {
        expect(heard).toEqual(['progress', 'answer true', 'shown', 'over'])
        expect(thrown.a).toEqual([new Error('progress'), new Error('answer'), new Error('shown'), new Error('over')])
        expect(after.ended).toEqual([{ ok: true, value: 'second' }])
        expect([view.shown, view.over]).toEqual([[1], [{ kind: 'done', message: 'No more' }]])
        expect([ended.a, ended.b]).toEqual([[], []])
      }
    })
  })

  it('where it is told the link closed, does not keep any other ask or view from being ended', async () => {
    await everyOrder((schedule) => {
      const { a, b, thrown } = ends(schedule)
      const backend = desk()
      join(b, backend.port)
      const toBackend = join(a, desk().port)
      toBackend.ask('x', 'ASK', 'first', () => {}, () => { throw new Error('ended') })
      toBackend.follow('x', 'view', {}, () => {}, () => { throw new Error('over') })
      const after = asking(toBackend, 'x', 'ASK', 'second')
      const view = watching(toBackend, 'x', 'view', {})
      const others: Ending[] = []
      a.onEnd((ending) => { others.push(ending) })
      schedule.does('the backend', ['closes', () => b.close()])
      return () => {
        const disconnected = { kind: 'disconnected', message: 'The link closed' }
        expect(after.ended).toEqual([{ ok: false, failure: disconnected }])
        expect(view.over).toEqual([disconnected])
        expect(others).toEqual([{ why: 'closed' }])
        // The peer says the first of what its system threw, once it has ended everything.
        expect(thrown.a).toEqual([new Error('ended')])
      }
    })
  })

  it('whose view throws in caughtUp ends that view over ahead of held frames, stops it, and skips views stopped mid-round', async () => {
    const [left, right] = memoryPair()
    const a = dial(left)
    const b = listen(right)
    const order: string[] = []
    const received = desk({ tell: (_, event) => { order.push(`tell:${String(event)}`) } })
    const toBackend = join(a, received.port)
    let secondCalled = 0
    let secondCaughtUp: (() => void) | undefined
    let throwingView: { stopped: number } | undefined
    const toWindow = join(b, desk({
      follow: (viewed) => {
        if (viewed.view === 'throws') {
          throwingView = viewed
          return { caughtUp: () => { throw new Error('caughtUp broke') } }
        }
        return { caughtUp: (then) => { secondCalled++; secondCaughtUp = then } }
      },
    }).port)
    const overFailures: Array<{ kind: string; message: string }> = []
    const v1 = toBackend.follow('f', 'throws', {}, () => {}, (failure) => { overFailures.push(failure); order.push(`over:${failure.kind}`) })
    const v2 = watching(toBackend, 'f', 'ok', {})
    await turn()
    expect(() => toWindow.tell('x', 'first')).toThrow('caughtUp broke')
    // The broken view was stopped and told over; the second view was still asked and holds the tell until it catches up.
    expect([throwingView?.stopped, secondCalled]).toEqual([1, 1])
    await turn()
    expect(overFailures).toEqual([{ kind: 'failed', message: 'It could not be taken' }])
    expect(received.told).toEqual([])
    secondCaughtUp!()
    await turn()
    // The follower heard `over` for the broken view strictly before the held tell arrived.
    expect(order).toEqual(['over:failed', 'tell:first'])
    v1.stop()
    v2.stop()
    await turn()
    // Even when the throwing view is the only view, `over` still arrives before the held frame.
    const [leftSolo, rightSolo] = memoryPair()
    const soloOrder: string[] = []
    const soloToBackend = join(dial(leftSolo), desk({ tell: (_, event) => { soloOrder.push(`tell:${String(event)}`) } }).port)
    const soloToWindow = join(listen(rightSolo), desk({
      follow: () => ({ caughtUp: () => { throw new Error('solo broke') } }),
    }).port)
    soloToBackend.follow('f', 'throws', {}, () => {}, (failure) => { soloOrder.push(`over:${failure.kind}`) })
    await turn()
    expect(() => soloToWindow.tell('x', 'solo')).toThrow('solo broke')
    await turn()
    expect(soloOrder).toEqual(['over:failed', 'tell:solo'])
    // A view whose caughtUp synchronously ends another view stops that second view from being asked.
    let laterAsked = 0
    let secondView: { over: (failure: { kind: string; message: string }) => void } | undefined
    const [left2, right2] = memoryPair()
    const a2 = dial(left2)
    const b2 = listen(right2)
    const received2 = desk()
    const toBackend2 = join(a2, received2.port)
    const toWindowSync = join(b2, desk({
      follow: (viewed) => {
        if (viewed.view === 'stops-other') return { caughtUp: (then) => { secondView?.over({ kind: 'gone', message: 'gone' }); then() } }
        secondView = viewed
        return { caughtUp: (then) => { laterAsked++; then() } }
      },
    }).port)
    watching(toBackend2, 'f', 'stops-other', {})
    watching(toBackend2, 'f', 'stopped-by-first', {})
    await turn()
    toWindowSync.tell('x', 'released')
    await turn()
    expect(laterAsked).toBe(0)
    expect(received2.told.map((one) => one.event)).toEqual(['released'])
  })
})

describe('removing listeners', () => {
  it('onFrame and onEnd return idempotent unsubscribes that work even during dispatch and with duplicate callbacks', async () => {
    const [left, right] = memoryPair()
    const a = dial(left)
    const b = listen(right)
    const log: string[] = []
    const shared = (frame: Frame): void => { log.push(`shared:${frame.kind === 'tell' ? String(frame.event) : frame.kind}`) }
    const offShared1 = b.onFrame(shared)
    const offShared2 = b.onFrame(shared)
    let offLater: (() => void) | undefined
    const offSelf = b.onFrame((frame) => {
      log.push(`self:${frame.kind === 'tell' ? String(frame.event) : frame.kind}`)
      offSelf()
      offLater?.()
    })
    offLater = b.onFrame(() => { log.push('later') })
    a.send(tell(1))
    await turn()
    // `offLater` was unsubscribed during the same dispatch, so it did not run; both `shared` registrations ran.
    expect(log).toEqual(['shared:1', 'shared:1', 'self:1'])
    log.length = 0
    offShared1()
    offShared1() // idempotent: must not remove the second `shared` registration
    a.send(tell(2))
    await turn()
    expect(log).toEqual(['shared:2'])
    offShared2()
    log.length = 0
    a.send(tell(3))
    await turn()
    expect(log).toEqual([])

    const ended: string[] = []
    const offEnd1 = b.onEnd(() => { ended.push('first') })
    b.onEnd(() => { ended.push('second') })
    offEnd1()
    b.close()
    expect(ended).toEqual(['second'])
    // Late onEnd fires immediately and returns a safe no-op unsubscribe.
    const lateOff = b.onEnd(() => { ended.push('late') })
    expect(ended).toEqual(['second', 'late'])
    expect(() => lateOff()).not.toThrow()
  })
})
