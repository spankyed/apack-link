/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  packageManager: 'npm',
  testRunner: 'vitest',
  vitest: {
    configFile: 'vitest.stryker.config.ts',
    related: true,
    dir: '.',
  },
  // Exclude browser tests from mutation runs (Node suite covers core/peer/frames/codec directly).
  ignorePatterns: ['dist', 'tests/browser', 'scripts'],
  checkers: [],
  mutate: [
    'src/core.ts',
    'src/peer.ts',
    'src/frames.ts',
    'src/codec.ts',
  ],
  reporters: ['progress', 'clear-text'],
  coverageAnalysis: 'perTest',
  concurrency: 4,
  timeoutMS: 30_000,
}
