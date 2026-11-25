// What a spec of a link is written with, here and anywhere an end of a link is built: two ends in memory whose
// directions are lanes of a schedule, and the scenarios themselves, to be run over any pair of ends. The schedule
// that runs a scenario under every order is `@apackdev/orderings`, which whoever uses this entry installs.
import { dial, listen, type Link, type Listener, type Options, type Prepared, type Sending } from '../link.ts'
import type { Frame } from '../frames.ts'
import { join, type Following, type JoinOptions, type Port } from '../peer.ts'
import { memoryPair, type Transport } from '../transport.ts'
import type { Model } from './model.ts'
import type { Ends } from './scenarios.ts'
import type { Lane, Resource, Schedule } from '@apackdev/orderings'

export { carried } from './carried.ts'
export { holds, same } from './check.ts'
export { asking, desk, watching, type Asked, type Asking, type Desk, type Viewed, type Watching } from './desk.ts'
export { droppingMemoryEnds, laneClock, type Dropping } from './dropping.ts'
export { hold, peers, resume, withoutTheHold, type DroppingScenario, type Ends, type KitScenario } from './scenarios.ts'
export { model, underModel, type Model, type ModelOptions } from './model.ts'
export { made, type Made } from './views.ts'

/** What a pair of ends is made over: given a schedule, two links. */
export type MakeEnds = (schedule: Schedule) => Ends

/** Options for `scheduledPair` when opting into wakeup-tree DPOR tracking. */
export interface ScheduledOptions {
  /**
   * Marks both directions as tracked for wakeup-tree DPOR: allocates one `Resource` per end (or uses `resources`) so
   * deliveries, sends, listener changes, and closes on disjoint ends commute while operations on the same end
   * conflict. Only enable when listeners attached to both ends report their own shared-state accesses. Defaults to `false`.
   */
  readonly tracked?: boolean
  /** Pre-allocated resources `[a, b]` for the two ends, for callers that share them with `trackedLink` or `trackedJoin`. */
  readonly resources?: readonly [Resource, Resource]
  /** Pre-allocated lanes `[aToB, bToA]` to reuse across multiple connections of the same pair (e.g. `reopen`). */
  readonly lanes?: readonly [Lane, Lane]
}

/**
 * Two ends in memory on a schedule: each direction is a lane of its own, so what crosses one way keeps its order
 * and the schedule chooses between the two, and whatever else a spec adds.
 */
export function scheduledPair(
  schedule: Schedule,
  names: readonly [string, string] = ['a', 'b'],
  options: ScheduledOptions = {},
): [Transport, Transport] {
  const [there, back] = options.lanes ?? [{ label: `${names[0]} to ${names[1]}` }, { label: `${names[1]} to ${names[0]}` }]
  if (!options.tracked) {
    return memoryPair((run) => schedule.later(there, run), (run) => schedule.later(back, run))
  }
  const [resA, resB] = options.resources ?? [
    schedule.resource(`link:${names[0]}`),
    schedule.resource(`link:${names[1]}`),
  ]
  const [left, right] = memoryPair(
    (run) => schedule.later(there, () => { schedule.write(resB); run() }, { tracked: true }),
    (run) => schedule.later(back, () => { schedule.write(resA); run() }, { tracked: true }),
  )
  const wrap = (transport: Transport, resource: Resource): Transport => ({
    ...transport,
    send: (message) => { schedule.write(resource); transport.send(message) },
    onData: (heard) => { schedule.write(resource); transport.onData(heard) },
    onClose: (closed) => { schedule.write(resource); transport.onClose(closed) },
    close: () => { schedule.write(resource); transport.close() },
  })
  return [wrap(left, resA), wrap(right, resB)]
}

/**
 * Wraps a `Link` (or `Listener`) so direct calls and listener subscriptions on this end record `read()`/`write()`
 * against `resource` for wakeup-tree DPOR, keeping pure protocol activity on disjoint ends commutative.
 */
export function trackedLink<L extends Link>(link: L, schedule: Schedule, resource: Resource): L {
  const wrapped: Link = {
    send: ((frame: Frame | Prepared, how?: Sending) => {
      schedule.write(resource)
      if ('prepared' in frame) link.send(frame)
      else link.send(frame, how)
    }) as Link['send'],
    prepare: (frame, how) => { schedule.write(resource); return link.prepare(frame, how) },
    onFrame: (heard) => {
      schedule.write(resource)
      const stop = link.onFrame(heard)
      return () => { schedule.write(resource); stop() }
    },
    onTraffic: (seen) => {
      schedule.write(resource)
      const stop = link.onTraffic(seen)
      return () => { schedule.write(resource); stop() }
    },
    onEnd: (ended) => {
      schedule.write(resource)
      const stop = link.onEnd(ended)
      return () => { schedule.write(resource); stop() }
    },
    close: (bye) => { schedule.write(resource); link.close(bye) },
    kept: () => { schedule.read(resource); return link.kept() },
    waiting: () => { schedule.read(resource); return link.waiting() },
    awaiting: () => {
      schedule.write(resource)
      const settle = link.awaiting()
      return () => { schedule.write(resource); settle() }
    },
  }
  return {
    ...link,
    ...wrapped,
    ...('carry' in link && typeof (link as Listener).carry === 'function'
      ? { carry: (transport: Transport) => { schedule.write(resource); (link as Listener).carry(transport) } }
      : {}),
  }
}

/**
 * Joins `link` and `mine` while attributing every peer-hold, port-call, async answer/view callback, and `caughtUp`
 * callback mutation on this end to `resource` for wakeup-tree DPOR.
 */
export function trackedJoin(link: Link, mine: Port, schedule: Schedule, resource: Resource, options?: JoinOptions): Port {
  const trackedMine: Port = {
    tell: (to, event, how) => { mine.tell(to, event, how) },
    ask: (to, name, args, heard, ended, how) => mine.ask(
      to,
      name,
      args,
      (update, send) => { schedule.write(resource); heard(update, send) },
      (outcome, send) => { schedule.write(resource); ended(outcome, send) },
      how,
    ),
    follow: (feature, view, args, shown, over, how) => {
      const following: Following = mine.follow(
        feature,
        view,
        args,
        (update, send) => { schedule.write(resource); shown(update, send) },
        (failure, send) => { schedule.write(resource); over(failure, send) },
        how,
      )
      if (!following.caughtUp) return following
      const caughtUp = following.caughtUp.bind(following)
      return {
        stop: () => { following.stop() },
        caughtUp: (then, soon) => { caughtUp(() => { schedule.write(resource); then() }, soon) },
      }
    },
  }
  const remote = join(trackedLink(link, schedule, resource), trackedMine, options)
  return {
    tell: (to, event, how) => { schedule.write(resource); remote.tell(to, event, how) },
    ask: (to, name, args, heard, ended, how) => {
      schedule.write(resource)
      const leave = remote.ask(to, name, args, heard, ended, how)
      return () => { schedule.write(resource); leave() }
    },
    follow: (feature, view, args, shown, over, how) => {
      schedule.write(resource)
      const following = remote.follow(feature, view, args, shown, over, how)
      return { stop: () => { schedule.write(resource); following.stop() } }
    },
  }
}

/**
 * Two ends of a link in memory, on a schedule, made with `options`: the first dials and the second listens. What
 * this package's own scenarios are run over. Given a model, each end is put under it (when combining `tracked: true`
 * with a shared `Model`, do not race `lost` endings concurrently across ends because `model()` checks peer endings).
 */
export function memoryEnds(
  schedule: Schedule,
  options: Options & { readonly tracked?: boolean; readonly names?: readonly [string, string] } = {},
  held?: Model,
): Ends {
  const { tracked, names = ['a', 'b'], ...linkOptions } = options
  if (!tracked) {
    const [left, right] = scheduledPair(schedule, names)
    const [a, b] = [dial(left, linkOptions), listen(right, linkOptions)]
    return held ? { a: held.end(a, names[0]), b: held.end(b, names[1]) } : { a, b }
  }
  const resA = schedule.resource(`link:${names[0]}`)
  const resB = schedule.resource(`link:${names[1]}`)
  const [left, right] = scheduledPair(schedule, names, { tracked: true, resources: [resA, resB] })
  const a = trackedLink(dial(left, linkOptions), schedule, resA)
  const b = trackedLink(listen(right, linkOptions), schedule, resB)
  return held ? { a: held.end(a, names[0]), b: held.end(b, names[1]) } : { a, b }
}
