// Peer hold bounds, stall recovery, caughtUp ordering and error isolation, and join invariants.
import { describe, expect, it } from 'vitest'
import { dial, join, listen, memoryPair, type Ending, type HoldStall, type Outcome } from '../src/index.ts'
import { asking, desk, watching } from '../src/testing/index.ts'

const turn = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })

describe('peer hold bounds and stall recovery', () => {
  it('validates JoinOptions.bound and does not consume the link on RangeError', () => {
    const [left] = memoryPair()
    const a = dial(left)
    const p = desk().port
    for (const bad of [0, -1, 1.5, Number.NaN, Number.NEGATIVE_INFINITY]) {
      expect(() => join(a, p, { bound: { frames: bad } })).toThrow(RangeError)
      expect(() => join(a, p, { bound: { size: bad } })).toThrow(RangeError)
    }
    // Valid join still succeeds after rejected attempts, and joining a second time throws TypeError.
    expect(() => join(a, p, { bound: { frames: Number.POSITIVE_INFINITY, size: Number.POSITIVE_INFINITY } })).not.toThrow()
    expect(() => join(a, p)).toThrow(TypeError)
  })

  it('ends only the stalled view(s) blocking the oldest round, keeps healthy views and asks alive, and emits payload-free HoldStall', async () => {
    const [left, right] = memoryPair()
    const a = dial(left)
    const b = listen(right)
    const endedA: Ending[] = []
    const endedB: Ending[] = []
    a.onEnd((e) => { endedA.push(e) })
    b.onEnd((e) => { endedB.push(e) })

    const order: string[] = []
    const client = desk({ tell: (_, event) => { order.push(`tell:${String(event)}`) } })
    const toBackend = join(a, client.port)

    const stalls: HoldStall[] = []
    let healthyStops = 0
    let stalledStops = 0
    let healthyShown: ((u: unknown) => void) | undefined
    const toWindow = join(b, desk({
      ask: (asked) => { asked.ended({ ok: true, value: `ans:${String(asked.args)}` }) },
      follow: (viewed) => {
        if (viewed.view === 'stalled') {
          return { stop: () => { stalledStops++ }, caughtUp: () => { /* never calls back */ } }
        }
        healthyShown = viewed.shown
        return { stop: () => { healthyStops++ }, caughtUp: (then) => { then() } }
      },
    }).port, {
      bound: { frames: 3 },
      onStall: (stall) => { stalls.push(stall) },
    })

    const stalledView = toBackend.follow('f', 'stalled', { secret: 'do-not-leak' }, () => {}, (failure) => {
      order.push(`over:${failure.kind}:${failure.message}`)
    })
    const healthyView = watching(toBackend, 'f', 'healthy', {})
    await turn()

    // 3 frames fit within the hold bound without stalling anything.
    toWindow.tell('x', 'secret-1', { cause: 'secret-cause' })
    toWindow.tell('x', 'secret-2')
    toWindow.tell('x', 'secret-3')
    await turn()
    expect(stalls).toEqual([])
    expect(order).toEqual([])

    // 4th frame crosses bound.frames = 3: stalled view is ended `over` strictly ahead of held frames.
    toWindow.tell('x', 'secret-4')
    await turn()

    expect(stalledStops).toBe(1)
    expect(healthyStops).toBe(0)
    expect(endedA).toEqual([])
    expect(endedB).toEqual([])
    expect(order).toEqual([
      'over:failed:The view stalled',
      'tell:secret-1',
      'tell:secret-2',
      'tell:secret-3',
      'tell:secret-4',
    ])

    // HoldStall is strictly payload-free (no event payloads, args, or causes).
    expect(stalls).toHaveLength(1)
    expect(stalls[0]!.views).toEqual([1])
    expect(stalls[0]!.held.frames).toBe(4)
    expect(stalls[0]!.held.size).toBeGreaterThan(0)
    expect(stalls[0]!.rounds).toBe(4)
    expect(stalls[0]!.bound.frames).toBe(3)
    expect(Object.keys(stalls[0]!).sort()).toEqual(['bound', 'held', 'rounds', 'views'])
    expect(JSON.stringify(stalls[0])).not.toContain('secret')

    // Healthy view and asks continue working normally on the same session.
    healthyShown!('still-alive')
    const res = asking(toBackend, 'f', 'ping', 'ok')
    await turn()
    expect(healthyView.shown).toEqual(['still-alive'])
    expect(healthyView.over).toEqual([])
    expect(res.ended).toEqual([{ ok: true, value: 'ans:ok' }])
    stalledView.stop()
    healthyView.stop()
  })

  it('enforces bound.size and cascades across multiple rounds when later views also stall', async () => {
    const [left, right] = memoryPair()
    const a = dial(left)
    const b = listen(right)
    const order: string[] = []
    const toBackend = join(a, desk({ tell: (_, event) => { order.push(`tell:${String(event).slice(0, 4)}`) } }).port)

    const stalls: HoldStall[] = []
    const toWindow = join(b, desk({
      follow: (viewed) => {
        if (viewed.view === 'sync') return { caughtUp: (then) => { then() } }
        return { caughtUp: () => { /* stalls */ } }
      },
    }).port, {
      bound: { size: 120 },
      onStall: (stall) => { stalls.push(stall) },
    })

    // A synchronous caughtUp view never triggers onStall even for a frame larger than bound.size.
    const syncView = watching(toBackend, 'f', 'sync', {})
    await turn()
    toWindow.tell('x', 'sync'.padEnd(200, '.'))
    await turn()
    expect(stalls).toEqual([])
    expect(order).toEqual(['tell:sync'])
    syncView.stop()
    await turn()

    // View 2 stalls on round 1 (small frame), then view 3 joins and stalls on round 2 (large frame > 120 bytes).
    // Exceeding bound.size must fail view 2 (releasing round 1), see round 2 is still > 120 bytes, and fail view 3.
    order.length = 0
    toBackend.follow('f', 'v2', {}, () => {}, (f) => { order.push(`over2:${f.message}`) })
    await turn()
    toWindow.tell('x', 'r1__')
    await turn()
    expect(order).toEqual([])

    toBackend.follow('f', 'v3', {}, () => {}, (f) => { order.push(`over3:${f.message}`) })
    await turn()
    toWindow.tell('x', 'r2__'.padEnd(150, '.'))
    await turn()

    expect(order).toEqual([
      'over2:The view stalled',
      'tell:r1__',
      'over3:The view stalled',
      'tell:r2__',
    ])
    expect(stalls.map((s) => s.views)).toEqual([[2], [3]])
  })

  it('isolates errors thrown by onStall or stalled view stop() during recovery', async () => {
    const [left, right] = memoryPair()
    const a = dial(left)
    const b = listen(right)
    const received = desk()
    const toBackend = join(a, received.port)
    const reported: unknown[] = []

    const toWindow = join(b, desk({
      follow: () => ({
        stop: () => { throw new Error('stop broke') },
        caughtUp: () => { /* stalls */ },
      }),
    }).port, {
      bound: { frames: 1 },
      onStall: () => { throw new Error('onStall broke') },
      thrown: (error) => { reported.push(error) },
    })

    const v = watching(toBackend, 'f', 'stalled', {})
    await turn()
    toWindow.tell('x', 'one')
    toWindow.tell('x', 'two')
    await turn()

    expect(v.over).toEqual([{ kind: 'failed', message: 'The view stalled' }])
    expect(received.told.map((t) => t.event)).toEqual(['one', 'two'])
    expect(reported).toEqual([new Error('stop broke'), new Error('onStall broke')])
  })
})

describe('caughtUp ordering, error isolation, and hold semantics', () => {
  it('sends over strictly before held frames when caughtUp calls then() synchronously and then throws', async () => {
    const [left, right] = memoryPair()
    const a = dial(left)
    const b = listen(right)
    const order: string[] = []
    const toBackend = join(a, desk({ tell: (_, event) => { order.push(`tell:${String(event)}`) } }).port)
    const reported: unknown[] = []
    const toWindow = join(b, desk({
      follow: () => ({
        caughtUp: (then) => {
          then()
          throw new Error('threw after then')
        },
      }),
    }).port, { thrown: (error) => { reported.push(error) } })

    toBackend.follow('f', 'v', {}, () => {}, (failure) => { order.push(`over:${failure.kind}`) })
    await turn()

    // With JoinOptions.thrown provided, tell() routes caughtUp throws to thrown instead of propagating synchronously.
    expect(() => toWindow.tell('x', 'held')).not.toThrow()
    await turn()
    expect(order).toEqual(['over:failed', 'tell:held'])
    expect(reported).toEqual([new Error('threw after then')])
  })

  it('does not falsely fail mine.ask or leak handles when an unrelated view throws in caughtUp', async () => {
    const [left, right] = memoryPair()
    const a = dial(left)
    const b = listen(right)
    const reported: unknown[] = []

    const toBackend = join(a, desk({
      follow: () => ({ caughtUp: () => { throw new Error('client view broke') } }),
    }).port, { thrown: (error) => { reported.push(error) } })

    const backendDesk = desk({
      ask: (asked) => {
        // Synchronously emit progress while a broken view is active on the backend.
        asked.heard('p1')
      },
      follow: () => ({ caughtUp: () => { throw new Error('backend view broke') } }),
    })
    const toWindow = join(b, backendDesk.port, { thrown: (error) => { reported.push(error) } })

    // Follow a broken view on both sides.
    const backendView = watching(toBackend, 'f', 'bv', {})
    const clientView = watching(toWindow, 'f', 'cv', {})
    await turn()

    // 1. Outgoing ask from client while client's own view throws in caughtUp must still return its leave handle.
    const outcomes: Outcome[] = []
    const progress: unknown[] = []
    const leave = toBackend.ask('x', 'WORK', 'arg', (u) => { progress.push(u) }, (o) => { outcomes.push(o) })
    expect(typeof leave).toBe('function')
    await turn()

    // Backend's mine.ask succeeded (not failed with 'It could not be taken'), and progress arrived after backendView over.
    expect(outcomes).toEqual([])
    expect(progress).toEqual(['p1'])
    expect(backendView.over).toEqual([{ kind: 'failed', message: 'It could not be taken' }])
    expect(clientView.over).toEqual([{ kind: 'failed', message: 'It could not be taken' }])
    expect(reported).toEqual([new Error('client view broke'), new Error('backend view broke')])

    // Leaving cancels the live backend ask cleanly (proving `gone` was NOT lost when caughtUp threw).
    leave()
    await turn()
    expect(backendDesk.asks[0]!.left).toBe(1)
  })

  it('does not retroactively drop valid held progress when a later answer for the same ask is unsendable', async () => {
    const [left, right] = memoryPair()
    const a = dial(left)
    const b = listen(right)
    const releaseViews: Array<() => void> = []

    const toBackend = join(a, desk().port)
    join(b, desk({
      ask: (asked) => {
        asked.heard('valid-progress')
        asked.ended({ ok: true, value: { bad: 1n } })
      },
      follow: () => ({ caughtUp: (then) => { releaseViews.push(then) } }),
    }).port)

    const view = watching(toBackend, 'f', 'v', {})
    await turn()
    const ask = asking(toBackend, 'x', 'DO', {})
    await turn()
    expect(ask.heard).toEqual([])
    expect(ask.ended).toEqual([])

    // Once the view catches up, both the valid earlier progress and the unsendable failure answer arrive in order.
    for (const release of releaseViews) release()
    await turn()
    expect(ask.heard).toEqual(['valid-progress'])
    expect(ask.ended).toEqual([{ ok: false, failure: { kind: 'failed', message: 'A value could not be sent' } }])
    view.stop()
  })

  it('handles joining an already-ended link cleanly', () => {
    const [left] = memoryPair()
    const a = dial(left)
    a.close()
    const remote = join(a, desk().port)
    expect(() => remote.tell('x', 'ignored')).not.toThrow()
    const outcomes: Outcome[] = []
    const leave = remote.ask('x', 'A', {}, () => {}, (o) => { outcomes.push(o) })
    expect(outcomes).toEqual([{ ok: false, failure: { kind: 'disconnected', message: 'The link closed' } }])
    expect(() => leave()).not.toThrow()
    const overs: unknown[] = []
    const f = remote.follow('f', 'v', {}, () => {}, (failure) => { overs.push(failure) })
    expect(overs).toEqual([{ kind: 'disconnected', message: 'The link closed' }])
    expect(() => f.stop()).not.toThrow()
  })

  it('accepts Partial<Size> in link Options.bound and drains thousands of held frames in FIFO order', async () => {
    const [left, right] = memoryPair()
    const a = dial(left, { bound: { kept: { frames: 512 }, waiting: { frames: 8192 } } })
    const b = listen(right, { bound: { kept: { size: 4 * 1024 * 1024 }, waiting: { size: 16 * 1024 * 1024 } } })

    const received: number[] = []
    const toBackend = join(a, desk({ tell: (_, event) => { received.push(event as number) } }).port)
    const callbacks: Array<() => void> = []
    const toWindow = join(b, desk({
      follow: () => ({ caughtUp: (then) => { callbacks.push(then) } }),
    }).port, { bound: { frames: 4000 } })

    const view = watching(toBackend, 'f', 'v', {})
    await turn()

    const total = 2500
    for (let i = 0; i < total; i++) toWindow.tell('x', i)
    expect(received).toEqual([])
    expect(callbacks).toHaveLength(total)

    // Drain in reverse/interleaved order to exercise round head compaction and queue draining.
    for (let i = callbacks.length - 1; i >= 0; i--) callbacks[i]!()
    await turn()

    expect(received).toHaveLength(total)
    expect(received[0]).toBe(0)
    expect(received[total - 1]).toBe(total - 1)
    for (let i = 0; i < total; i++) expect(received[i]).toBe(i)
    view.stop()
  })
})
