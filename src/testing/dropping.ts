// Two ends of a link in memory whose connection can be dropped, or whose second end can restart, at any moment a
// scenario chooses: what a link that comes back is held to.
import { dial, listen, type Clock, type Link, type Listener, type Options } from '../link.ts'
import { memoryPair, type Message, type Transport } from '../transport.ts'
import type { Model } from './model.ts'
import type { Ends } from './scenarios.ts'
import type { Lane, Resource, Schedule, TaskOptions } from '@apackdev/orderings'

/**
 * A clock that keeps no time, for a link on a schedule: what is asked for runs when the schedule gets to it in the
 * lane given, however long was asked for, unless it is called off first. Pass `resource` (e.g. a link's DPOR
 * resource) so timer firings and cancellations attribute directly to that resource even on no-op or state-only turns.
 */
export function laneClock(schedule: Schedule, lane: Lane, options?: TaskOptions & { readonly resource?: Resource }): Clock {
  const tracked = options?.tracked ?? (options?.resource !== undefined)
  const taskOptions: TaskOptions | undefined = tracked ? { tracked: true } : undefined
  const res = options?.resource ?? (tracked ? schedule.resource(`clock:${lane.label}`) : undefined)
  return {
    after: (_, run) => {
      let off = false
      schedule.later(lane, () => {
        if (res) schedule.write(res)
        if (!off) run()
      }, taskOptions)
      return () => {
        if (res) schedule.write(res)
        off = true
      }
    },
  }
}

/**
 * One end of a connection nobody is listening on yet: what arrives is kept, and handed over in order to whoever
 * listens first, as what was sent to a socket is to whoever accepts it.
 */
function kept(transport: Transport): Transport {
  const arrived: Message[] = []
  let hears: Array<(message: Message) => void> | undefined
  const closes: Array<() => void> = []
  /** Whether it has closed, and whether this end closed it: then nothing more that arrived is handed over. */
  let closed = false
  let shut = false
  const gone = (): void => { for (const then of closes.splice(0)) then() }
  transport.onData((message) => { if (hears) for (const heard of hears) heard(message); else arrived.push(message) })
  // That it closed is heard after what arrived before it did, by whoever listens then.
  transport.onClose(() => { closed = true; if (hears) gone() })
  return {
    ...transport,
    onData: (heard) => {
      if (hears) { hears.push(heard); return }
      hears = [heard]
      for (const message of arrived.splice(0)) if (!shut) heard(message)
      if (closed) gone()
    },
    onClose: (then) => { if (closed && hears) then(); else closes.push(then) },
    close: () => { shut = true; transport.close() },
  }
}

export interface Dropping extends Ends {
  /** Drops the connection the two are on. The first end opens another, and the second is handed it. */
  drop(): void
  /**
   * The second end goes, closing the connection from its side, and a new one with a session of its own takes the
   * next connection.
   */
  restart(): void
  /** The second end as it is now: after a restart, the new one. */
  readonly now: Link
  /** How many connections have been opened. */
  readonly connections: number
}

/**
 * The first end is given what opens a connection, as a window is; the second is handed each one, as a backend is.
 * What crosses one way is one lane however many connections there are, as on one socket at a time, and the first
 * end opens another connection in the lane of what it sends: after what it sent on the one before. The first `unreachable` connections reach nobody: each closes
 * with nothing having crossed, as one does to a backend that is not listening yet. What else
 * `options` holds, a codec or a part, is given to every link made here. Given a model, every link made here is put
 * under it.
 */
export function droppingMemoryEnds(schedule: Schedule, options: Options & { readonly unreachable?: number } = {}, held?: Model): Dropping {
  const { unreachable = 0, ...given } = options
  let ends = 0
  /** A link for the second end, or for nobody a scenario knows, under the model if there is one. */
  const second = (): Listener => {
    ends++
    const made = listen(undefined, given)
    return held ? held.end(made, ends === 1 ? 'b' : `b (${ends})`) : made
  }
  const there = { label: 'a to b' }
  const back = { label: 'b to a' }
  let b = second()
  let gone = false
  /** Whether the second end ended by itself, lost or told to: nothing is coming back, and a backend goes on listening. */
  let byItself = false
  b.onEnd((ending) => { gone = true; byItself = ending.why !== 'closed' })
  let current: Transport | undefined
  /** A connection opened while the second end is gone, which reaches it once it is back, as a socket dialling. */
  let waiting: Transport | undefined
  let connections = 0
  const clock = laneClock(schedule, there)
  const opens = dial(() => {
    connections++
    const [left, right] = memoryPair((run) => schedule.later(there, run), (run) => schedule.later(back, run))
    current = left
    if (connections <= unreachable) right.close()
    // To an end that ended by itself a connection is a new one, to a link of its own, as `accept` makes one.
    else if (gone && byItself) second().carry(right)
    else if (gone) waiting = kept(right)
    else b.carry(right)
    return left
  }, { ...given, reopen: { clock } })
  const a = held ? held.end(opens, 'a') : opens
  const first = b
  return {
    a,
    b: first,
    get now() { return b },
    get connections() { return connections },
    drop: () => { current?.close() },
    restart: () => {
      b.close()
      b = second()
      gone = false
      byItself = false
      const next = b
      b.onEnd((ending) => { if (b === next) { gone = true; byItself = ending.why !== 'closed' } })
      if (waiting) { b.carry(waiting); waiting = undefined }
    },
  }
}
