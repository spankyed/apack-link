// A stand-in for the views a system runs, for scenarios of the hold. Things are made, one at a time, and each view
// is shown how many there are. A view runs in a lane of its own: what it is to show, it shows when the schedule
// gets to it, and asked whether it has caught up, it calls back in the same lane, after what it was to show. Asked
// again before it has called back, with nothing new to show between, it calls both back at once, as a view that
// runs once for every caller since it last ran does.
import type { Following } from '../peer.ts'
import type { Viewed } from './desk.ts'
import type { Schedule } from './schedule.ts'

export interface Made {
  /** How many things have been made. */
  readonly count: number
  /** Makes one. Each view followed is shown the new count, later, in its lane. Returns the new count. */
  make(): number
  /** What a desk's `follow` is given: shows the count now, and each change in the view's lane after. */
  follow(viewed: Viewed): Pick<Following, 'caughtUp'> | void
  /** Every `soon` a view was asked with, in order. */
  readonly soon: boolean[]
}

/**
 * Things made, and the views of how many. `offers: false` is views that offer no `caughtUp`, which is the hold
 * taken out. A view called `stuck` never calls back.
 */
export function made(schedule: Schedule, options: { offers?: boolean } = {}): Made {
  const views: Array<{ viewed: Viewed; lane: { label: string }; waiting?: Array<() => void> }> = []
  const soon: boolean[] = []
  let count = 0
  return {
    get count() { return count },
    soon,
    make: () => {
      count++
      const now = count
      for (const view of views) {
        view.waiting = undefined
        schedule.later(view.lane, () => { if (!view.viewed.stopped) view.viewed.shown(now) })
      }
      return now
    },
    follow: (viewed) => {
      const view: (typeof views)[number] = { viewed, lane: { label: `the view ${viewed.view} ${views.length + 1}` } }
      views.push(view)
      viewed.shown(count)
      if (options.offers === false) return
      return {
        caughtUp: (then, asSoon) => {
          soon.push(asSoon)
          if (viewed.view === 'stuck') return
          if (view.waiting) { view.waiting.push(then); return }
          const waiting = [then]
          view.waiting = waiting
          schedule.later(view.lane, () => {
            if (view.waiting === waiting) view.waiting = undefined
            for (const called of waiting) called()
          })
        },
      }
    },
  }
}
