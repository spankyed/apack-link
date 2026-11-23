// What a spec of a link is written with, here and anywhere an end of a link is built: a schedule that runs a
// scenario under every order, and two ends in memory whose directions are lanes of it.
import { memoryPair, type Transport } from '../transport.ts'
import type { Schedule } from './schedule.ts'

export { everyOrder, explore, replay, sample, type Explored, type Lane, type Scenario, type Schedule } from './schedule.ts'

/**
 * Two ends in memory on a schedule: each direction is a lane of its own, so what crosses one way keeps its order
 * and the schedule chooses between the two, and whatever else a spec adds.
 */
export function scheduledPair(schedule: Schedule, names: readonly [string, string] = ['a', 'b']): [Transport, Transport] {
  const there = { label: `${names[0]} to ${names[1]}` }
  const back = { label: `${names[1]} to ${names[0]}` }
  return memoryPair((run) => schedule.later(there, run), (run) => schedule.later(back, run))
}
