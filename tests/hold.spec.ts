import { describe, expect, it } from 'vitest'
import { everyOrder, explore, hold, memoryEnds, withoutTheHold } from '../src/testing/index.ts'

describe('the hold, over memory', () => {
  for (const scenario of hold) {
    it(scenario.name, async () => {
      expect(await everyOrder((schedule) => scenario.play(schedule, memoryEnds(schedule)))).toBeGreaterThan(0)
    })
  }
})

describe('without the hold', () => {
  for (const scenario of withoutTheHold) {
    it(`there is an order in which it fails: ${scenario.name}`, async () => {
      const explored = await explore((schedule) => scenario.play(schedule, memoryEnds(schedule)))
      expect(String(explored.failure?.error)).toMatch(/before its views showed it/)
    })
  }
})
