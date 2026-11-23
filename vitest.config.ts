import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    // A spec run under every order takes as long as there are orders, and longer on a machine running every file at
    // once: a minute is for one that never comes to rest, not for one that is slow.
    testTimeout: 60_000,
  },
})
