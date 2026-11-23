// What a spec of a link is written with, here and anywhere an end of a link is built: a schedule that runs a
// scenario under every order, two ends in memory whose directions are lanes of it, and the scenarios themselves,
// to be run over any pair of ends.
import { link } from '../link.ts'
import { memoryPair, type Transport } from '../transport.ts'
import type { Ends } from './scenarios.ts'
import type { Schedule } from './schedule.ts'

export { carried } from './carried.ts'
export { holds, same } from './check.ts'
export { asking, desk, watching, type Asked, type Asking, type Desk, type Viewed, type Watching } from './desk.ts'
export { droppingMemoryEnds, type Dropping } from './dropping.ts'
export { hold, peers, resume, withoutTheHold, type DroppingScenario, type Ends, type KitScenario } from './scenarios.ts'
export { made, type Made } from './views.ts'

export { everyOrder, explore, replay, sample, type Explored, type Lane, type Scenario, type Schedule } from './schedule.ts'

/** What a pair of ends is made over: given a schedule, two links. */
export type MakeEnds = (schedule: Schedule) => Ends

/**
 * Two ends in memory on a schedule: each direction is a lane of its own, so what crosses one way keeps its order
 * and the schedule chooses between the two, and whatever else a spec adds.
 */
export function scheduledPair(schedule: Schedule, names: readonly [string, string] = ['a', 'b']): [Transport, Transport] {
  const there = { label: `${names[0]} to ${names[1]}` }
  const back = { label: `${names[1]} to ${names[0]}` }
  return memoryPair((run) => schedule.later(there, run), (run) => schedule.later(back, run))
}

/** Two ends of a link in memory, on a schedule: what this package's own scenarios are run over. */
export function memoryEnds(schedule: Schedule): Ends {
  const [left, right] = scheduledPair(schedule)
  return { a: link(left), b: link(right) }
}
