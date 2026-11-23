// Two ends of a link in memory whose connection can be dropped, or whose second end can restart, at any moment a
// scenario chooses: what a link that comes back is held to.
import { link, type Link } from '../link.ts'
import { memoryPair, type Transport } from '../transport.ts'
import type { Ends } from './scenarios.ts'
import type { Schedule } from './schedule.ts'

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
 * What crosses one way is one lane however many connections there are, as on one socket at a time.
 */
export function droppingMemoryEnds(schedule: Schedule): Dropping {
  const there = { label: 'a to b' }
  const back = { label: 'b to a' }
  let b = link()
  let gone = false
  b.onEnd(() => { gone = true })
  let current: Transport | undefined
  /** A connection opened while the second end is gone, which reaches it once it is back, as a socket dialling. */
  let waiting: Transport | undefined
  let connections = 0
  const a = link(() => {
    connections++
    const [left, right] = memoryPair((run) => schedule.later(there, run), (run) => schedule.later(back, run))
    current = left
    if (gone) waiting = right
    else b.carry(right)
    return left
  })
  const first = b
  return {
    a,
    b: first,
    get now() { return b },
    get connections() { return connections },
    drop: () => { current?.close() },
    restart: () => {
      b.close()
      b = link()
      gone = false
      const next = b
      b.onEnd(() => { if (b === next) gone = true })
      if (waiting) { b.carry(waiting); waiting = undefined }
    },
  }
}
