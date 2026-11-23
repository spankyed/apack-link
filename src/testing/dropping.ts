// Two ends of a link in memory whose connection can be dropped, or whose second end can restart, at any moment a
// scenario chooses: what a link that comes back is held to.
import { link, type Clock, type Link, type Options } from '../link.ts'
import { memoryPair, type Transport } from '../transport.ts'
import type { Ends } from './scenarios.ts'
import type { Lane, Schedule } from './schedule.ts'

/**
 * A clock that keeps no time, for a link on a schedule: what is asked for runs when the schedule gets to it in the
 * lane given, however long was asked for, unless it is called off first.
 */
export function laneClock(schedule: Schedule, lane: Lane): Clock {
  return {
    after: (_, run) => {
      let off = false
      schedule.later(lane, () => { if (!off) run() })
      return () => { off = true }
    },
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
 * `options` holds, a codec or a part, is given to every link made here.
 */
export function droppingMemoryEnds(schedule: Schedule, options: Options & { readonly unreachable?: number } = {}): Dropping {
  const { unreachable = 0, ...given } = options
  const there = { label: 'a to b' }
  const back = { label: 'b to a' }
  let b = link(undefined, given)
  let gone = false
  /** Whether the second end ended by itself, lost or told to: nothing is coming back, and a backend goes on listening. */
  let byItself = false
  b.onEnd((ending) => { gone = true; byItself = ending.why !== 'closed' })
  let current: Transport | undefined
  /** A connection opened while the second end is gone, which reaches it once it is back, as a socket dialling. */
  let waiting: Transport | undefined
  let connections = 0
  const clock = laneClock(schedule, there)
  const a = link(() => {
    connections++
    const [left, right] = memoryPair((run) => schedule.later(there, run), (run) => schedule.later(back, run))
    current = left
    if (connections <= unreachable) right.close()
    // To an end that ended by itself a connection is a new one, to a link of its own, as `accept` makes one.
    else if (gone && byItself) link(undefined, given).carry(right)
    else if (gone) waiting = right
    else b.carry(right)
    return left
  }, { ...given, reopen: { clock } })
  const first = b
  return {
    a,
    b: first,
    get now() { return b },
    get connections() { return connections },
    drop: () => { current?.close() },
    restart: () => {
      b.close()
      b = link(undefined, given)
      gone = false
      byItself = false
      const next = b
      b.onEnd((ending) => { if (b === next) { gone = true; byItself = ending.why !== 'closed' } })
      if (waiting) { b.carry(waiting); waiting = undefined }
    },
  }
}
