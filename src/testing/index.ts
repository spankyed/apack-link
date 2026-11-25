// What a spec of a link is written with, here and anywhere an end of a link is built: two ends in memory whose
// directions are lanes of a schedule, and the scenarios themselves, to be run over any pair of ends. The schedule
// that runs a scenario under every order is `@apackdev/orderings`, which whoever uses this entry installs.
import { dial, listen, type Link, type Listener, type Options, type Prepared, type Sending } from '../link.js'
import type { Frame } from '../frames.js'
import { join, type Following, type JoinOptions, type Port } from '../peer.js'
import { memoryPair, type Transport } from '../transport.js'
import type { Model } from './model.js'
import type { Ends } from './scenarios.js'
import type { Lane, Resource, Schedule } from '@apackdev/orderings'

export { carried } from './carried.js'
export { holds, same } from './check.js'
export { asking, desk, watching, type Asked, type Asking, type Desk, type Viewed, type Watching } from './desk.js'
export { droppingMemoryEnds, laneClock, type Dropping } from './dropping.js'
export { hold, peers, resume, withoutTheHold, type DroppingScenario, type Ends, type KitScenario } from './scenarios.js'
export { model, underModel, type Model, type ModelOptions } from './model.js'
export { made, type Made } from './views.js'

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

const trackedJoined = new WeakSet<Link>()

/**
 * Joins `link` and `mine` while attributing every peer-hold, port-call, async answer/view callback, and `caughtUp`
 * callback mutation on this end to `resource` for wakeup-tree DPOR.
 */
export function trackedJoin(link: Link, mine: Port, schedule: Schedule, resource: Resource, options?: JoinOptions): Port {
  if (trackedJoined.has(link)) throw new TypeError('A link can only be joined once')
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
  trackedJoined.add(link)
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
 * Returns a `Link` `Options.later` callback that schedules each batch flush on `lane` as a tracked DPOR task and
 * records a write to `resource` even if the link already flushed or closed before the turn runs.
 */
export function trackedLater(schedule: Schedule, lane: Lane, resource: Resource): (run: () => void) => void {
  return (run) => {
    schedule.later(lane, () => {
      schedule.write(resource)
      run()
    }, { tracked: true })
  }
}

const modelResources = new WeakMap<Model, WeakMap<Schedule, Resource>>()
const modelResourceOf = (held: Model, schedule: Schedule): Resource => {
  let bySchedule = modelResources.get(held)
  if (!bySchedule) { bySchedule = new WeakMap(); modelResources.set(held, bySchedule) }
  let res = bySchedule.get(schedule)
  if (!res) { res = schedule.resource('model'); bySchedule.set(schedule, res) }
  return res
}

/**
 * Two ends of a link in memory, on a schedule, made with `options`: the first dials and the second listens. What
 * this package's own scenarios are run over. Given a model, each end is put under it (with cross-end ending checks
 * attributed to a shared model resource when `tracked: true` so wakeup-tree DPOR remains sound).
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
  const optionsA: Options = linkOptions.later
    ? { ...linkOptions, later: (run) => linkOptions.later!(() => { schedule.write(resA); run() }) }
    : linkOptions
  const optionsB: Options = linkOptions.later
    ? { ...linkOptions, later: (run) => linkOptions.later!(() => { schedule.write(resB); run() }) }
    : linkOptions
  const rawA = dial(left, optionsA)
  const rawB = listen(right, optionsB)
  const modelRes = held ? modelResourceOf(held, schedule) : undefined
  if (modelRes) {
    rawA.onEnd(() => { schedule.write(modelRes) })
    rawB.onEnd(() => { schedule.write(modelRes) })
  }
  const a = trackedLink(rawA, schedule, resA)
  const b = trackedLink(rawB, schedule, resB)
  if (!held || !modelRes) return { a, b }
  const wrapModel = <L extends Link>(link: L, name: string): L => {
    const modeled = held.end(link, name)
    return { ...modeled, close: (bye) => { schedule.write(modelRes); modeled.close(bye) } }
  }
  return { a: wrapModel(a, names[0]), b: wrapModel(b, names[1]) }
}
