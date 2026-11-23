// A system to put at an end of a link in a scenario: a port that notes everything it is told, asked and has
// followed, and does only what the scenario has it do. And the other side of each: an ask and a view as whoever
// made them sees them.
import type { Failure } from '../frames.ts'
import type { Following, Outcome, Port } from '../peer.ts'

/** An ask as the system asked sees it. */
export interface Asked {
  readonly to: string
  readonly name: string
  readonly args: unknown
  heard(update: unknown): void
  ended(outcome: Outcome): void
  /** How many times it was told whoever asked has gone. */
  left: number
}

/** A followed view as the system running it sees it. */
export interface Viewed {
  readonly feature: string
  readonly view: string
  readonly args: unknown
  shown(update: unknown): void
  over(failure: Failure): void
  /** How many times it was stopped. */
  stopped: number
}

export interface Desk {
  readonly port: Port
  readonly told: Array<{ to: string; event: unknown }>
  readonly asks: Asked[]
  readonly views: Viewed[]
}

/**
 * A system that notes what reaches it. `ask` and `follow` are called as each arrives, to answer or show there and
 * then or to put it off into a lane; `follow` may return what the view's `Following` has beside `stop`.
 */
export function desk(does: { ask?(asked: Asked): void; follow?(viewed: Viewed): Pick<Following, 'caughtUp'> | void } = {}): Desk {
  const made: Desk = {
    told: [],
    asks: [],
    views: [],
    port: {
      tell: (to, event) => { made.told.push({ to, event }) },
      ask: (to, name, args, heard, ended) => {
        const asked: Asked = { to, name, args, heard, ended, left: 0 }
        made.asks.push(asked)
        does.ask?.(asked)
        return () => { asked.left++ }
      },
      follow: (feature, view, args, shown, over) => {
        const viewed: Viewed = { feature, view, args, shown, over, stopped: 0 }
        made.views.push(viewed)
        const more = does.follow?.(viewed)
        return { stop: () => { viewed.stopped++ }, ...(more ?? {}) }
      },
    },
  }
  return made
}

/** An ask as whoever made it sees it: what it heard and how it ended, in order, and `leave` to go. */
export interface Asking {
  readonly heard: unknown[]
  readonly ended: Outcome[]
  /** Everything that reached the asker and what the asker did, in the order it happened. */
  readonly log: string[]
  leave(): void
}

export function asking(of: Port, to: string, name: string, args: unknown): Asking {
  const made: Asking = { heard: [], ended: [], log: [], leave: () => { made.log.push('left'); gone() } }
  const gone = of.ask(to, name, args,
    (update) => { made.heard.push(update); made.log.push('heard') },
    (outcome) => { made.ended.push(outcome); made.log.push('ended') })
  return made
}

/** A view as whoever follows it sees it. */
export interface Watching {
  readonly shown: unknown[]
  readonly over: Failure[]
  readonly log: string[]
  stop(): void
}

export function watching(of: Port, feature: string, view: string, args: unknown): Watching {
  const made: Watching = { shown: [], over: [], log: [], stop: () => { made.log.push('stopped'); following.stop() } }
  const following = of.follow(feature, view, args,
    (update) => { made.shown.push(update); made.log.push('shown') },
    (failure) => { made.over.push(failure); made.log.push('over') })
  return made
}
