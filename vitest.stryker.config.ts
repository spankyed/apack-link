import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    // Exclude browser suite and slow real-carrier integration matrix (`scenarios.spec.ts`) so Stryker
    // stays fast while retaining full unit, DPOR, state-space, and fuzz coverage of core/peer/frames/codec.
    exclude: ['tests/browser/**', 'tests/scenarios.spec.ts'],
    testTimeout: 60_000,
  },
})
