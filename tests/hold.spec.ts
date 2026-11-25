// The hold's scenarios are run with the others in scenarios.spec.ts. Here they are shown able to fail: with views
// that offer no `caughtUp`, there is an order in which each does.
import { describe, expect, it } from 'vitest'
import { explore } from '@apackdev/orderings'
import { memoryEnds, withoutTheHold } from '../src/testing/index.ts'

describe('without the hold', () => {
  for (const scenario of withoutTheHold) {
    it(`there is an order in which it fails: ${scenario.name}`, async () => {
      const explored = await explore((schedule) => scenario.play(schedule, memoryEnds(schedule)))
      expect(String(explored.failure?.error)).toMatch(/before its views showed it/)
    })
  }
})
