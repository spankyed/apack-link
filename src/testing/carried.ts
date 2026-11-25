// Two ends of something real that carries a link, put on a schedule: what arrives at each end is put into a lane of
// its direction, so a scenario runs over a socket, a port or a stream as it does over memory, and the schedule
// chooses among what has arrived. What is on its way is outside the schedule, and a run waits for it.
import type { Message, Transport } from '../transport.js'
import type { Schedule } from '@apackdev/orderings'

/** Wraps two joined transports so that what crosses them is run in a lane of the schedule for each direction. */
export function carried(schedule: Schedule, pair: readonly [Transport, Transport], names: readonly [string, string] = ['a', 'b']): [Transport, Transport] {
  const sides = [0, 1].map((side) => ({
    real: pair[side]!,
    lane: { label: `${names[side]} to ${names[1 - side]}` },
    /** What this side has sent and the other has not had, each with what to call as it lands. */
    away: [] as Array<() => void>,
    closed: false,
    /** Whether this side's real end has said nothing more will arrive. */
    over: false,
  }))
  const wrap = (side: 0 | 1): Transport => {
    const here = sides[side]!
    const there = sides[1 - side]!
    const hears: Array<(message: Message) => void> = []
    const closes: Array<() => void> = []
    here.real.onData((message) => {
      const landed = there.away.shift()
      schedule.later(there.lane, () => { if (!here.closed) for (const heard of hears) heard(message) })
      landed?.()
    })
    here.real.onClose(() => {
      // Nothing more will land here: what was on its way here is not waited for, and the close is put in turn.
      here.over = true
      const away = there.away.splice(0)
      schedule.later(there.lane, () => {
        if (here.closed) return
        here.closed = true
        for (const closed of closes) closed()
      })
      for (const landed of away) landed()
    })
    return {
      send: (message) => {
        if (here.closed || there.closed) return
        here.away.push(schedule.outside())
        here.real.send(message)
      },
      onData: (heard) => { hears.push(heard) },
      onClose: (closed) => { closes.push(closed) },
      ...(here.real.waiting ? { waiting: () => here.real.waiting!() } : {}),
      ...(here.real.most === undefined ? {} : { most: here.real.most }),
      close: () => {
        if (here.closed) return
        // Closed at once here, as the ends in memory are: the real close is heard by the other side in its turn, and
        // the run waits for it as for a message.
        if (!there.over) here.away.push(schedule.outside())
        here.real.close()
        here.closed = true
        for (const closed of closes) closed()
      },
    }
  }
  return [wrap(0), wrap(1)]
}
