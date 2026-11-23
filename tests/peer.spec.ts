import { describe, expect, it } from 'vitest'
import { everyOrder, memoryEnds, peers } from '../src/testing/index.ts'

describe('peers, over memory', () => {
  for (const scenario of peers) {
    it(scenario.name, async () => {
      const orderings = await everyOrder((schedule) => scenario.play(schedule, memoryEnds(schedule)))
      expect(orderings).toBeGreaterThan(0)
    })
  }
})
