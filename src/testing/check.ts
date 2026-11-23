// What a scenario says must hold, with nothing borrowed from a test runner: the scenarios are run by whoever
// builds an end of a link, under whatever runs their specs.

const kindOf = (value: unknown): string => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value)

const alike = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true
  if (kindOf(a) !== kindOf(b) || typeof a !== 'object' || a === null || b === null) return false
  const [mine, theirs] = [Object.keys(a), Object.keys(b as object)]
  return mine.length === theirs.length && mine.every((key) => key in (b as object) && alike((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
}

const shownAs = (value: unknown): string => {
  try { return JSON.stringify(value, (_, inner: unknown) => (typeof inner === 'bigint' ? `${inner}n` : inner === undefined ? '(undefined)' : inner)) ?? String(value) } catch { return String(value) }
}

/** Throws unless the two are the same all the way down. `what` says what was being looked at. */
export function same(actual: unknown, expected: unknown, what: string): void {
  if (!alike(actual, expected)) throw new Error(`${what}: expected ${shownAs(expected)}, got ${shownAs(actual)}`)
}

/** Throws unless it holds. */
export function holds(held: boolean, what: string): void {
  if (!held) throw new Error(`Does not hold: ${what}`)
}
